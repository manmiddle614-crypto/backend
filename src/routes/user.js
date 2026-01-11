import express from 'express';
import jwt from 'jsonwebtoken';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { Plan } from '../models/Plan.js';
import { generateQrToken } from '../utils/qrHelper.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * Middleware: Authenticate customer token
 */
function authenticateCustomer(req, res, next) {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) {
    return res.status(401).json({
      success: false,
      data: null,
      error: { message: 'Unauthorized', code: 'UNAUTHORIZED' },
    });
  }

  jwt.verify(token, process.env.JWT_SECRET || 'your-secret-key', (err, user) => {
    if (err) {
      return res.status(403).json({
        success: false,
        data: null,
        error: { message: 'Invalid token', code: 'INVALID_TOKEN' },
      });
    }
    if (user.role !== 'customer' && user.type !== 'customer') {
      return res.status(403).json({
        success: false,
        data: null,
        error: { message: 'Forbidden', code: 'FORBIDDEN' },
      });
    }
    req.user = user;
    next();
  });
}

/**
 * GET /user/profile
 * Get customer profile with subscription and transaction history
 */
const getProfileHandler = asyncHandler(async (req, res) => {
  const customerId = req.user.sub || req.user.id;

  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Get active subscription
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const subscription = await Subscription.findOne({
    customerId,
    active: true,
    startDate: { $lte: new Date() },
    endDate: { $gte: today },
  })
    .populate('planId')
    .sort({ createdAt: -1 });

  // Get last 10 transactions
  const lastTransactions = await MealTransaction.find({
    customerId,
  })
    .sort({ timestamp: -1 })
    .limit(10)
    .select('mealType status timestamp');

  // Check if customer should be auto-deactivated
  let isActive = customer.active;
  if (subscription && subscription.mealsRemaining <= 0) {
    isActive = false;
  }

  res.json(
    successResponse(
      {
        user: {
          id: customer._id,
          name: customer.name,
          phone: customer.phone,
        },
        customer: {
          name: customer.name,
          phone: customer.phone,
          roomNo: customer.roomNo,
          qrCodeId: customer.qrCodeId,
          active: isActive,
        },
        subscription: subscription
          ? {
              id: subscription._id,
              plan: subscription.planId,
              mealsRemaining: subscription.mealsRemaining,
              mealsTotal: subscription.mealsTotal,
              startDate: subscription.startDate,
              endDate: subscription.endDate,
              active: subscription.active && isActive,
            }
          : null,
        lastTransactions: lastTransactions.map((t) => ({
          id: t._id,
          mealType: t.mealType,
          status: t.status,
          timestamp: t.timestamp,
        })),
      },
      'Profile retrieved',
    ),
  );
});

/**
 * GET /user/qr
 * Get short-lived QR token for display
 * Returns a JWT-signed QR token valid for 2 minutes
 */
const getQrTokenHandler = asyncHandler(async (req, res) => {
  const customerId = req.user.sub || req.user.id;

  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Check if customer has active subscription
  const subscription = await Subscription.findOne({
    customerId,
    active: true,
    mealsRemaining: { $gt: 0 },
    endDate: { $gte: new Date() },
  });

  if (!subscription) {
    throw new ApiError('No active subscription', 410, 'NO_ACTIVE_SUBSCRIPTION');
  }

  // Generate short-lived QR token
  const qrToken = generateQrToken(customer.qrCodeId, process.env.JWT_SECRET || 'your-secret-key');

  res.json(
    successResponse(
      {
        qrToken,
        qrCodeId: customer.qrCodeId,
        expiresIn: 120, // 2 minutes
      },
      'QR token generated',
    ),
  );
});

/**
 * PUT /user/profile
 * Update customer profile (name, roomNo)
 */
const updateProfileHandler = asyncHandler(async (req, res) => {
  const customerId = req.user.sub || req.user.id;
  const { name, roomNo } = req.body;

  const customer = await Customer.findByIdAndUpdate(
    customerId,
    {
      ...(name && { name }),
      ...(roomNo && { roomNo }),
    },
    { new: true, runValidators: true },
  );

  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  res.json(successResponse(customer, 'Profile updated'));
});

router.get('/profile', authenticateCustomer, getProfileHandler);
router.get('/qr', authenticateCustomer, getQrTokenHandler);
router.put('/profile', authenticateCustomer, updateProfileHandler);
router.get('/transactions', authenticateCustomer, asyncHandler(async (req, res) => {
  const customerId = req.user.sub || req.user.id;
  const { page = 1, limit = 20, status, mealType } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);
  const filter = { customerId };
  if (status) filter.status = status;
  if (mealType) filter.mealType = mealType;
  const transactions = await MealTransaction.find(filter)
    .sort({ timestamp: -1 })
    .skip(skip)
    .limit(parseInt(limit));
  const total = await MealTransaction.countDocuments(filter);
  res.json(successResponse({
    transactions,
    pagination: { page: parseInt(page), limit: parseInt(limit), total, pages: Math.ceil(total / parseInt(limit)) }
  }, 'Transactions retrieved'));
}));

export default router;
