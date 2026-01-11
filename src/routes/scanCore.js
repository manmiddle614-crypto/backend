/**
 * Core Production Scan Endpoint
 * POST /api/scan
 *
 * Features:
 * - Atomic mealsRemaining decrement (no race conditions)
 * - Duplicate scan detection within configurable window
 * - Full audit logging
 * - Comprehensive error responses
 */

import express from 'express';
import { verifyQrToken } from '../utils/qr.js';
import { getSettings } from '../utils/settingsCache.js';
import { determineMealType } from '../utils/mealTypeHelper.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';

const router = express.Router();

/**
 * POST /api/scan
 * Single QR scan processing
 */
router.post(
  '/scan',
  asyncHandler(async (req, res, next) => {
    const { qrToken } = req.body;
    const HMAC_SECRET = process.env.QR_HMAC_SECRET || process.env.JWT_SECRET;

    logger.info('[SCAN] Scan request received', { 
      hasQrToken: !!qrToken, 
      qrTokenLength: qrToken?.length,
      qrTokenPreview: qrToken?.substring(0, 20),
      messId: req.messId,
      userId: req.user?.id 
    });

    if (!qrToken) {
      logger.error('[SCAN] Missing QR token');
      throw new ApiError('QR token required', 400, 'MISSING_QR_TOKEN');
    }

    if (!HMAC_SECRET) {
      throw new ApiError('Server misconfigured', 500, 'SERVER_ERROR');
    }

    try {
      const settings = await getSettings();
      let qrCodeId;

      logger.info('[SCAN] Processing QR token', { 
        tokenFormat: qrToken.includes('.') ? 'signed' : 'plain',
        tokenLength: qrToken.length 
      });

      // Check if token contains a dot (signed format) or is plain UUID
      if (qrToken.includes('.')) {
        logger.info('[SCAN] Verifying signed QR token');
        const verified = verifyQrToken(qrToken, HMAC_SECRET);
        if (!verified.valid) {
          logger.error('[SCAN] Invalid QR signature', { verified });
          throw new ApiError('Invalid QR code signature', 403, 'INVALID_QR_SIGNATURE');
        }
        qrCodeId = verified.payload?.qrCodeId;
        logger.info('[SCAN] QR token verified', { qrCodeId });
      } else {
        // Plain UUID format (legacy or simple QR codes)
        qrCodeId = qrToken;
        logger.info('[SCAN] Using plain UUID format', { qrCodeId });
      }

      if (!qrCodeId) {
        logger.error('[SCAN] Invalid QR payload - no qrCodeId extracted');
        throw new ApiError('Invalid QR payload', 400, 'INVALID_QR_PAYLOAD');
      }

      // 1. Find customer
      logger.info('[SCAN] Looking up customer', { qrCodeId, messId: req.messId });
      const customer = await Customer.findOne({ 
        qrCodeId, 
        active: true,
        messId: req.messId
      })
        .select('_id name roomNo phone messId')
        .lean();
        
      if (!customer) {
        logger.warn('[SCAN] Customer not found', { qrCodeId, messId: req.messId });
        return res.status(403).json({
          success: false,
          status: 'blocked',
          reason: 'invalid_qr',
          message: 'QR code does not belong to this mess or customer not found',
        });
      }

      logger.info('[SCAN] Customer found', { 
        customerId: customer._id, 
        customerName: customer.name,
        roomNo: customer.roomNo 
      });

      // 2. Find active subscription
      const today = new Date();
      today.setHours(0, 0, 0, 0);

      logger.info('[SCAN] Looking up subscription', { customerId: customer._id, messId: req.messId });
      const subscription = await Subscription.findOne({
        customerId: customer._id,
        messId: req.messId,
        active: true,
        startDate: { $lte: today },
        endDate: { $gte: today },
      })
      .select('_id customerId mealsRemaining mealBalances startDate endDate active')
      .sort({ updatedAt: -1 });

      if (!subscription) {
        logger.warn('[SCAN] No active subscription found', { customerId: customer._id });
        return res.status(410).json({
          success: false,
          status: 'blocked',
          reason: 'no_active_subscription',
          message: 'No active subscription with remaining meals',
        });
      }

      logger.info('[SCAN] Subscription found', { 
        subscriptionId: subscription._id,
        mealsRemaining: subscription.mealsRemaining,
        mealBalances: subscription.mealBalances 
      });

      // 3. Determine meal type (default to lunch if outside window)
      let mealType = determineMealType(settings) || 'lunch';
      logger.info('[SCAN] Meal type determined', { mealType, currentTime: new Date().toISOString() });

      // 🚨 CRITICAL: MEAL-TYPE BALANCE CHECK (SECURITY)
      if (subscription.mealBalances) {
        // New system: Check specific meal type balance
        if (!subscription.mealBalances.hasOwnProperty(mealType)) {
          await logAudit('scan_blocked', req.user?.id, {
            reason: 'meal_type_not_in_plan',
            mealType,
            customerId: customer._id,
          }).catch(() => {});
          return res.status(403).json({
            success: false,
            status: 'blocked',
            reason: 'meal_type_not_allowed',
            message: `${mealType} is not included in your plan`,
          });
        }
        
        if (subscription.mealBalances[mealType] <= 0) {
          await logAudit('scan_blocked', req.user?.id, {
            reason: `no_${mealType}_remaining`,
            mealType,
            balance: subscription.mealBalances[mealType],
            customerId: customer._id,
          }).catch(() => {});
          return res.status(410).json({
            success: false,
            status: 'blocked',
            reason: `no_${mealType}_remaining`,
            message: `No ${mealType} meals remaining in your plan`,
          });
        }
      } else {
        // Legacy system: Check total meals
        if (subscription.mealsRemaining <= 0) {
          await logAudit('scan_blocked', req.user?.id, {
            reason: 'no_meals_remaining',
            customerId: customer._id,
          }).catch(() => {});
          return res.status(410).json({
            success: false,
            status: 'blocked',
            reason: 'no_meals_remaining',
            message: 'No meals remaining',
          });
        }
      }

      // 4. Duplicate scan check - per customer per meal type per day
      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      
      logger.info('[SCAN] Checking for duplicate scans', { 
        customerId: customer._id, 
        mealType,
        todayStart,
        todayEnd 
      });

      const lastScan = await MealTransaction.findOne({
        customerId: customer._id,
        mealType,
        timestamp: { $gte: todayStart, $lte: todayEnd },
        status: 'success',
      })
      .select('_id timestamp')
      .sort({ timestamp: -1 })
      .lean();

      if (lastScan) {
        logger.warn('[SCAN] Duplicate scan detected', { 
          customerId: customer._id, 
          mealType,
          lastScanTime: lastScan.timestamp 
        });
        await logAudit('scan_blocked', req.user?.id, {
          reason: 'duplicate_scan',
          subscriptionId: subscription._id,
          customerId: customer._id,
          mealType,
        }).catch(() => {});
        return res.status(409).json({
          success: false,
          status: 'blocked',
          reason: 'duplicate_scan',
          message: `Already scanned for ${mealType} today`,
        });
      }

      // 5. 🚨 ATOMIC DECREMENT - MEAL-TYPE SPECIFIC (RACE-CONDITION SAFE)
      const updateQuery = subscription.mealBalances ? 
        { $inc: { [`mealBalances.${mealType}`]: -1, mealsRemaining: -1 } } : 
        { $inc: { mealsRemaining: -1 } };
      
      const checkQuery = subscription.mealBalances ? 
        { [`mealBalances.${mealType}`]: { $gt: 0 }, mealsRemaining: { $gt: 0 } } : 
        { mealsRemaining: { $gt: 0 } };

      logger.info('[SCAN] Attempting atomic decrement', { 
        subscriptionId: subscription._id,
        updateQuery,
        checkQuery 
      });

      const updatedSubscription = await Subscription.findOneAndUpdate(
        {
          _id: subscription._id,
          messId: req.messId,
          active: true,
          ...checkQuery
        },
        updateQuery,
        { new: true }
      );

      if (!updatedSubscription) {
        logger.error('[SCAN] Atomic decrement failed - no meals remaining', { 
          subscriptionId: subscription._id,
          mealType 
        });
        return res.status(410).json({
          success: false,
          status: 'failed',
          reason: `no_${mealType}_remaining`,
          message: `No ${mealType} meals remaining`,
        });
      }

      logger.info('[SCAN] Subscription updated successfully', { 
        subscriptionId: updatedSubscription._id,
        newMealsRemaining: updatedSubscription.mealsRemaining,
        newMealBalances: updatedSubscription.mealBalances 
      });

      // 6. Create meal transaction record
      const mealTransaction = new MealTransaction({
        messId: req.messId,
        subscriptionId: subscription._id,
        customerId: customer._id,
        scannedByUserId: req.user?.id || req.user?.sub,
        staffId: req.user?.id || req.user?.sub,
        qrCodeId: qrCodeId,
        mealType,
        status: 'success',
        timestamp: new Date(),
        mealsRemainingBefore: subscription.mealsRemaining,
        mealsRemainingAfter: updatedSubscription.mealsRemaining || (subscription.mealsRemaining - 1)
      });
      await mealTransaction.save();

      // 7. Log audit entry
      await logAudit('scan_success', req.user?.id, {
        customerId: customer._id,
        subscriptionId: subscription._id,
        mealType,
        mealsRemaining: updatedSubscription.mealsRemaining,
      }).catch(() => {});

      // 8. Create notification for admin/staff
      try {
        const { createNotification } = await import('../services/notificationService.js');
        await createNotification({
          messId: req.messId,
          userId: null,
          title: 'Meal Scanned',
          message: `${customer.name} (Room ${customer.roomNo}) scanned ${mealType}`,
          type: 'scan',
          priority: 'LOW',
          strict: false,
          expiresInHours: 24
        });
      } catch (err) {}

      // 9. Get updated customer meals remaining
      const updatedCustomer = await Customer.findById(customer._id).select('mealsRemaining').lean();
      const mealsRemaining = updatedCustomer?.mealsRemaining || 0;
      const mealBalance = updatedSubscription.mealBalances ? 
        updatedSubscription.mealBalances[mealType] : 
        updatedSubscription.mealsRemaining;

      // 9. Determine if alert threshold reached
      const alert = mealsRemaining <= (settings?.alertThresholdMealsRemaining || 5);

      // 10. Emit socket event to admin/staff
      const io = req.app.get('io');
      if (io) {
        io.to(`mess_${req.messId}`).emit('meal_scanned', {
          customerName: customer.name,
          roomNo: customer.roomNo,
          mealType,
          mealsRemaining,
          timestamp: new Date().toISOString()
        });
      }

      // 11. Return success response
      logger.info('[SCAN] Scan completed successfully', { 
        customerName: customer.name,
        roomNo: customer.roomNo,
        mealType,
        mealsRemaining,
        mealBalance 
      });

      res.json(
        successResponse({
          status: 'success',
          customerName: customer.name,
          roomNo: customer.roomNo,
          mealsRemaining,
          mealBalance,
          mealType,
          subscriptionId: subscription._id,
          alert,
          timestamp: new Date().toISOString(),
        }),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;

      logger.error('[SCAN] Scan processing error', { 
        error: err.message, 
        stack: err.stack,
        qrToken: req.body.qrToken?.substring(0, 20) 
      });
      await logAudit('scan_error', req.user?.id, { error: err.message, stack: err.stack }).catch(() => {});
      throw new ApiError(`Scan processing failed: ${err.message}`, 500, 'SCAN_ERROR');
    }
  }),
);

/**
 * Helper: Log audit entry (fire-and-forget)
 */
async function logAudit(action, userId, details = {}) {
  try {
    await AuditLog.create({
      messId: details.messId,
      action,
      actorId: userId || null,
      actorType: userId ? 'user' : 'system',
      details,
      timestamp: new Date(),
    });
  } catch (err) {
    // Silent fail for audit logs
  }
}

export default router;
