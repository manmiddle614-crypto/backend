import express from 'express';
import jwt from 'jsonwebtoken';
import { SuperAdmin } from '../models/SuperAdmin.js';
import { Mess } from '../models/Mess.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { Payment } from '../models/Payment.js';
import { Customer } from '../models/Customer.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { PlanOverride } from '../models/PlanOverride.js';
import { AuditLog } from '../models/AuditLog.js';
import { User } from '../models/User.js';
import { getPlanLimits } from '../utils/planConfig.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// Super Admin Auth Middleware
const requireSuperAdmin = asyncHandler(async (req, res, next) => {
  const token = req.headers.authorization?.split(' ')[1];
  if (!token) throw new ApiError('Unauthorized', 401, 'UNAUTHORIZED');

  const decoded = jwt.verify(token, process.env.JWT_SECRET);
  if (decoded.role !== 'SUPER_ADMIN') throw new ApiError('Forbidden', 403, 'FORBIDDEN');

  req.superAdmin = decoded;
  next();
});

// Login
router.post('/login', asyncHandler(async (req, res) => {
  const { email, password } = req.body;

  const admin = await SuperAdmin.findOne({ email: email.toLowerCase(), active: true });
  if (!admin || !(await admin.comparePassword(password))) {
    throw new ApiError('Invalid credentials', 401, 'INVALID_CREDENTIALS');
  }

  admin.lastLoginAt = new Date();
  admin.loginCount += 1;
  await admin.save();

  const token = jwt.sign(
    { sub: admin._id, email: admin.email, role: 'SUPER_ADMIN' },
    process.env.JWT_SECRET,
    { expiresIn: '24h' }
  );

  res.json(successResponse({ token, admin: { id: admin._id, name: admin.name, email: admin.email } }));
}));

// Dashboard Stats
router.get('/dashboard', requireSuperAdmin, asyncHandler(async (req, res) => {
  const [totalMesses, statusCounts, monthlyRevenue, recentMesses] = await Promise.all([
    Mess.countDocuments(),
    MessSubscription.aggregate([
      { $group: { _id: '$status', count: { $sum: 1 } } }
    ]),
    Payment.aggregate([
      {
        $match: {
          status: 'completed',
          createdAt: { $gte: new Date(new Date().setDate(1)) }
        }
      },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]),
    Mess.find().sort({ createdAt: -1 }).limit(10).lean()
  ]);

  const stats = statusCounts.reduce((acc, { _id, count }) => {
    acc[_id] = count;
    return acc;
  }, { trial: 0, active: 0, expired: 0, past_due: 0, cancelled: 0 });

  res.json(successResponse({
    totalMesses,
    activeSubscriptions: stats.active,
    trialSubscriptions: stats.trial,
    expiredSubscriptions: stats.expired + stats.past_due + stats.cancelled,
    monthlyRevenue: monthlyRevenue[0]?.total || 0,
    recentMesses
  }));
}));

// List All Messes
router.get('/messes', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, status, search } = req.query;
  const skip = (page - 1) * limit;

  const filter = {};
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { ownerEmail: { $regex: search, $options: 'i' } }
    ];
  }

  const messes = await Mess.find(filter)
    .sort({ createdAt: -1 })
    .skip(skip)
    .limit(parseInt(limit))
    .lean();

  const messIds = messes.map(m => m._id);
  const subscriptions = await MessSubscription.find({ messId: { $in: messIds } }).lean();
  const subMap = subscriptions.reduce((acc, sub) => {
    acc[sub.messId] = sub;
    return acc;
  }, {});

  const enriched = messes.map(m => ({
    ...m,
    subscription: subMap[m._id] || null
  }));

  if (status) {
    const filtered = enriched.filter(m => m.subscription?.status === status);
    return res.json(successResponse({ messes: filtered, total: filtered.length }));
  }

  const total = await Mess.countDocuments(filter);
  res.json(successResponse({ messes: enriched, total, page: parseInt(page), limit: parseInt(limit) }));
}));

// Get Mess Details
router.get('/messes/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const mess = await Mess.findById(req.params.id).lean();
  if (!mess) throw new ApiError('Mess not found', 404, 'NOT_FOUND');

  const [subscription, customerCount, transactionCount] = await Promise.all([
    MessSubscription.findOne({ messId: mess._id }).lean(),
    Customer.countDocuments({ messId: mess._id }),
    MealTransaction.countDocuments({ messId: mess._id })
  ]);

  res.json(successResponse({ mess, subscription, customerCount, transactionCount }));
}));

// Extend Trial
router.post('/messes/:id/extend-trial', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { days } = req.body;
  if (!days || days < 1) throw new ApiError('Invalid days', 400, 'INVALID_DAYS');

  const subscription = await MessSubscription.findOne({ messId: req.params.id });
  if (!subscription) throw new ApiError('Subscription not found', 404, 'NOT_FOUND');

  subscription.trialEndsAt = new Date(subscription.trialEndsAt.getTime() + days * 24 * 60 * 60 * 1000);
  if (subscription.status === 'expired') subscription.status = 'trial';
  await subscription.save();

  res.json(successResponse({ subscription }));
}));

// Activate Subscription
router.post('/messes/:id/activate', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { months = 1 } = req.body;

  const subscription = await MessSubscription.findOne({ messId: req.params.id });
  if (!subscription) throw new ApiError('Subscription not found', 404, 'NOT_FOUND');

  subscription.status = 'active';
  subscription.endDate = new Date(Date.now() + months * 30 * 24 * 60 * 60 * 1000);
  subscription.nextBillingDate = subscription.endDate;
  subscription.gracePeriodEndsAt = null;
  await subscription.save();

  await Mess.findByIdAndUpdate(req.params.id, { subscriptionStatus: 'active' });

  res.json(successResponse({ subscription }));
}));

// Suspend Mess
router.post('/messes/:id/suspend', requireSuperAdmin, asyncHandler(async (req, res) => {
  const subscription = await MessSubscription.findOne({ messId: req.params.id });
  if (!subscription) throw new ApiError('Subscription not found', 404, 'NOT_FOUND');

  subscription.status = 'expired';
  subscription.gracePeriodEndsAt = new Date();
  await subscription.save();

  await Mess.findByIdAndUpdate(req.params.id, { subscriptionStatus: 'expired', active: false });

  res.json(successResponse({ message: 'Mess suspended' }));
}));

// Adjust Subscription
router.patch('/messes/:id/subscription', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { status, endDate, price } = req.body;

  const subscription = await MessSubscription.findOne({ messId: req.params.id });
  if (!subscription) throw new ApiError('Subscription not found', 404, 'NOT_FOUND');

  if (status) subscription.status = status;
  if (endDate) subscription.endDate = new Date(endDate);
  if (price) subscription.price = price;

  await subscription.save();

  res.json(successResponse({ subscription }));
}));

// Analytics
router.get('/analytics/revenue', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { startDate, endDate } = req.query;

  const match = { status: 'completed' };
  if (startDate) match.createdAt = { $gte: new Date(startDate) };
  if (endDate) match.createdAt = { ...match.createdAt, $lte: new Date(endDate) };

  const revenue = await Payment.aggregate([
    { $match: match },
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt' } },
        total: { $sum: '$amount' },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  res.json(successResponse({ revenue }));
}));

router.get('/analytics/growth', requireSuperAdmin, asyncHandler(async (req, res) => {
  const growth = await Mess.aggregate([
    {
      $group: {
        _id: { $dateToString: { format: '%Y-%m', date: '$createdAt' } },
        count: { $sum: 1 }
      }
    },
    { $sort: { _id: 1 } }
  ]);

  res.json(successResponse({ growth }));
}));

// Create Plan Override
router.post('/messes/:id/override', requireSuperAdmin, asyncHandler(async (req, res) => {
  const { overrideType, newLimit, expiresInDays, reason } = req.body;

  if (!['STAFF_LIMIT', 'CUSTOMER_LIMIT'].includes(overrideType)) {
    throw new ApiError('Invalid override type', 400, 'INVALID_TYPE');
  }
  if (!newLimit || newLimit < 1) throw new ApiError('Invalid limit', 400, 'INVALID_LIMIT');
  if (!reason) throw new ApiError('Reason required', 400, 'REASON_REQUIRED');

  const subscription = await MessSubscription.findOne({ messId: req.params.id });
  if (!subscription) throw new ApiError('Subscription not found', 404, 'NOT_FOUND');

  const limits = getPlanLimits(subscription.planName);
  const originalLimit = overrideType === 'STAFF_LIMIT' ? limits.maxStaff : limits.maxCustomers;

  // Deactivate existing overrides
  await PlanOverride.updateMany(
    { messId: req.params.id, overrideType, active: true },
    { active: false }
  );

  const override = await PlanOverride.create({
    messId: req.params.id,
    overrideType,
    originalLimit,
    newLimit,
    expiresAt: expiresInDays ? new Date(Date.now() + expiresInDays * 24 * 60 * 60 * 1000) : null,
    reason,
    createdBy: req.superAdmin.sub
  });

  // Audit log
  await AuditLog.create({
    messId: req.params.id,
    action: 'PLAN_OVERRIDE_CREATED',
    actorId: req.superAdmin.sub,
    actorType: 'system',
    details: { overrideType, originalLimit, newLimit, expiresInDays, reason },
    ipAddress: req.ip
  });

  res.json(successResponse({ override }));
}));

// List Overrides
router.get('/messes/:id/overrides', requireSuperAdmin, asyncHandler(async (req, res) => {
  const overrides = await PlanOverride.find({ messId: req.params.id })
    .populate('createdBy', 'name email')
    .sort({ createdAt: -1 });

  res.json(successResponse({ overrides }));
}));

// Revoke Override
router.delete('/overrides/:id', requireSuperAdmin, asyncHandler(async (req, res) => {
  const override = await PlanOverride.findById(req.params.id);
  if (!override) throw new ApiError('Override not found', 404, 'NOT_FOUND');

  override.active = false;
  await override.save();

  await AuditLog.create({
    messId: override.messId,
    action: 'PLAN_OVERRIDE_REVOKED',
    actorId: req.superAdmin.sub,
    actorType: 'system',
    details: { overrideId: override._id, overrideType: override.overrideType },
    ipAddress: req.ip
  });

  res.json(successResponse({ message: 'Override revoked' }));
}));

export default router;
