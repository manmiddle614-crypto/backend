import express from 'express';
import { Plan } from '../models/Plan.js';
import { Subscription } from '../models/Subscription.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /plans
 * List all plans with optional filtering
 */
const listPlansHandler = asyncHandler(async (req, res) => {
  const { active, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;
  
  const filter = { messId: req.messId };
  if (active !== undefined) {
    filter.active = active === 'true';
  }
  
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };
  
  const plans = await Plan.find(filter).sort(sort);
  
  res.json(successResponse({ plans }, 'Plans retrieved successfully'));
});

/**
 * POST /plans
 * Create new meal plan
 */
const createPlanHandler = asyncHandler(async (req, res) => {
  const { 
    name, 
    description, 
    price, 
    durationDays,
    duration,
    mealCount,
    mealAllocations,
    features = [],
    active = true
  } = req.body;

  // Accept either durationDays or duration
  const finalDuration = durationDays || duration;
  
  // Accept either mealCount or calculate from mealAllocations
  let totalMeals = mealCount;
  
  if (!name || price === undefined || price === null || !finalDuration) {
    throw new ApiError('Name, price, and duration are required', 400, 'VALIDATION_ERROR');
  }

  // If mealAllocations provided, calculate total
  if (mealAllocations && typeof mealAllocations === 'object') {
    totalMeals = Object.values(mealAllocations).reduce((sum, val) => sum + (parseInt(val) || 0), 0);
  }

  // If no mealAllocations and no mealCount, error
  if (!totalMeals || totalMeals === 0) {
    throw new ApiError('Meal count or meal allocations required', 400, 'VALIDATION_ERROR');
  }

  if (parseFloat(price) < 0 || parseInt(finalDuration) <= 0) {
    throw new ApiError('Price and duration must be positive', 400, 'VALIDATION_ERROR');
  }

  const planData = {
    messId: req.messId,
    name: name.trim(),
    description: description?.trim(),
    mealCount: parseInt(totalMeals),
    price: parseFloat(price),
    durationDays: parseInt(finalDuration),
    features,
    active
  };

  // Add mealAllocations if provided
  if (mealAllocations) {
    planData.mealAllocations = {
      breakfast: parseInt(mealAllocations.breakfast) || 0,
      lunch: parseInt(mealAllocations.lunch) || 0,
      dinner: parseInt(mealAllocations.dinner) || 0,
      snack: parseInt(mealAllocations.snack) || 0
    };
  }

  const plan = await Plan.create(planData);

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'plan_created',
    userId: req.user.sub || req.user.id,
    targetId: plan._id,
    targetType: 'Plan',
    details: {
      planName: plan.name,
      mealAllocations: plan.mealAllocations,
      totalMeals: plan.mealCount,
      price: plan.price,
      durationDays: plan.durationDays
    },
    ipAddress: req.ip
  });

  res.status(201).json(successResponse(plan, 'Plan created successfully'));
});

/**
 * GET /plans/:id
 * Get plan details
 */
const getPlanHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const plan = await Plan.findOne({ _id: id, messId: req.messId });
  if (!plan) {
    throw new ApiError('Plan not found', 404, 'NOT_FOUND');
  }

  // Get subscription count for this plan
  const subscriptionCount = await Subscription.countDocuments({ 
    messId: req.messId,
    planId: id, 
    active: true 
  });

  res.json(successResponse({
    ...plan.toJSON(),
    subscriptionCount
  }, 'Plan details retrieved'));
});

/**
 * PUT /plans/:id
 * Update plan
 */
const updatePlanHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { 
    name, 
    description, 
    price, 
    durationDays,
    mealAllocations,
    features,
    active
  } = req.body;

  const plan = await Plan.findOne({ _id: id, messId: req.messId });
  if (!plan) {
    throw new ApiError('Plan not found', 404, 'NOT_FOUND');
  }

  // Store original values for audit
  const originalValues = {
    name: plan.name,
    mealAllocations: plan.mealAllocations,
    price: plan.price,
    durationDays: plan.durationDays,
    active: plan.active
  };

  // Update fields
  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (description !== undefined) updates.description = description?.trim();
  if (price !== undefined) updates.price = parseFloat(price);
  if (durationDays !== undefined) updates.durationDays = parseInt(durationDays);
  if (features !== undefined) updates.features = features;
  if (active !== undefined) updates.active = active;
  
  if (mealAllocations !== undefined) {
    const totalMeals = Object.values(mealAllocations).reduce((sum, val) => sum + (val || 0), 0);
    if (totalMeals === 0) {
      throw new ApiError('At least one meal type must have allocation > 0', 400, 'VALIDATION_ERROR');
    }
    updates.mealAllocations = {
      breakfast: parseInt(mealAllocations.breakfast) || 0,
      lunch: parseInt(mealAllocations.lunch) || 0,
      dinner: parseInt(mealAllocations.dinner) || 0,
      snack: parseInt(mealAllocations.snack) || 0
    };
    updates.mealCount = totalMeals;
  }

  // Validate updates
  if (updates.price !== undefined && updates.price < 0) {
    throw new ApiError('Price cannot be negative', 400, 'VALIDATION_ERROR');
  }
  if (updates.durationDays !== undefined && updates.durationDays <= 0) {
    throw new ApiError('Duration must be positive', 400, 'VALIDATION_ERROR');
  }

  const updatedPlan = await Plan.findByIdAndUpdate(
    id,
    updates,
    { new: true, runValidators: true }
  );

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'plan_updated',
    userId: req.user.sub || req.user.id,
    targetId: plan._id,
    targetType: 'Plan',
    details: {
      updates,
      originalValues
    },
    ipAddress: req.ip
  });

  res.json(successResponse(updatedPlan, 'Plan updated successfully'));
});

/**
 * DELETE /plans/:id
 * Soft delete plan (deactivate)
 */
const deletePlanHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const plan = await Plan.findOne({ _id: id, messId: req.messId });
  if (!plan) {
    throw new ApiError('Plan not found', 404, 'NOT_FOUND');
  }

  // Check if plan has active subscriptions
  const activeSubscriptions = await Subscription.countDocuments({
    messId: req.messId,
    planId: id,
    active: true,
    endDate: { $gte: new Date() }
  });

  if (activeSubscriptions > 0) {
    throw new ApiError(
      `Cannot delete plan with ${activeSubscriptions} active subscriptions`, 
      409, 
      'PLAN_IN_USE'
    );
  }

  // Deactivate plan
  plan.active = false;
  await plan.save();

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'plan_deleted',
    userId: req.user.sub || req.user.id,
    targetId: plan._id,
    targetType: 'Plan',
    details: {
      planName: plan.name,
      mealCount: plan.mealCount,
      price: plan.price
    },
    ipAddress: req.ip
  });

  res.json(successResponse({ id }, 'Plan deactivated successfully'));
});

/**
 * GET /plans/:id/subscriptions
 * Get subscriptions for a specific plan
 */
const getPlanSubscriptionsHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { page = 1, limit = 20, active } = req.query;
  
  const plan = await Plan.findOne({ _id: id, messId: req.messId });
  if (!plan) {
    throw new ApiError('Plan not found', 404, 'NOT_FOUND');
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);
  
  const filter = { messId: req.messId, planId: id };
  if (active !== undefined) {
    filter.active = active === 'true';
  }

  const subscriptions = await Subscription.find(filter)
    .populate('customerId', 'name phone roomNo')
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit));

  const total = await Subscription.countDocuments(filter);

  res.json(successResponse({
    plan,
    subscriptions,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  }, 'Plan subscriptions retrieved'));
});

// Apply role-based access control
router.use(requireRole(['admin', 'manager']));

// Routes
router.get('/', listPlansHandler);
router.post('/', createPlanHandler);
router.get('/:id', getPlanHandler);
router.put('/:id', updatePlanHandler);
router.delete('/:id', deletePlanHandler);
router.get('/:id/subscriptions', getPlanSubscriptionsHandler);

export default router;