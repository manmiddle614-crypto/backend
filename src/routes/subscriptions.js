import express from 'express';
import { Subscription } from '../models/Subscription.js';
import { Customer } from '../models/Customer.js';
import { Plan } from '../models/Plan.js';
import { Payment } from '../models/Payment.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /subscriptions
 * List subscriptions with filtering and pagination
 */
const listSubscriptionsHandler = asyncHandler(async (req, res) => {
  const { 
    page = 1, 
    limit = 20, 
    customerId, 
    planId, 
    active, 
    status,
    sortBy = 'createdAt', 
    sortOrder = 'desc' 
  } = req.query;

  const pageNum = Math.max(parseInt(page), 1);
  const limitNum = Math.min(parseInt(limit), 100);
  const skip = (pageNum - 1) * limitNum;
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  // Build filter with messId isolation
  const filter = { messId: req.messId };
  if (customerId) filter.customerId = customerId;
  if (planId) filter.planId = planId;
  if (active !== undefined) filter.active = active === 'true';
  if (status) {
    // Filter by computed status
    const now = new Date();
    switch (status) {
      case 'active':
        filter.active = true;
        filter.endDate = { $gte: now };
        filter.mealsRemaining = { $gt: 0 };
        filter.paymentStatus = 'paid';
        break;
      case 'expired':
        filter.endDate = { $lt: now };
        break;
      case 'exhausted':
        filter.mealsRemaining = { $lte: 0 };
        break;
    }
  }

  const subscriptions = await Subscription.find(filter)
    .select('customerId planId mealsTotal mealsRemaining mealBalances startDate endDate active paymentStatus paidAmount pausedAt createdAt')
    .populate('customerId', 'name phone roomNo')
    .populate('planId', 'name mealCount price durationDays')
    .sort(sort)
    .skip(skip)
    .limit(limitNum)
    .lean();

  const total = await Subscription.countDocuments(filter);

  res.json(successResponse({
    subscriptions,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum)
    }
  }, 'Subscriptions retrieved successfully'));
});

/**
 * POST /subscriptions
 * Create new subscription
 */
const createSubscriptionHandler = asyncHandler(async (req, res) => {
  const { 
    customerId, 
    planId, 
    startDate = new Date(),
    paidAmount,
    paymentMethod = 'cash',
    notes
  } = req.body;

  if (!customerId || !planId) {
    throw new ApiError('Customer ID and Plan ID are required', 400, 'VALIDATION_ERROR');
  }

  // Verify customer exists and is active
  const customer = await Customer.findOne({ _id: customerId, messId: req.messId });
  if (!customer || !customer.active) {
    throw new ApiError('Customer not found or inactive', 404, 'CUSTOMER_NOT_FOUND');
  }

  // Verify plan exists and is active
  const plan = await Plan.findOne({ _id: planId, messId: req.messId });
  if (!plan || !plan.active) {
    throw new ApiError('Plan not found or inactive', 404, 'PLAN_NOT_FOUND');
  }

  // Check for existing active subscription
  const existingSubscription = await Subscription.findOne({
    messId: req.messId,
    customerId,
    active: true,
    endDate: { $gte: new Date() },
    mealsRemaining: { $gt: 0 }
  })
  .select('_id')
  .lean();

  if (existingSubscription) {
    throw new ApiError('Customer already has an active subscription', 409, 'ACTIVE_SUBSCRIPTION_EXISTS');
  }

  // Calculate end date
  const subscriptionStartDate = new Date(startDate);
  const endDate = new Date(subscriptionStartDate);
  endDate.setDate(endDate.getDate() + plan.durationDays);

  // Copy mealAllocations to mealBalances (NEW SYSTEM)
  const mealBalances = plan.mealAllocations ? {
    breakfast: plan.mealAllocations.breakfast || 0,
    lunch: plan.mealAllocations.lunch || 0,
    dinner: plan.mealAllocations.dinner || 0,
    snack: plan.mealAllocations.snack || 0
  } : null;

  const totalMeals = mealBalances ? 
    Object.values(mealBalances).reduce((sum, val) => sum + val, 0) : 
    plan.mealCount;

  // Create subscription
  const subscription = await Subscription.create({
    messId: req.messId,
    customerId,
    planId,
    mealsTotal: totalMeals,
    mealsRemaining: totalMeals,
    mealBalances: mealBalances || undefined,
    startDate: subscriptionStartDate,
    endDate,
    paidAmount: paidAmount || plan.price,
    paymentStatus: paidAmount >= plan.price ? 'paid' : 'partial',
    active: true,
    notes
  });

  // Create payment record if amount provided
  if (paidAmount && paidAmount > 0) {
    await Payment.create({
      messId: req.messId,
      customerId,
      subscriptionId: subscription._id,
      amount: paidAmount,
      paymentMethod,
      status: 'completed',
      description: `Subscription payment for ${plan.name}`,
      processedBy: req.user.sub || req.user.id,
      processedAt: new Date()
    });
  }

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_created',
    userId: req.user.sub || req.user.id,
    targetId: subscription._id,
    targetType: 'Subscription',
    details: {
      customerName: customer.name,
      planName: plan.name,
      mealsTotal: plan.mealCount,
      paidAmount: paidAmount || 0,
      startDate: subscriptionStartDate,
      endDate
    },
    ipAddress: req.ip
  });

  // Populate and return
  const populatedSubscription = await Subscription.findById(subscription._id)
    .select('customerId planId mealsTotal mealsRemaining startDate endDate active paymentStatus paidAmount notes createdAt')
    .populate('customerId', 'name phone roomNo')
    .populate('planId', 'name mealCount price durationDays')
    .lean();

  res.status(201).json(successResponse(populatedSubscription, 'Subscription created successfully'));
});

/**
 * GET /subscriptions/:id
 * Get subscription details
 */
const getSubscriptionHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const subscription = await Subscription.findOne({ _id: id, messId: req.messId })
    .select('customerId planId mealsTotal mealsRemaining startDate endDate active paymentStatus paidAmount pausedAt notes createdAt')
    .populate('customerId', 'name phone roomNo')
    .populate('planId', 'name mealCount price durationDays')
    .lean();

  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  // Get payment history
  const payments = await Payment.find({ subscriptionId: id, messId: req.messId })
    .select('amount paymentMethod status description processedBy processedAt createdAt')
    .populate('processedBy', 'name')
    .sort({ createdAt: -1 })
    .lean();

  // Get recent meal transactions
  const { MealTransaction } = await import('../models/MealTransaction.js');
  const recentTransactions = await MealTransaction.find({ subscriptionId: id, messId: req.messId })
    .select('mealType timestamp scannedByUserId location')
    .populate('scannedByUserId', 'name')
    .sort({ timestamp: -1 })
    .limit(20)
    .lean();

  res.json(successResponse({
    subscription,
    payments,
    recentTransactions
  }, 'Subscription details retrieved'));
});

/**
 * PUT /subscriptions/:id
 * Update subscription
 */
const updateSubscriptionHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { active, notes, pausedAt } = req.body;

  const subscription = await Subscription.findOne({ _id: id, messId: req.messId });
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  const originalValues = {
    active: subscription.active,
    pausedAt: subscription.pausedAt,
    notes: subscription.notes
  };

  // Update fields
  const updates = {};
  if (active !== undefined) updates.active = active;
  if (notes !== undefined) updates.notes = notes;
  if (pausedAt !== undefined) {
    updates.pausedAt = pausedAt ? new Date(pausedAt) : null;
  }

  const updatedSubscription = await Subscription.findByIdAndUpdate(
    id,
    updates,
    { new: true, runValidators: true }
  )
  .select('customerId planId mealsTotal mealsRemaining startDate endDate active paymentStatus paidAmount pausedAt notes createdAt')
  .populate('customerId', 'name phone roomNo')
  .populate('planId', 'name mealCount price durationDays')
  .lean();

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_updated',
    userId: req.user.sub || req.user.id,
    targetId: subscription._id,
    targetType: 'Subscription',
    details: {
      updates,
      originalValues
    },
    ipAddress: req.ip
  });

  res.json(successResponse(updatedSubscription, 'Subscription updated successfully'));
});

/**
 * POST /subscriptions/:id/topup
 * Add meals to existing subscription
 */
const topupSubscriptionHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { mealsCount, paidAmount, paymentMethod = 'cash', notes } = req.body;

  if (!mealsCount || mealsCount <= 0) {
    throw new ApiError('Meals count must be positive', 400, 'VALIDATION_ERROR');
  }

  const subscription = await Subscription.findOne({ _id: id, messId: req.messId })
    .select('customerId planId mealsTotal mealsRemaining startDate endDate active paymentStatus paidAmount notes')
    .populate('customerId', 'name')
    .populate('planId', 'name price mealCount');

  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  // Calculate price per meal from original plan
  const pricePerMeal = subscription.planId.price / subscription.planId.mealCount;
  const expectedAmount = mealsCount * pricePerMeal;

  // Update subscription
  subscription.mealsTotal += parseInt(mealsCount);
  subscription.mealsRemaining += parseInt(mealsCount);
  
  // Reactivate if was inactive due to no meals
  if (subscription.mealsRemaining > 0 && new Date(subscription.endDate) > new Date()) {
    subscription.active = true;
  }
  
  if (notes) {
    subscription.notes = subscription.notes ? 
      `${subscription.notes}\n${notes}` : notes;
  }

  await subscription.save();

  // Create payment record if amount provided
  if (paidAmount && paidAmount > 0) {
    await Payment.create({
      messId: req.messId,
      customerId: subscription.customerId._id,
      subscriptionId: subscription._id,
      amount: paidAmount,
      paymentMethod,
      status: 'completed',
      description: `Top-up: ${mealsCount} meals`,
      processedBy: req.user.sub || req.user.id,
      processedAt: new Date()
    });
  }

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_topup',
    userId: req.user.sub || req.user.id,
    targetId: subscription._id,
    targetType: 'Subscription',
    details: {
      customerName: subscription.customerId.name,
      mealsAdded: mealsCount,
      paidAmount: paidAmount || 0,
      expectedAmount,
      newMealsTotal: subscription.mealsTotal,
      newMealsRemaining: subscription.mealsRemaining
    },
    ipAddress: req.ip
  });

  res.json(successResponse({
    subscription,
    mealsAdded: mealsCount,
    paidAmount: paidAmount || 0,
    expectedAmount
  }, 'Subscription topped up successfully'));
});

/**
 * POST /subscriptions/:id/pause
 * Pause subscription
 */
const pauseSubscriptionHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { reason } = req.body;

  const subscription = await Subscription.findOne({ _id: id, messId: req.messId });
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  if (subscription.pausedAt) {
    throw new ApiError('Subscription is already paused', 409, 'ALREADY_PAUSED');
  }

  subscription.pausedAt = new Date();
  if (reason) {
    subscription.notes = subscription.notes ? 
      `${subscription.notes}\nPaused: ${reason}` : `Paused: ${reason}`;
  }
  await subscription.save();

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_paused',
    userId: req.user.sub || req.user.id,
    targetId: subscription._id,
    targetType: 'Subscription',
    details: { reason },
    ipAddress: req.ip
  });

  res.json(successResponse(subscription, 'Subscription paused successfully'));
});

/**
 * POST /subscriptions/:id/resume
 * Resume paused subscription
 */
const resumeSubscriptionHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const subscription = await Subscription.findOne({ _id: id, messId: req.messId });
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  if (!subscription.pausedAt) {
    throw new ApiError('Subscription is not paused', 409, 'NOT_PAUSED');
  }

  // Calculate paused days and extend end date
  const pausedDays = Math.ceil((new Date() - subscription.pausedAt) / (1000 * 60 * 60 * 24));
  subscription.endDate.setDate(subscription.endDate.getDate() + pausedDays);
  subscription.pausedDays = (subscription.pausedDays || 0) + pausedDays;
  subscription.pausedAt = null;
  
  await subscription.save();

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_resumed',
    userId: req.user.sub || req.user.id,
    targetId: subscription._id,
    targetType: 'Subscription',
    details: { 
      pausedDays,
      newEndDate: subscription.endDate
    },
    ipAddress: req.ip
  });

  res.json(successResponse(subscription, 'Subscription resumed successfully'));
});

// Apply role-based access control
router.use(requireRole(['admin', 'manager']));

// Routes
router.get('/', listSubscriptionsHandler);
router.post('/', createSubscriptionHandler);
router.get('/:id', getSubscriptionHandler);
router.put('/:id', updateSubscriptionHandler);
router.post('/:id/topup', topupSubscriptionHandler);
router.post('/:id/pause', pauseSubscriptionHandler);
router.post('/:id/resume', resumeSubscriptionHandler);

export default router;