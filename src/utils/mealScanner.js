import { qrTokenService } from '../services/qrTokenService.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { Settings } from '../models/Settings.js';
import { AuditLog } from '../models/AuditLog.js';

/**
 * Core meal scanning logic with atomic operations
 */
export class MealScanner {
  constructor() {
    this.settings = null;
  }

  /**
   * Initialize scanner with cached settings
   */
  async initialize() {
    this.settings = await Settings.getCached();
  }

  /**
   * Determine current meal type based on time
   */
  getCurrentMealType() {
    if (!this.settings) {
      throw new Error('Scanner not initialized');
    }

    const now = new Date();
    const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
    const { breakfast, lunch, dinner } = this.settings.mealWindows;

    if (currentTime >= breakfast.start && currentTime <= breakfast.end) {
      return 'breakfast';
    } else if (currentTime >= lunch.start && currentTime <= lunch.end) {
      return 'lunch';
    } else if (currentTime >= dinner.start && currentTime <= dinner.end) {
      return 'dinner';
    }

    return null; // Outside meal windows
  }

  /**
   * Check for duplicate scans within window
   */
  async checkDuplicateScan(customerId, mealType) {
    const windowSeconds = this.settings?.doubleScanWindowSeconds || 30;
    const recentTransaction = await MealTransaction.findRecentTransaction(
      customerId, 
      mealType, 
      windowSeconds
    );

    return recentTransaction;
  }

  /**
   * Process single QR scan
   */
  async processScan(qrToken, scannedByUserId, metadata = {}) {
    try {
      // Initialize if needed
      if (!this.settings) {
        await this.initialize();
      }

      // Step 1: Verify QR token with mess isolation
      let qrPayload;
      try {
        qrPayload = qrTokenService.verifyToken(qrToken, metadata.messId);
      } catch (error) {
        return this.createFailedTransaction(null, null, scannedByUserId, 'invalid_qr', metadata, error.message);
      }

      // Step 2: Find customer
      const customer = await Customer.findOne({ 
        _id: qrPayload.customerId,
        messId: qrPayload.messId,
        active: true 
      });

      if (!customer) {
        return this.createFailedTransaction(null, null, scannedByUserId, 'customer_not_found', metadata);
      }

      // Step 3: Determine meal type
      let mealType = this.getCurrentMealType();
      if (!mealType) {
        if (metadata.adminOverride) {
          mealType = 'lunch'; // Default for admin override
        } else {
          return this.createFailedTransaction(customer._id, null, scannedByUserId, 'invalid_meal_window', metadata);
        }
      }

      // Step 4: Check for duplicate scan within window (30 seconds)
      const duplicateTransaction = await this.checkDuplicateScan(customer._id, mealType);
      if (duplicateTransaction) {
        return this.createFailedTransaction(
          customer._id, 
          null, 
          scannedByUserId, 
          'duplicate_scan', 
          metadata,
          `Last scan: ${duplicateTransaction.timestamp.toISOString()}`,
          duplicateTransaction._id
        );
      }

      // Step 4.5: Check if already scanned for this meal type TODAY (strict validation)
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      const todayTransaction = await MealTransaction.findOne({
        customerId: customer._id,
        mealType,
        status: 'success',
        timestamp: { $gte: today, $lt: tomorrow }
      });

      if (todayTransaction && !metadata.adminOverride) {
        return this.createFailedTransaction(
          customer._id, 
          null, 
          scannedByUserId, 
          'already_scanned_today', 
          metadata,
          `Already scanned ${mealType} today at ${todayTransaction.timestamp.toLocaleTimeString()}`,
          todayTransaction._id
        );
      }

      // Step 5: Find active subscription with plan details
      const subscription = await Subscription.findOne({
        customerId: customer._id,
        active: true,
        endDate: { $gte: new Date() },
        mealsRemaining: { $gt: 0 }
      }).populate('planId');

      

      if (!subscription) {
        return this.createFailedTransaction(customer._id, null, scannedByUserId, 'no_subscription', metadata);
      }

      if (subscription.pausedAt) {
        return this.createFailedTransaction(customer._id, subscription._id, scannedByUserId, 'subscription_paused', metadata);
      }

      if (subscription.mealsRemaining <= 0) {
        return this.createFailedTransaction(customer._id, subscription._id, scannedByUserId, 'no_meals_remaining', metadata);
      }

      // Step 5.5: Check if meal type is allowed in plan (unless admin override)
      if (!metadata.adminOverride && subscription.planId && subscription.planId.mealTypes) {
        if (!subscription.planId.mealTypes.includes(mealType)) {
          return this.createFailedTransaction(
            customer._id, 
            subscription._id, 
            scannedByUserId, 
            'meal_type_not_allowed', 
            metadata,
            `Plan only allows: ${subscription.planId.mealTypes.join(', ')}`
          );
        }
      }

      // Step 6: Atomic meal deduction
      const mealsRemainingBefore = subscription.mealsRemaining;
      const updatedSubscription = await subscription.deductMeal();

      if (!updatedSubscription) {
        // Race condition - another scan happened first
        return this.createFailedTransaction(customer._id, subscription._id, scannedByUserId, 'no_meals_remaining', metadata);
      }

      // Auto-deactivate if no meals remaining
      if (updatedSubscription.mealsRemaining === 0) {
        updatedSubscription.active = false;
        await updatedSubscription.save();
      }

      // Step 7: Create successful transaction
      const transaction = await MealTransaction.create({
        messId: customer.messId,
        customerId: customer._id,
        subscriptionId: subscription._id,
        scannedByUserId,
        staffId: scannedByUserId,
        mealType,
        status: 'success',
        qrCodeId: qrPayload.qrCodeId || customer.qrCodeId,
        mealsRemainingBefore,
        mealsRemainingAfter: updatedSubscription.mealsRemaining,
        clientTimestamp: metadata.clientTimestamp,
        clientId: metadata.clientId,
        deviceInfo: metadata.deviceInfo,
        scanLocation: metadata.scanLocation
      });

      // Step 8: Create audit log
      await AuditLog.create({
        messId: customer.messId,
        action: 'meal_scanned',
        userId: scannedByUserId,
        targetId: customer._id,
        targetType: 'Customer',
        details: {
          mealType,
          mealsRemaining: updatedSubscription.mealsRemaining,
          subscriptionId: subscription._id,
          transactionId: transaction._id
        },
        ipAddress: metadata.ipAddress
      });

      // Step 9: Check for low meals alert
      const alertThreshold = this.settings?.alertThresholdMealsRemaining || 5;
      const shouldAlert = updatedSubscription.mealsRemaining <= alertThreshold && updatedSubscription.mealsRemaining > 0;

      return {
        success: true,
        status: 'success',
        transaction,
        customer: {
          id: customer._id,
          name: customer.name,
          roomNo: customer.roomNo
        },
        subscription: {
          id: updatedSubscription._id,
          mealsRemaining: updatedSubscription.mealsRemaining,
          mealsTotal: updatedSubscription.mealsTotal
        },
        mealType,
        timestamp: transaction.timestamp,
        alert: shouldAlert ? `Low meals remaining: ${updatedSubscription.mealsRemaining}` : null
      };

    } catch (error) {

      // Create audit log for system error
      await AuditLog.create({
        messId: metadata.messId,
        action: 'scan_error',
        userId: scannedByUserId,
        details: {
          error: error.message,
          qrToken: qrToken?.substring(0, 20) + '...',
          metadata
        },
        ipAddress: metadata.ipAddress
      });

      return {
        success: false,
        status: 'failed',
        error: 'System error occurred',
        timestamp: new Date()
      };
    }
  }

  /**
   * Process batch of scans (for offline sync)
   */
  async processBatch(scans, scannedByUserId, metadata = {}) {
    const results = [];
    let successCount = 0;
    let blockedCount = 0;
    let failedCount = 0;

    // Sort by client timestamp to maintain chronological order
    const sortedScans = scans.sort((a, b) => {
      const timeA = a.clientTimestamp ? new Date(a.clientTimestamp) : new Date();
      const timeB = b.clientTimestamp ? new Date(b.clientTimestamp) : new Date();
      return timeA - timeB;
    });

    for (const scan of sortedScans) {
      const scanMetadata = {
        ...metadata,
        clientTimestamp: scan.clientTimestamp,
        clientId: scan.clientId,
        batchProcessing: true
      };

      const result = await this.processScan(scan.qrToken, scannedByUserId, scanMetadata);
      results.push(result);

      if (result.success && result.status === 'success') {
        successCount++;
      } else if (result.status === 'blocked' || result.failureReason === 'duplicate_scan') {
        blockedCount++;
      } else {
        failedCount++;
      }

      // Mark as synced
      if (result.transaction) {
        result.transaction.syncedAt = new Date();
        await result.transaction.save();
      }
    }

    // Create batch audit log
    await AuditLog.create({
      messId: metadata.messId,
      action: 'batch_scan_processed',
      userId: scannedByUserId,
      details: {
        totalScans: scans.length,
        successCount,
        blockedCount,
        failedCount,
        batchId: metadata.batchId
      },
      ipAddress: metadata.ipAddress
    });

    return {
      success: true,
      totalScans: scans.length,
      successCount,
      blockedCount,
      failedCount,
      results
    };
  }

  /**
   * Create failed transaction record
   */
  async createFailedTransaction(customerId, subscriptionId, scannedByUserId, failureReason, metadata, errorMessage = null, duplicateOfTransaction = null) {
    const mealType = this.getCurrentMealType() || 'unknown';
    
    // Only create transaction if we have required fields
    let transaction = null;
    if (customerId && subscriptionId && metadata.messId) {
      transaction = await MealTransaction.create({
        messId: metadata.messId,
        customerId,
        subscriptionId,
        scannedByUserId,
        staffId: scannedByUserId,
        mealType,
        status: failureReason === 'duplicate_scan' ? 'blocked' : 'failed',
        qrCodeId: metadata.qrCodeId || 'unknown',
        mealsRemainingBefore: 0,
        mealsRemainingAfter: 0,
        failureReason,
        duplicateOfTransaction,
        clientTimestamp: metadata.clientTimestamp,
        clientId: metadata.clientId,
        deviceInfo: metadata.deviceInfo,
        scanLocation: metadata.scanLocation,
        notes: errorMessage
      });
    }

    // Create audit log for failed scan
    if (customerId && metadata.messId) {
      await AuditLog.create({
        messId: metadata.messId,
        action: 'scan_failed',
        userId: scannedByUserId,
        targetId: customerId,
        targetType: 'Customer',
        details: {
          failureReason,
          errorMessage,
          transactionId: transaction?._id
        },
        ipAddress: metadata.ipAddress
      });
    }

    return {
      success: false,
      status: failureReason === 'duplicate_scan' ? 'blocked' : 'failed',
      failureReason,
      error: this.getErrorMessage(failureReason),
      transaction,
      timestamp: transaction?.timestamp || new Date()
    };
  }

  /**
   * Get user-friendly error message
   */
  getErrorMessage(failureReason) {
    const messages = {
      'invalid_qr': 'Invalid or expired QR code',
      'customer_not_found': 'Customer not found or inactive',
      'invalid_meal_window': 'Outside meal serving hours',
      'duplicate_scan': 'Meal already scanned recently',
      'already_scanned_today': 'You have already scanned for this meal today',
      'no_subscription': 'No active subscription found',
      'subscription_paused': 'Subscription is currently paused',
      'no_meals_remaining': 'No meals remaining in subscription',
      'subscription_expired': 'Subscription has expired',
      'meal_type_not_allowed': 'This meal type is not included in your plan'
    };

    return messages[failureReason] || 'Scan failed';
  }
}

// Export singleton instance
export const mealScanner = new MealScanner();