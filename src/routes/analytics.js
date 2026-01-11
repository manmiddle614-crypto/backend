import express from 'express';
import mongoose from 'mongoose';
import { MealTransaction } from '../models/MealTransaction.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import Attendance from '../models/Attendance.js';

const router = express.Router();

// Get analytics data with date range
router.get('/overview', async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const messId = new mongoose.Types.ObjectId(req.messId);

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    // Meal consumption by type
    const mealsByType = await MealTransaction.aggregate([
      { $match: { messId, timestamp: { $gte: start, $lte: end } } },
      { $group: { _id: '$mealType', count: { $sum: 1 } } }
    ]);

    // Daily meal trends
    const dailyTrends = await MealTransaction.aggregate([
      { $match: { messId, timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$timestamp' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Revenue by payment method - combine Payment model and Customer ledger
    const paymentModelRevenue = await Payment.aggregate([
      { $match: { messId, createdAt: { $gte: start, $lte: end }, status: 'completed' } },
      { $group: { _id: '$method', total: { $sum: '$amount' }, count: { $sum: 1 } } }
    ]);

    const ledgerRevenue = await Customer.aggregate([
      { $match: { messId, active: true } },
      { $unwind: '$ledger' },
      { $match: { 'ledger.createdAt': { $gte: start, $lte: end } } },
      { $group: { _id: '$ledger.method', total: { $sum: '$ledger.amount' }, count: { $sum: 1 } } }
    ]);

    // Merge both revenue sources
    const revenueMap = {};
    [...paymentModelRevenue, ...ledgerRevenue].forEach(item => {
      const method = item._id || 'CASH';
      if (!revenueMap[method]) {
        revenueMap[method] = { _id: method, total: 0, count: 0 };
      }
      revenueMap[method].total += item.total;
      revenueMap[method].count += item.count;
    });
    const revenueByMethod = Object.values(revenueMap);

    // Customer growth
    const customerGrowth = await Customer.aggregate([
      { $match: { messId, createdAt: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
          count: { $sum: 1 }
        }
      },
      { $sort: { _id: 1 } }
    ]);

    // Attendance stats
    const attendanceStats = await Attendance.aggregate([
      { $match: { messId, date: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: '$status',
          count: { $sum: 1 }
        }
      }
    ]);

    // Top customers by meal consumption
    const topCustomers = await MealTransaction.aggregate([
      { $match: { messId, timestamp: { $gte: start, $lte: end } } },
      { $group: { _id: '$customerId', mealCount: { $sum: 1 } } },
      { $sort: { mealCount: -1 } },
      { $limit: 10 },
      {
        $lookup: {
          from: 'customers',
          localField: '_id',
          foreignField: '_id',
          as: 'customer'
        }
      },
      { $unwind: '$customer' },
      {
        $project: {
          name: '$customer.name',
          phone: '$customer.phone',
          mealCount: 1
        }
      }
    ]);

    res.json({
      success: true,
      data: {
        mealsByType,
        dailyTrends,
        revenueByMethod,
        customerGrowth,
        attendanceStats,
        topCustomers,
        dateRange: { start, end }
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get meal consumption heatmap (hour-wise)
router.get('/heatmap', async (req, res) => {
  try {
    const messId = new mongoose.Types.ObjectId(req.messId);
    const { startDate, endDate } = req.query;

    const start = startDate ? new Date(startDate) : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const end = endDate ? new Date(endDate) : new Date();

    const heatmap = await MealTransaction.aggregate([
      { $match: { messId, timestamp: { $gte: start, $lte: end } } },
      {
        $group: {
          _id: {
            hour: { $hour: '$timestamp' },
            mealType: '$mealType'
          },
          count: { $sum: 1 }
        }
      },
      { $sort: { '_id.hour': 1 } }
    ]);

    res.json({ success: true, data: heatmap });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

// Get subscription analytics
router.get('/subscriptions', async (req, res) => {
  try {
    const messId = new mongoose.Types.ObjectId(req.messId);

    const activeCount = await Subscription.countDocuments({ messId, status: 'active' });
    const expiredCount = await Subscription.countDocuments({ messId, status: 'expired' });
    const expiringCount = await Subscription.countDocuments({
      messId,
      status: 'active',
      endDate: { $lte: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000) }
    });

    const planDistribution = await Subscription.aggregate([
      { $match: { messId, status: 'active' } },
      {
        $lookup: {
          from: 'plans',
          localField: 'planId',
          foreignField: '_id',
          as: 'plan'
        }
      },
      { $unwind: '$plan' },
      { $group: { _id: '$plan.name', count: { $sum: 1 } } }
    ]);

    res.json({
      success: true,
      data: {
        activeCount,
        expiredCount,
        expiringCount,
        planDistribution
      }
    });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

export default router;
