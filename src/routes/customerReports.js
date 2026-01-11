import express from 'express';
import { Customer } from '../models/Customer.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errorHandler.js';

const router = express.Router();

// GET /transactions - Get logged-in customer's transactions
router.get('/transactions', requireAuth, asyncHandler(async (req, res) => {
  const customerId = req.user.sub || req.user.id;
  const { page = 1, limit = 20, status, from, to } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { customerId };
  if (status && status !== 'all') filter.status = status;
  
  // Date range filter
  if (from || to) {
    filter.timestamp = {};
    if (from) filter.timestamp.$gte = new Date(from);
    if (to) filter.timestamp.$lte = new Date(to);
  }

  const transactions = await MealTransaction.find(filter)
    .populate('staffId', 'name')
    .sort({ timestamp: -1 })
    .limit(parseInt(limit))
    .skip(skip)
    .lean();

  const total = await MealTransaction.countDocuments(filter);

  res.json({
    success: true,
    data: {
      transactions,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// GET /reports/customer/:customerId - Generate customer report (CSV)
router.get('/customer/:customerId', requireAuth, asyncHandler(async (req, res) => {
  const { customerId } = req.params;
  const { from, to, format = 'csv' } = req.query;
  
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError('Customer not found', 404);
  }
  
  // Build date filter
  const dateFilter = {};
  if (from) dateFilter.$gte = new Date(from);
  if (to) dateFilter.$lte = new Date(to);
  
  // Get transactions
  const transactions = await MealTransaction.find({
    customerId: customer._id,
    ...(Object.keys(dateFilter).length > 0 && { timestamp: dateFilter })
  })
  .populate('staffId', 'name')
  .sort({ timestamp: -1 })
  .lean();
  
  // Get payments from ledger
  const payments = customer.ledger.filter(entry => {
    if (Object.keys(dateFilter).length === 0) return true;
    const entryDate = new Date(entry.createdAt);
    if (dateFilter.$gte && entryDate < dateFilter.$gte) return false;
    if (dateFilter.$lte && entryDate > dateFilter.$lte) return false;
    return true;
  });
  
  if (format === 'csv') {
    // Generate CSV
    let csv = 'Type,Date,Meal Type,Status,Staff,Amount,Method,Note\n';
    
    // Add transactions
    transactions.forEach(tx => {
      csv += `Transaction,${tx.timestamp.toISOString()},${tx.mealType},${tx.status},${tx.staffName || tx.staffId?.name || 'N/A'},,,,\n`;
    });
    
    // Add payments
    payments.forEach(payment => {
      csv += `Payment,${payment.createdAt.toISOString()},,,,${payment.amount},${payment.method},"${payment.note || ''}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', `attachment; filename="report-${customer.name}-${from || 'all'}-${to || 'all'}.csv"`);
    res.send(csv);
  } else {
    // Return JSON
    res.json({
      success: true,
      data: {
        customer: {
          name: customer.name,
          phone: customer.phone,
          roomNo: customer.roomNo
        },
        transactions,
        payments,
        summary: {
          totalTransactions: transactions.length,
          successfulMeals: transactions.filter(t => t.status === 'success').length,
          totalPayments: payments.reduce((sum, p) => sum + p.amount, 0),
          currentBalance: customer.balance
        }
      }
    });
  }
}));

export default router;
