import express from 'express';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { qrTokenService } from '../services/qrTokenService.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /customer/profile
 * Get customer profile with subscription and recent transactions
 */
const getProfileHandler = asyncHandler(async (req, res) => {
  const customerId = req.user.customerId || req.user.sub;

  const customer = await Customer.findById(customerId).select('-pinHash');
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Get active subscription
  const subscription = await Subscription.findOne({
    customerId,
    active: true,
    endDate: { $gte: new Date() }
  }).populate('planId', 'name mealCount price durationDays mealTypes');

  // Get recent transactions
  const lastTransactions = await MealTransaction.find({ customerId })
    .sort({ timestamp: -1 })
    .limit(10)
    .select('mealType status timestamp mealsRemainingAfter');

  res.json(successResponse({
    user: {
      id: customer._id,
      role: 'customer'
    },
    customer: {
      id: customer._id,
      name: customer.name,
      phone: customer.phone,
      roomNo: customer.roomNo,
      qrCodeId: customer.qrCodeId,
      active: customer.active
    },
    subscription,
    lastTransactions
  }, 'Profile retrieved successfully'));
});

/**
 * GET /customer/qr
 * Generate fresh QR token for customer
 */
const getQrHandler = asyncHandler(async (req, res) => {
  const customerId = req.user.customerId || req.user.sub;

  const customer = await Customer.findById(customerId);
  if (!customer || !customer.active) {
    throw new ApiError('Customer not found or inactive', 404, 'NOT_FOUND');
  }

  const qrToken = qrTokenService.generateToken({
    customerId: customer._id.toString(),
    messId: customer.messId.toString(),
    qrCodeId: customer.qrCodeId
  });

  const tokenInfo = qrTokenService.getTokenInfo(qrToken);

  res.json(successResponse({
    qrToken,
    qrCodeId: customer.qrCodeId,
    expiresAt: tokenInfo.expiresAt,
    daysUntilExpiry: tokenInfo.daysUntilExpiry
  }, 'QR token generated'));
});

/**
 * GET /customer/transactions
 * Get customer transaction history with pagination
 */
const getTransactionsHandler = asyncHandler(async (req, res) => {
  const customerId = req.user.customerId || req.user.sub;
  const { page = 1, limit = 20, status, mealType } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = { customerId };
  if (status) filter.status = status;
  if (mealType) filter.mealType = mealType;

  const transactions = await MealTransaction.find(filter)
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .select('mealType status timestamp mealsRemainingBefore mealsRemainingAfter failureReason');

  const total = await MealTransaction.countDocuments(filter);

  res.json(successResponse({
    transactions,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  }, 'Transactions retrieved successfully'));
});

// Routes
router.get('/', getProfileHandler);
router.get('/qr', getQrHandler);
router.get('/transactions', getTransactionsHandler);

export default router;
