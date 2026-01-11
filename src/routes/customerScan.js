import express from 'express';
import jwt from 'jsonwebtoken';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { AuditLog } from '../models/AuditLog.js';
import { requireAuth } from '../middleware/auth.js';
import { determineMealType } from '../utils/determineMealType.js';
import logger from '../utils/logger.js';

const router = express.Router();

// POST /api/customer/scan-mess-qr
router.post('/scan-mess-qr', requireAuth, async (req, res) => {
  const session = await Customer.startSession();
  session.startTransaction();

  try {
    logger.info('[CUSTOMER_SCAN] Customer scan initiated', { 
      userId: req.user.id,
      userRole: req.user.role,
      messId: req.user.messId 
    });

    // 1. Verify customer JWT (already done by requireAuth)
    if (req.user.role !== 'customer') {
      logger.error('[CUSTOMER_SCAN] Non-customer attempted scan', { 
        userId: req.user.id,
        role: req.user.role 
      });
      throw new Error('Customer access only');
    }

    const { qrToken, mealType: requestedMealType } = req.body;

    logger.info('[CUSTOMER_SCAN] QR token received', { 
      hasQrToken: !!qrToken,
      qrTokenLength: qrToken?.length,
      qrTokenPreview: qrToken?.substring(0, 20),
      requestedMealType 
    });

    if (!qrToken) {
      logger.error('[CUSTOMER_SCAN] Missing QR token');
      throw new Error('QR token required');
    }

    // 2. Verify qrToken JWT
    let qrPayload;
    try {
      logger.info('[CUSTOMER_SCAN] Verifying QR token JWT');
      qrPayload = jwt.verify(qrToken, process.env.JWT_SECRET);
      logger.info('[CUSTOMER_SCAN] QR token verified', { 
        qrPayloadType: qrPayload.type,
        qrPayloadMessId: qrPayload.messId 
      });
    } catch (err) {
      logger.error('[CUSTOMER_SCAN] QR token verification failed', { error: err.message });
      throw new Error('Invalid QR token');
    }

    // 3. Ensure qrToken.type === 'MESS_QR'
    if (qrPayload.type !== 'MESS_QR') {
      logger.error('[CUSTOMER_SCAN] Invalid QR type', { 
        expectedType: 'MESS_QR',
        actualType: qrPayload.type 
      });
      throw new Error('Invalid QR type');
    }

    // Get customer to find messId
    console.log('[DEBUG] ========== CUSTOMER SCAN DEBUG START ==========');
    console.log('[DEBUG] req.user:', JSON.stringify(req.user, null, 2));
    console.log('[DEBUG] Fetching customer with ID:', req.user.id || req.user.sub);
    
    const customerId = req.user.id || req.user.sub;
    if (!customerId) {
      throw new Error('Customer ID not found in token');
    }
    
    const customer = await Customer.findById(customerId).session(session);
    console.log('[DEBUG] Customer query result:', {
      found: !!customer,
      id: customer?._id?.toString(),
      name: customer?.name,
      messId: customer?.messId?.toString(),
      messIdExists: !!customer?.messId,
      messIdType: typeof customer?.messId
    });
    
    if (!customer) {
      throw new Error('Customer not found in database');
    }

    if (!customer.messId) {
      console.log('[DEBUG] Customer has no messId - this is the problem!');
      throw new Error('Customer not associated with any mess. Please contact admin.');
    }

    const customerMessId = customer.messId;
    console.log('[DEBUG] customerMessId extracted:', {
      value: customerMessId?.toString(),
      type: typeof customerMessId,
      isObjectId: customerMessId?.constructor?.name
    });
    
    console.log('[DEBUG] QR Payload:', {
      messId: qrPayload.messId,
      type: qrPayload.type,
      fullPayload: JSON.stringify(qrPayload, null, 2)
    });

    // 4. Ensure qrToken.messId === customer.messId
    const qrMessIdStr = String(qrPayload.messId);
    const customerMessIdStr = customerMessId.toString();
    
    console.log('[DEBUG] String comparison:', {
      qrMessId: qrMessIdStr,
      customerMessId: customerMessIdStr,
      match: qrMessIdStr === customerMessIdStr,
      qrLength: qrMessIdStr.length,
      customerLength: customerMessIdStr.length
    });
    console.log('[DEBUG] ========== CUSTOMER SCAN DEBUG END ==========');
    
    if (qrMessIdStr !== customerMessIdStr) {
      logger.error('[CUSTOMER_SCAN] Mess ID mismatch', { 
        qrMessId: qrMessIdStr,
        customerMessId: customerMessIdStr 
      });
      await AuditLog.create({
        messId: customerMessId,
        userId: customerId,
        action: 'SCAN_WRONG_MESS',
        details: { attemptedMessId: qrMessIdStr }
      });
      throw new Error('QR code belongs to different mess');
    }

    logger.info('[CUSTOMER_SCAN] Mess ID validated successfully');

    // 5. Fetch active subscription
    logger.info('[CUSTOMER_SCAN] Looking up subscription', { customerId });
    const subscription = await Subscription.findOne({
      customerId: customerId,
      active: true,
      endDate: { $gte: new Date() }
    }).session(session);

    if (!subscription) {
      logger.warn('[CUSTOMER_SCAN] No active subscription found', { customerId: req.user.id });
      throw new Error('No active subscription');
    }

    logger.info('[CUSTOMER_SCAN] Subscription found', { 
      subscriptionId: subscription._id,
      mealsRemaining: subscription.mealsRemaining,
      mealBalances: subscription.mealBalances 
    });

    // 6. Determine mealType
    const mealType = requestedMealType || determineMealType();

    logger.info('[CUSTOMER_SCAN] Meal type determined', { 
      mealType,
      wasRequested: !!requestedMealType 
    });

    if (!mealType) {
      logger.error('[CUSTOMER_SCAN] Could not determine meal type');
      throw new Error('Could not determine meal type');
    }

    // 7. Validate mealType is allowed
    if (!['breakfast', 'lunch', 'dinner'].includes(mealType)) {
      throw new Error('Invalid meal type');
    }

    // 8. Check meal balance
    const balance = subscription.mealBalances?.[mealType] || 0;
    logger.info('[CUSTOMER_SCAN] Checking meal balance', { 
      mealType,
      balance,
      hasMealBalances: !!subscription.mealBalances 
    });

    if (balance <= 0) {
      logger.warn('[CUSTOMER_SCAN] No meals remaining', { mealType, balance });
      throw new Error(`No ${mealType} meals remaining`);
    }

    // Check duplicate scan (within 15 minutes for same meal type)
    logger.info('[CUSTOMER_SCAN] Checking for duplicate scans');
    const recentScan = await MealTransaction.findOne({
      customerId: req.user.id,
      mealType,
      status: 'SUCCESS',
      timestamp: { $gte: new Date(Date.now() - 15 * 60 * 1000) }
    }).session(session);

    if (recentScan) {
      const timeLeft = Math.ceil((15 * 60 * 1000 - (Date.now() - recentScan.timestamp)) / 60000);
      logger.warn('[CUSTOMER_SCAN] Duplicate scan detected', { 
        lastScanTime: recentScan.timestamp,
        timeLeft 
      });
      throw new Error(`Already scanned ${mealType}. Try again in ${timeLeft} minutes.`);
    }

    // Check if scanning outside meal hours
    const now = new Date();
    const hour = now.getHours();
    const mealHours = {
      breakfast: { start: 6, end: 10 },
      lunch: { start: 11, end: 15 },
      dinner: { start: 18, end: 22 }
    };
    
    const allowedHours = mealHours[mealType];
    if (allowedHours && (hour < allowedHours.start || hour >= allowedHours.end)) {
      logger.warn('[CUSTOMER_SCAN] Scan outside meal hours', { mealType, hour });
      throw new Error(`${mealType.charAt(0).toUpperCase() + mealType.slice(1)} is only available from ${allowedHours.start}:00 to ${allowedHours.end}:00`);
    }

    // 9. ATOMIC update - Decrement meal balance with validation
    const updateKey = `mealBalances.${mealType}`;
    logger.info('[CUSTOMER_SCAN] Attempting atomic decrement', { 
      subscriptionId: subscription._id,
      updateKey,
      currentBalance: balance
    });

    const updated = await Subscription.findOneAndUpdate(
      {
        _id: subscription._id,
        [updateKey]: { $gt: 0 }, // Ensure balance > 0
        active: true
      },
      {
        $inc: {
          [updateKey]: -1,
          mealsRemaining: -1
        }
      },
      { new: true, session }
    );

    if (!updated) {
      logger.error('[CUSTOMER_SCAN] Failed to update subscription');
      throw new Error('Failed to update subscription');
    }

    logger.info('[CUSTOMER_SCAN] Subscription updated successfully', { 
      newMealsRemaining: updated.mealsRemaining,
      newMealBalance: updated.mealBalances[mealType] 
    });

    // 10. Create MealTransaction
    const transaction = await MealTransaction.create([{
      messId: customerMessId,
      customerId: req.user.id,
      subscriptionId: subscription._id,
      mealType,
      status: 'SUCCESS',
      timestamp: new Date(),
      scanType: 'CUSTOMER_INITIATED'
    }], { session });

    await session.commitTransaction();

    logger.info('[CUSTOMER_SCAN] Customer scan completed successfully', { 
      customerId: req.user.id,
      customerName: customer.name,
      mealType,
      remainingBalance: updated.mealBalances[mealType] 
    });

    // 11. Emit real-time socket event to admin
    const io = req.app.get('io');
    if (io) {
      io.to(`mess_${customerMessId}`).emit('meal_deducted', {
        customerName: customer.name,
        mealType,
        time: new Date().toISOString(),
        customerId: req.user.id,
        roomNo: customer.roomNo,
        remainingBalance: updated.mealBalances[mealType]
      });
    }

    // 12. Return success response
    res.json({
      success: true,
      data: {
        mealType,
        remainingBalance: updated.mealBalances[mealType],
        totalRemaining: updated.mealsRemaining,
        timestamp: transaction[0].timestamp,
        customerName: customer.name,
        roomNo: customer.roomNo
      },
      message: `${mealType.charAt(0).toUpperCase() + mealType.slice(1)} meal deducted successfully`
    });

  } catch (error) {
    await session.abortTransaction();

    logger.error('[CUSTOMER_SCAN] Scan failed', { 
      error: error.message,
      stack: error.stack,
      userId: req.user?.id 
    });

    // Log failed scan
    try {
      const customerMessId = req.user?.messId || (await Customer.findById(req.user?.id).select('messId'))?.messId;
      await AuditLog.create({
        messId: customerMessId,
        userId: req.user?.id,
        action: 'SCAN_FAILED',
        details: { error: error.message, qrToken: req.body.qrToken?.substring(0, 20) }
      });
    } catch (logError) {

    }

    res.status(400).json({
      success: false,
      error: { message: error.message, code: 'SCAN_FAILED' }
    });
  } finally {
    session.endSession();
  }
});

export default router;
