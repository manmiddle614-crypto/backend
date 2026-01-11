import express from 'express';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { Customer } from '../models/Customer.js';
import { Plan } from '../models/Plan.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * POST /
 * Admin: Process subscription renewal with payment
 */
router.post('/', requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const { customerId, planId, amount, paymentMethod, notes } = req.body;

  if (!customerId || !planId || !amount || !paymentMethod) {
    throw new ApiError('Missing required fields', 400, 'VALIDATION_ERROR');
  }

  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  const plan = await Plan.findById(planId);
  if (!plan) {
    throw new ApiError('Plan not found', 404, 'NOT_FOUND');
  }

  // Find active subscription or create new one
  let subscription = await Subscription.findOne({ 
    customerId, 
    messId: req.messId,
    active: true 
  });
  
  if (subscription) {
    // Renew existing subscription

    // Add meals to balances
    if (plan.mealAllocations) {
      if (!subscription.mealBalances) {
        subscription.mealBalances = {
          breakfast: 0,
          lunch: 0,
          dinner: 0,
          snack: 0
        };
      }
      subscription.mealBalances.breakfast = (subscription.mealBalances.breakfast || 0) + (plan.mealAllocations.breakfast || 0);
      subscription.mealBalances.lunch = (subscription.mealBalances.lunch || 0) + (plan.mealAllocations.lunch || 0);
      subscription.mealBalances.dinner = (subscription.mealBalances.dinner || 0) + (plan.mealAllocations.dinner || 0);
      subscription.mealBalances.snack = (subscription.mealBalances.snack || 0) + (plan.mealAllocations.snack || 0);

    }
    
    subscription.mealsRemaining = (subscription.mealsRemaining || 0) + plan.mealCount;
    subscription.mealsTotal = (subscription.mealsTotal || 0) + plan.mealCount;
    subscription.endDate = new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000);
    subscription.markModified('mealBalances');
    await subscription.save();

  } else {
    // Create new subscription

    const mealBalances = plan.mealAllocations ? {
      breakfast: plan.mealAllocations.breakfast || 0,
      lunch: plan.mealAllocations.lunch || 0,
      dinner: plan.mealAllocations.dinner || 0,
      snack: plan.mealAllocations.snack || 0
    } : {
      breakfast: Math.floor(plan.mealCount / 3),
      lunch: Math.floor(plan.mealCount / 3),
      dinner: Math.floor(plan.mealCount / 3),
      snack: 0
    };

    subscription = await Subscription.create({
      messId: req.messId,
      customerId,
      planId,
      startDate: new Date(),
      endDate: new Date(Date.now() + plan.durationDays * 24 * 60 * 60 * 1000),
      mealsRemaining: plan.mealCount,
      mealsTotal: plan.mealCount,
      mealBalances: mealBalances,
      paidAmount: amount,
      paymentStatus: amount >= plan.price ? 'paid' : 'partial',
      active: true
    });

  }

  // Record payment (skip if Payment model is for SaaS billing only)
  // TODO: Create separate CustomerPayment model if needed

  // Balance = Plan Price - Amount Paid (debt if positive, credit if negative)
  const balanceChange = Number(plan.price) - Number(amount);

  customer.balance = (customer.balance || 0) + balanceChange;

  customer.lastPaymentAt = new Date();
  if (paymentMethod && paymentMethod !== 'NONE') {
    customer.preferredPaymentMethod = paymentMethod.toUpperCase();
  }
  
  const savedCustomer = await customer.save();

  // Verify save by re-fetching
  const verifyCustomer = await Customer.findById(customer._id);

  // Audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_renewed',
    userId: req.user.sub || req.user.id,
    targetId: subscription._id,
    targetType: 'Subscription',
    details: {
      customerId,
      planId,
      amount,
      paymentMethod,
      mealsAdded: plan.mealCount,
      newTotal: subscription.mealsRemaining
    },
    ipAddress: req.ip
  });

  res.json(successResponse({
    subscription,
    mealsAdded: plan.mealCount,
    totalMealsRemaining: subscription.mealsRemaining,
    mealBalances: subscription.mealBalances,
    customerBalance: customer.balance,
    amountPaid: amount,
    planPrice: plan.price,
    balanceChange: Number(plan.price) - Number(amount)
  }, 'Subscription renewed successfully'));
}));

/**
 * GET /customer/:customerId
 * Get renewal history for a customer
 */
router.get('/customer/:customerId', requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const { customerId } = req.params;

  const payments = await Payment.find({ customerId })
    .populate('subscriptionId')
    .populate('processedBy', 'name email')
    .sort({ createdAt: -1 })
    .limit(20);

  res.json(successResponse({ payments }, 'Renewal history retrieved'));
}));

export default router;
