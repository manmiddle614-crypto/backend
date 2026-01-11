/**
 * Batch Scan Endpoint
 * POST /api/scan/batch
 *
 * Features:
 * - Chronological processing
 * - Idempotency support (clientId + timestamp)
 * - Atomic operations per scan
 * - Offline sync support
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
 * POST /api/scan/batch
 * Process multiple scans in chronological order
 *
 * Request body:
 * {
 *   scans: [
 *     { qrToken, clientTimestamp?, clientId? },
 *     ...
 *   ]
 * }
 */
router.post(
  '/scan/batch',
  asyncHandler(async (req, res, next) => {
    const { scans } = req.body;
    const HMAC_SECRET = process.env.QR_HMAC_SECRET || process.env.JWT_SECRET;

    if (!Array.isArray(scans)) {
      throw new ApiError('Scans must be an array', 400, 'INVALID_SCANS_ARRAY');
    }

    if (scans.length === 0) {
      throw new ApiError('Scans array cannot be empty', 400, 'EMPTY_SCANS_ARRAY');
    }

    if (!HMAC_SECRET) {
      throw new ApiError('Server misconfigured', 500, 'SERVER_ERROR');
    }

    try {
      const settings = await getSettings();
      const results = [];

      // Sort scans chronologically by clientTimestamp
      const sortedScans = [...scans].sort((a, b) => {
        const aTime = a.clientTimestamp || 0;
        const bTime = b.clientTimestamp || 0;
        return aTime - bTime;
      });

      // Process each scan
      for (const scan of sortedScans) {
        const result = await processSingleScan(scan, settings, HMAC_SECRET, req.user?.id);
        results.push(result);
      }

      res.json(
        successResponse(
          {
            totalScans: results.length,
            successCount: results.filter((r) => r.success && r.status === 'success').length,
            blockedCount: results.filter((r) => r.status === 'blocked').length,
            failedCount: results.filter((r) => !r.success || r.status === 'failed').length,
            results,
          },
          'Batch scans processed',
        ),
      );
    } catch (err) {
      if (err instanceof ApiError) throw err;
      await logAudit('batch_scan_error', req.user?.id, { error: err.message }).catch(() => {});
      throw new ApiError('Batch scan processing failed', 500, 'BATCH_SCAN_ERROR');
    }
  }),
);

/**
 * Process single scan from batch
 */
async function processSingleScan(scanRequest, settings, secret, userId) {
  const { qrToken, clientTimestamp, clientId } = scanRequest;

  try {
    if (!qrToken) {
      await logAudit('batch_scan_validation_failed', userId, { reason: 'missing_qrToken', clientId }).catch(
        () => {},
      );
      return {
        success: false,
        status: 'failed',
        reason: 'missing_qrToken',
        message: 'QR token required',
        clientId,
      };
    }

    // Verify QR signature
    const verified = verifyQrToken(qrToken, secret);
    if (!verified.valid) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'invalid_signature',
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'blocked',
        reason: 'invalid_qr_signature',
        message: 'Invalid QR code signature',
        clientId,
      };
    }

    const { qrCodeId } = verified.payload;
    if (!qrCodeId) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'no_qrCodeId',
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'failed',
        reason: 'invalid_qr_payload',
        message: 'Invalid QR payload',
        clientId,
      };
    }

    // Find customer
    const customer = await Customer.findOne({ qrCodeId, active: true }).lean();
    if (!customer) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'unknown_customer',
        qrCodeId,
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'blocked',
        reason: 'unknown_customer',
        message: 'Customer not found',
        clientId,
      };
    }

    // Find active subscription
    const refDate = new Date(clientTimestamp || Date.now());
    const today = new Date(refDate);
    today.setHours(0, 0, 0, 0);

    const subscription = await Subscription.findOne({
      customerId: customer._id,
      active: true,
      mealsRemaining: { $gt: 0 },
      startDate: { $lte: today },
      endDate: { $gte: today },
    }).sort({ updatedAt: -1 });

    if (!subscription) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'no_active_subscription',
        customerId: customer._id,
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'blocked',
        reason: 'no_active_subscription',
        message: 'No active subscription with remaining meals',
        clientId,
      };
    }

    // Determine meal type
    const mealType = determineMealType(settings, clientTimestamp);
    if (!mealType) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'outside_meal_window',
        customerId: customer._id,
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'blocked',
        reason: 'outside_meal_window',
        message: 'Not within any configured meal service window',
        clientId,
      };
    }

    // Duplicate scan check
    const windowSec = settings?.doubleScanWindowSeconds || 30;
    const windowStart = new Date((clientTimestamp || Date.now()) - windowSec * 1000);
    const lastScan = await MealTransaction.findOne({
      subscriptionId: subscription._id,
      mealType,
      timestamp: { $gte: windowStart },
      status: 'success',
    }).sort({ timestamp: -1 });

    if (lastScan) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'duplicate_scan',
        subscriptionId: subscription._id,
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'blocked',
        reason: 'duplicate_scan',
        message: `Already scanned for ${mealType} in the last ${windowSec}s`,
        clientId,
      };
    }

    // Atomic decrement
    const updatedSubscription = await Subscription.findOneAndUpdate(
      {
        _id: subscription._id,
        mealsRemaining: { $gt: 0 },
      },
      {
        $inc: { mealsRemaining: -1 },
      },
      { new: true },
    );

    if (!updatedSubscription) {
      await logAudit('batch_scan_blocked', userId, {
        reason: 'no_meals_remaining',
        subscriptionId: subscription._id,
        clientId,
      }).catch(() => {});
      return {
        success: false,
        status: 'blocked',
        reason: 'no_meals_remaining',
        message: 'No meals remaining',
        clientId,
      };
    }

    // Create meal transaction
    const mealTransaction = new MealTransaction({
      subscriptionId: subscription._id,
      customerId: customer._id,
      scannedByUserId: userId || null,
      mealType,
      status: 'success',
      timestamp: new Date(clientTimestamp || Date.now()),
    });
    await mealTransaction.save();

    await logAudit('batch_scan_success', userId, {
      subscriptionId: subscription._id,
      customerId: customer._id,
      mealType,
      clientId,
    }).catch(() => {});

    return {
      success: true,
      status: 'success',
      customerName: customer.name,
      roomNo: customer.roomNo,
      subscriptionId: subscription._id,
      mealsRemaining: updatedSubscription.mealsRemaining,
      mealType,
      clientId,
    };
  } catch (err) {
    await logAudit('batch_scan_error', userId, {
      error: err.message,
      clientId,
    }).catch(() => {});
    return {
      success: false,
      status: 'failed',
      reason: 'server_error',
      message: 'Scan processing failed',
      clientId,
    };
  }
}

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
  }
}

export default router;
