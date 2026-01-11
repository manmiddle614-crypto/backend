import express from 'express';
import { asyncHandler } from '../utils/asyncHandler.js';
import { successResponse } from '../utils/response.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { getSettings } from '../utils/settingsCache.js';
import { determineMealType } from '../utils/mealTypeHelper.js';
import logger from '../utils/logger.js';

const router = express.Router();

// GET /api/scan/recent - Get recent scans
router.get('/recent', asyncHandler(async (req, res) => {
  const { limit = 20 } = req.query;
  
  const transactions = await MealTransaction.find({ messId: req.messId })
    .select('customerId mealType timestamp status failureReason')
    .populate('customerId', 'name phone roomNo')
    .sort({ timestamp: -1 })
    .limit(parseInt(limit))
    .lean();

  res.json(successResponse({ transactions }));
}));

// GET /api/scan/search - Search customers for scanning
router.get('/search', asyncHandler(async (req, res) => {
  const { q } = req.query;
  
  if (!q || q.trim().length < 2) {
    return res.json(successResponse({ customers: [] }));
  }

  const customers = await Customer.find({
    messId: req.messId,
    active: true,
    $or: [
      { name: { $regex: q.trim(), $options: 'i' } },
      { phone: { $regex: q.trim(), $options: 'i' } },
      { roomNo: { $regex: q.trim(), $options: 'i' } }
    ]
  })
  .select('name phone roomNo qrCodeId')
  .limit(10)
  .lean();

  // Get active subscriptions for found customers
  const customerIds = customers.map(c => c._id);
  const subscriptions = await Subscription.find({
    messId: req.messId,
    customerId: { $in: customerIds },
    active: true,
    mealsRemaining: { $gt: 0 }
  })
  .select('customerId mealsRemaining planId')
  .populate('planId', 'name')
  .lean();

  // Map subscriptions to customers
  const subscriptionMap = {};
  subscriptions.forEach(sub => {
    subscriptionMap[sub.customerId.toString()] = sub;
  });

  // Add subscription data to customers
  const customersWithSubscriptions = customers.map(customer => {
    const subscription = subscriptionMap[customer._id.toString()];
    return {
      ...customer,
      subscription: subscription || null,
      hasActiveSubscription: !!subscription,
      mealsRemaining: subscription?.mealsRemaining || 0,
      planName: subscription?.planId?.name || null
    };
  });

  res.json(successResponse({ customers: customersWithSubscriptions }));
}));

// POST /api/scan/manual - Manual scan for customer
router.post('/manual', asyncHandler(async (req, res) => {
  const { customerId } = req.body;
  let { mealType } = req.body;
  
  logger.info('[MANUAL_SCAN] Manual scan initiated', { 
    customerId, 
    mealType,
    userId: req.user?.id,
    messId: req.messId 
  });
  
  if (!customerId) {
    logger.error('[MANUAL_SCAN] Missing customer ID');
    return res.status(400).json({ 
      success: false, 
      error: { message: 'Customer ID required' }
    });
  }

  // AUTO-DETECT meal type from current time if not provided
  if (!mealType) {
    const settings = await getSettings();
    mealType = determineMealType(settings);
    
    logger.info('[MANUAL_SCAN] Auto-detected meal type', { mealType });
    
    // Allow manual override - don't block if outside meal window
    if (!mealType) {
      mealType = 'lunch'; // Default to lunch for manual scans
      logger.info('[MANUAL_SCAN] Using default meal type: lunch');
    }
  }

  // Find customer
  logger.info('[MANUAL_SCAN] Looking up customer', { customerId, messId: req.messId });
  const customer = await Customer.findOne({
    _id: customerId,
    messId: req.messId,
    active: true
  })
  .select('name phone roomNo mealsRemaining')
  .lean();

  if (!customer) {
    logger.warn('[MANUAL_SCAN] Customer not found', { customerId, messId: req.messId });
    return res.status(404).json({ 
      success: false, 
      error: { message: 'Customer not found' }
    });
  }

  logger.info('[MANUAL_SCAN] Customer found', { 
    customerId: customer._id,
    customerName: customer.name 
  });

  // Check for duplicate scan - per meal type per day
  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayEnd = new Date();
  todayEnd.setHours(23, 59, 59, 999);
  
  logger.info('[MANUAL_SCAN] Checking for duplicate scans', { 
    customerId, 
    mealType,
    todayStart,
    todayEnd 
  });

  const recentScan = await MealTransaction.findOne({
    messId: req.messId,
    customerId,
    mealType,
    timestamp: { $gte: todayStart, $lte: todayEnd },
    status: 'success'
  }).lean();

  if (recentScan) {
    logger.warn('[MANUAL_SCAN] Duplicate scan detected', { 
      customerId,
      mealType,
      lastScanTime: recentScan.timestamp 
    });
    return res.status(400).json({ 
      success: false, 
      error: { message: `${customer.name} already scanned for ${mealType} today` }
    });
  }

  // Find active subscription
  logger.info('[MANUAL_SCAN] Looking up subscription', { customerId, messId: req.messId });
  const subscription = await Subscription.findOne({
    messId: req.messId,
    customerId,
    active: true,
    mealsRemaining: { $gt: 0 }
  })
  .select('_id mealsRemaining mealBalances')
  .lean();

  if (!subscription) {
    logger.warn('[MANUAL_SCAN] No active subscription found', { customerId });
    return res.status(400).json({ 
      success: false, 
      error: { message: 'No active subscription with remaining meals' }
    });
  }

  logger.info('[MANUAL_SCAN] Subscription found', { 
    subscriptionId: subscription._id,
    mealsRemaining: subscription.mealsRemaining,
    mealBalances: subscription.mealBalances 
  });

  // Atomic decrement with meal type
  const updateQuery = subscription.mealBalances ? 
    { $inc: { [`mealBalances.${mealType}`]: -1, mealsRemaining: -1 } } : 
    { $inc: { mealsRemaining: -1 } };
    
  const checkQuery = subscription.mealBalances ? 
    { [`mealBalances.${mealType}`]: { $gt: 0 } } : 
    { mealsRemaining: { $gt: 0 } };

  logger.info('[MANUAL_SCAN] Attempting atomic decrement', { 
    subscriptionId: subscription._id,
    updateQuery,
    checkQuery 
  });

  // Update subscription (atomic decrement)
  const updatedSubscription = await Subscription.findOneAndUpdate(
    {
      _id: subscription._id,
      ...checkQuery
    },
    updateQuery,
    { new: true }
  );

  if (!updatedSubscription) {
    logger.error('[MANUAL_SCAN] Atomic decrement failed', { 
      subscriptionId: subscription._id,
      mealType 
    });
    return res.status(400).json({ 
      success: false, 
      error: { message: `No ${mealType} meals remaining` }
    });
  }

  logger.info('[MANUAL_SCAN] Subscription updated successfully', { 
    subscriptionId: updatedSubscription._id,
    newMealsRemaining: updatedSubscription.mealsRemaining,
    newMealBalances: updatedSubscription.mealBalances 
  });

  // Update customer's mealsRemaining
  await Customer.findByIdAndUpdate(
    customerId,
    { $inc: { mealsRemaining: -1 } }
  );

  // Get updated customer meals
  const updatedCustomer = await Customer.findById(customerId)
    .select('mealsRemaining qrCodeId')
    .lean();
  
  const mealsRemaining = updatedCustomer?.mealsRemaining || 0;
  const mealBalance = updatedSubscription.mealBalances ? 
    updatedSubscription.mealBalances[mealType] : 
    updatedSubscription.mealsRemaining;

  // Create meal transaction
  await MealTransaction.create({
    messId: req.messId,
    subscriptionId: subscription._id,
    customerId,
    scannedByUserId: req.user?.id || req.user?.sub,
    staffId: req.user?.id || req.user?.sub,
    qrCodeId: updatedCustomer?.qrCodeId || 'manual-scan',
    mealType,
    status: 'success',
    timestamp: new Date(),
    mealsRemainingBefore: subscription.mealsRemaining,
    mealsRemainingAfter: mealsRemaining,
    scanLocation: 'manual'
  });

  logger.info('[MANUAL_SCAN] Manual scan completed successfully', { 
    customerName: customer.name,
    mealType,
    mealsRemaining,
    mealBalance 
  });

  res.json(successResponse({
    customer: {
      name: customer.name,
      phone: customer.phone
    },
    mealType,
    mealsRemaining,
    mealBalance,
    message: `Meal scanned for ${customer.name}. ${mealBalance} ${mealType} meals remaining.`
  }));
}));

export default router;