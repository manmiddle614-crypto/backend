import express from 'express';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { resolveTenant, tenantQuery } from '../middleware/tenant.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /api/customer/dashboard
 * Get customer dashboard data
 */
router.get('/customer/dashboard', requireAuth, resolveTenant, asyncHandler(async (req, res) => {
  const customerId = req.user.sub || req.user.id;

  const customer = await Customer.findOne(tenantQuery(req, { _id: customerId }))
    .select('name phone roomNo joinedAt balance preferredPaymentMethod')
    .lean();
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Get active subscription
  const subscription = await Subscription.findOne(tenantQuery(req, { 
    customerId, 
    status: 'active' 
  }))
  .select('planId mealsRemaining mealsTotal startDate endDate status paidAmount')
  .populate('planId', 'name')
  .lean();

  // Get all payments
  const payments = await Payment.find(tenantQuery(req, { customerId }))
    .select('amount paymentMethod createdAt status')
    .sort({ createdAt: -1 })
    .limit(10)
    .lean();

  // Calculate totals
  const totalPaid = await Payment.aggregate([
    { $match: { messId: req.messId, customerId: customer._id, status: 'completed' } },
    { $group: { _id: null, total: { $sum: '$amount' } } }
  ]);

  // Get meal transactions
  const mealTransactions = await MealTransaction.find(tenantQuery(req, { 
    customerId,
    status: 'success'
  }))
    .select('mealType timestamp status')
    .sort({ timestamp: -1 })
    .limit(20)
    .lean();

  const mealsConsumed = mealTransactions.length;
  const mealsRemaining = subscription?.mealsRemaining || 0;
  const totalMeals = subscription?.mealsTotal || 0;

  // Calculate balance (if subscription exists)
  const amountPaid = totalPaid[0]?.total || 0;
  const subscriptionValue = subscription?.paidAmount || 0;
  const balance = amountPaid - subscriptionValue;

  // Group payments by method
  const paymentsByMethod = await Payment.aggregate([
    { $match: { messId: req.messId, customerId: customer._id, status: 'completed' } },
    { $group: { 
      _id: '$paymentMethod', 
      total: { $sum: '$amount' },
      count: { $sum: 1 }
    }}
  ]);

  const dashboardData = {
    customer: {
      name: customer.name,
      phone: customer.phone,
      roomNo: customer.roomNo,
      joinedAt: customer.joinedAt,
      balance: customer.balance || 0,
      preferredPaymentMethod: customer.preferredPaymentMethod || 'NONE'
    },
    subscription: subscription ? {
      planName: subscription.planId?.name,
      mealsRemaining,
      mealsTotal: totalMeals,
      mealsConsumed,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      status: subscription.status
    } : null,
    financial: {
      totalPaid: amountPaid,
      subscriptionValue,
      balance,
      paymentsByMethod: paymentsByMethod.reduce((acc, p) => {
        acc[p._id] = { total: p.total, count: p.count };
        return acc;
      }, {})
    },
    recentPayments: payments.map(p => ({
      amount: p.amount,
      method: p.paymentMethod,
      date: p.createdAt,
      status: p.status
    })),
    recentMeals: mealTransactions.map(m => ({
      mealType: m.mealType,
      timestamp: m.timestamp,
      status: m.status
    }))
  };

  res.json(successResponse(dashboardData, 'Dashboard data retrieved'));
}));

export default router;
