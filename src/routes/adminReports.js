import express from 'express';
import { MealTransaction } from '../models/MealTransaction.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { Payment } from '../models/Payment.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireReportPermission } from '../middleware/requireReportPermission.js';

const router = express.Router();

// Determine report type and apply appropriate permission
const checkReportType = (req, res, next) => {
  const { startDate, endDate } = req.query;
  if (!startDate || !endDate) return next();
  
  const start = new Date(startDate);
  const end = new Date(endDate);
  const daysDiff = Math.ceil((end - start) / (1000 * 60 * 60 * 24));
  
  // Determine report type based on date range
  if (daysDiff <= 1) {
    req.reportType = 'daily';
  } else if (daysDiff <= 31) {
    req.reportType = 'monthly'; // Up to 31 days = monthly (Standard plan)
  } else {
    req.reportType = 'dateRange'; // More than 31 days = dateRange (Pro plan)
  }
  next();
};

const dynamicReportPermission = (req, res, next) => {
  const permission = req.reportType || 'daily';
  return requireReportPermission(permission)(req, res, next);
};

// GET /api/admin/reports - Admin reports endpoint
router.get('/', requireAuth, checkReportType, dynamicReportPermission, asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;
  
  if (!startDate || !endDate) {
    return res.status(400).json({
      success: false,
      error: { message: 'Start date and end date are required' }
    });
  }

  const start = new Date(startDate);
  start.setHours(0, 0, 0, 0);
  
  const end = new Date(endDate);
  end.setHours(23, 59, 59, 999);

  // Get transactions
  const transactions = await MealTransaction.find({
    messId: req.messId,
    timestamp: { $gte: start, $lte: end }
  })
  .select('customerId timestamp mealType status')
  .populate('customerId', 'name phone roomNo')
  .sort({ timestamp: -1 })
  .limit(1000)
  .lean();

  // Calculate stats
  const totalScans = transactions.length;
  const successfulScans = transactions.filter(t => t.status === 'success').length;
  const blockedScans = transactions.filter(t => t.status === 'blocked').length;
  const failedScans = transactions.filter(t => t.status === 'failed').length;

  // Get revenue from Payment model
  const payments = await Payment.find({
    messId: req.messId,
    createdAt: { $gte: start, $lte: end },
    status: 'completed'
  })
  .select('amount')
  .limit(1000)
  .lean();
  
  const paymentRevenue = payments.reduce((sum, p) => sum + p.amount, 0);

  // Get revenue from Customer ledger
  const ledgerRevenue = await Customer.aggregate([
    { $match: { messId: req.messId } },
    { $unwind: '$ledger' },
    { $match: { 'ledger.createdAt': { $gte: start, $lte: end } } },
    { $group: { _id: null, total: { $sum: '$ledger.amount' } } }
  ]);

  const totalRevenue = paymentRevenue + (ledgerRevenue[0]?.total || 0);

  // Get current subscription data for each customer
  const customerIds = [...new Set(transactions.map(t => t.customerId?._id).filter(Boolean))];
  const subscriptions = await Subscription.find({
    messId: req.messId,
    customerId: { $in: customerIds },
    active: true
  })
  .select('customerId mealsRemaining mealBalances')
  .lean();

  const subscriptionMap = {};
  subscriptions.forEach(sub => {
    const totalRemaining = sub.mealBalances 
      ? Object.values(sub.mealBalances).reduce((sum, val) => sum + (val || 0), 0)
      : sub.mealsRemaining || 0;
    subscriptionMap[sub.customerId.toString()] = totalRemaining;
  });

  // Meal breakdown
  const mealTypeBreakdown = {};
  transactions.forEach(t => {
    if (t.status === 'success') {
      mealTypeBreakdown[t.mealType] = (mealTypeBreakdown[t.mealType] || 0) + 1;
    }
  });

  // Format response
  const records = transactions.map(t => {
    const customerId = t.customerId?._id?.toString();
    return {
      timestamp: t.timestamp,
      customer: t.customerId ? {
        name: t.customerId.name,
        phone: t.customerId.phone,
        roomNo: t.customerId.roomNo
      } : { name: 'Unknown', phone: '-', roomNo: '-' },
      mealType: t.mealType,
      status: t.status,
      mealsRemaining: customerId ? (subscriptionMap[customerId] || 0) : 0
    };
  });

  res.json({
    success: true,
    data: {
      summary: {
        totalScans,
        successfulScans,
        blockedScans,
        failedScans,
        totalRevenue
      },
      mealTypeBreakdown,
      transactions: records
    }
  });
}));

// GET /api/admin/reports/export/csv - CSV export endpoint
router.get('/export/csv', requireAuth, requireReportPermission('exportCSV'), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    message: 'CSV export allowed'
  });
}));

// GET /api/admin/reports/export/pdf - PDF export endpoint
router.get('/export/pdf', requireAuth, requireReportPermission('exportPDF'), asyncHandler(async (req, res) => {
  res.json({
    success: true,
    message: 'PDF export allowed'
  });
}));

export default router;
