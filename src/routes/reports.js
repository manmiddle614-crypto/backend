import express from 'express';
import mongoose from 'mongoose';
import { MealTransaction } from '../models/MealTransaction.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { successResponse } from '../utils/response.js';

const router = express.Router();

/**
 * GET /api/reports/dashboard
 * Dashboard statistics
 */
router.get('/dashboard', requireAuth, asyncHandler(async (req, res) => {
  const messId = new mongoose.Types.ObjectId(req.messId);

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);

  // Today's meals by type
  const todayMeals = await MealTransaction.aggregate([
    {
      $match: {
        messId: messId,
        timestamp: { $gte: today, $lt: tomorrow },
        status: 'success'
      }
    },
    {
      $group: {
        _id: '$mealType',
        count: { $sum: 1 }
      }
    }
  ]);

  const mealBreakdown = {
    breakfast: 0,
    lunch: 0,
    dinner: 0,
    total: 0
  };

  todayMeals.forEach(meal => {
    mealBreakdown[meal._id] = meal.count;
    mealBreakdown.total += meal.count;
  });

  // Active customers
  const activeCustomers = await Customer.countDocuments({
    messId: messId,
    active: true
  });

  // Active subscriptions
  const now = new Date();
  const activeSubscriptions = await Subscription.countDocuments({
    messId: messId,
    active: true,
    endDate: { $gte: now },
    mealsRemaining: { $gt: 0 }
  });

  // Today's revenue from Payment model
  const todayPaymentRevenue = await Payment.aggregate([
    {
      $match: {
        messId: messId,
        createdAt: { $gte: today, $lt: tomorrow },
        status: 'completed'
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' }
      }
    }
  ]);

  // Today's revenue from Customer ledger
  const todayLedgerRevenue = await Customer.aggregate([
    { $match: { messId: messId } },
    { $unwind: '$ledger' },
    { $match: { 'ledger.createdAt': { $gte: today, $lt: tomorrow } } },
    { $group: { _id: null, total: { $sum: '$ledger.amount' } } }
  ]);

  const todayRevenue = (todayPaymentRevenue[0]?.total || 0) + (todayLedgerRevenue[0]?.total || 0);

  // Total revenue from Payment model
  const totalPaymentRevenue = await Payment.aggregate([
    {
      $match: {
        messId: messId,
        status: 'completed'
      }
    },
    {
      $group: {
        _id: null,
        total: { $sum: '$amount' }
      }
    }
  ]);

  // Total revenue from Customer ledger
  const totalLedgerRevenue = await Customer.aggregate([
    { $match: { messId: messId } },
    { $unwind: '$ledger' },
    { $group: { _id: null, total: { $sum: '$ledger.amount' } } }
  ]);

  const totalRevenue = (totalPaymentRevenue[0]?.total || 0) + (totalLedgerRevenue[0]?.total || 0);

  const response = {
    todayMeals: mealBreakdown.total,
    mealBreakdown,
    activeCustomers,
    activeSubscriptions,
    todayRevenue,
    totalRevenue
  };

  res.json(successResponse(response));
}));

export default router;
