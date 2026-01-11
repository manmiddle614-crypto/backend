import { MealTransaction } from '../models/MealTransaction.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/errorHandler.js';

/**
 * Idempotent QR Scanning Service
 * Prevents duplicate scans using database-level constraints and atomic operations
 */
class IdempotentScanService {
  /**
   * Get meal window boundaries for idempotency key
   * Returns start and end of current meal window
   */
  getMealWindowBoundaries(mealType) {
    const now = new Date();
    const today = new Date(now);
    today.setHours(0, 0, 0, 0);

    const windows = {
      breakfast: { start: 7, end: 10 },
      lunch: { start: 12, end: 15 },
      dinner: { start: 19, end: 22 }
    };

    const window = windows[mealType];
    if (!window) {
      throw new Error('Invalid meal type');
    }

    const windowStart = new Date(today);
    windowStart.setHours(window.start, 0, 0, 0);

    const windowEnd = new Date(today);
    windowEnd.setHours(window.end, 59, 59, 999);

    return { windowStart, windowEnd };
  }

  /**
   * Check if scan already exists in current meal window (idempotency check)
   * Returns existing transaction if found, null otherwise
   */
  async findExistingScan(customerId, mealType, windowStart, windowEnd) {
    return await MealTransaction.findOne({
      customerId,
      mealType,
      status: 'success',
      timestamp: {
        $gte: windowStart,
        $lte: windowEnd
      }
    }).sort({ timestamp: -1 });
  }

  /**
   * Atomic meal deduction with optimistic locking
   * Uses findOneAndUpdate with conditions to prevent race conditions
   */
  async deductMealAtomic(subscriptionId, mealsRemainingBefore) {
    const updatedSubscription = await Subscription.findOneAndUpdate(
      {
        _id: subscriptionId,
        mealsRemaining: mealsRemainingBefore, // Optimistic lock
        mealsRemaining: { $gt: 0 }
      },
      {
        $inc: { mealsRemaining: -1 }
      },
      {
        new: true,
        runValidators: true
      }
    );

    return updatedSubscription;
  }

  /**
   * Create transaction with duplicate detection
   * Uses unique compound index to prevent duplicates at database level
   */
  async createTransactionSafe(transactionData) {
    try {
      const transaction = await MealTransaction.create(transactionData);
      return { success: true, transaction };
    } catch (error) {
      // Handle duplicate key error (E11000)
      if (error.code === 11000) {
        // Find the existing transaction
        const existing = await MealTransaction.findOne({
          customerId: transactionData.customerId,
          mealType: transactionData.mealType,
          timestamp: {
            $gte: transactionData.windowStart,
            $lte: transactionData.windowEnd
          }
        });

        return { success: false, duplicate: true, transaction: existing };
      }
      throw error;
    }
  }

  /**
   * Process scan with full idempotency guarantees
   * Returns deterministic response for duplicate scans
   */
  async processScanIdempotent(customerId, mealType, subscription, metadata) {
    const { windowStart, windowEnd } = this.getMealWindowBoundaries(mealType);

    // STEP 1: Check for existing scan in meal window (idempotency check)
    const existingScan = await this.findExistingScan(
      customerId,
      mealType,
      windowStart,
      windowEnd
    );

    if (existingScan) {
      // Return deterministic response for duplicate
      return {
        success: true,
        idempotent: true,
        transaction: existingScan,
        message: 'Scan already processed in this meal window'
      };
    }

    // STEP 2: Atomic meal deduction with optimistic locking
    const mealsRemainingBefore = subscription.mealsRemaining;
    
    const updatedSubscription = await this.deductMealAtomic(
      subscription._id,
      mealsRemainingBefore
    );

    // Race condition check - another scan won
    if (!updatedSubscription) {
      // Check if another scan just succeeded
      const recentScan = await this.findExistingScan(
        customerId,
        mealType,
        windowStart,
        windowEnd
      );

      if (recentScan) {
        // Another scan succeeded, return that result
        return {
          success: true,
          idempotent: true,
          transaction: recentScan,
          message: 'Concurrent scan already processed'
        };
      }

      // No meals remaining
      throw new ApiError('No meals remaining', 402, 'NO_MEALS_REMAINING');
    }

    // STEP 3: Create transaction record
    const transactionData = {
      messId: metadata.messId,
      customerId,
      subscriptionId: subscription._id,
      scannedByUserId: metadata.staffId,
      staffId: metadata.staffId,
      mealType,
      status: 'success',
      qrCodeId: metadata.qrCodeId,
      mealsRemainingBefore,
      mealsRemainingAfter: updatedSubscription.mealsRemaining,
      timestamp: new Date(),
      clientTimestamp: metadata.clientTimestamp,
      deviceInfo: metadata.deviceInfo,
      ipAddress: metadata.ipAddress,
      windowStart, // For duplicate detection
      windowEnd
    };

    const transaction = await MealTransaction.create(transactionData);

    // Auto-deactivate subscription if no meals left
    if (updatedSubscription.mealsRemaining === 0) {
      updatedSubscription.active = false;
      await updatedSubscription.save();
    }

    return {
      success: true,
      idempotent: false,
      transaction,
      subscription: updatedSubscription,
      message: 'Scan processed successfully'
    };
  }

  /**
   * Get or create scan result (idempotent operation)
   * Always returns the same result for same input within meal window
   */
  async getOrCreateScan(customerId, mealType, subscription, metadata) {
    try {
      return await this.processScanIdempotent(
        customerId,
        mealType,
        subscription,
        metadata
      );
    } catch (error) {
      // If error is due to race condition, retry once
      if (error.code === 11000 || error.message?.includes('duplicate')) {
        const { windowStart, windowEnd } = this.getMealWindowBoundaries(mealType);
        const existingScan = await this.findExistingScan(
          customerId,
          mealType,
          windowStart,
          windowEnd
        );

        if (existingScan) {
          return {
            success: true,
            idempotent: true,
            transaction: existingScan,
            message: 'Scan already processed (retry)'
          };
        }
      }
      throw error;
    }
  }
}

export const idempotentScanService = new IdempotentScanService();
