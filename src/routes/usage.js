import express from 'express';
import { MessSubscription } from '../models/MessSubscription.js';
import { User } from '../models/User.js';
import { Customer } from '../models/Customer.js';
import { getPlanLimits } from '../utils/planConfig.js';
import { successResponse } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /api/usage
 * Get current usage and limits for mess
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const subscription = await MessSubscription.findOne({ messId: req.messId });
  const limits = getPlanLimits(subscription?.planName);

  const [staffCount, customerCount] = await Promise.all([
    User.countDocuments({ messId: req.messId, role: { $in: ['admin', 'staff'] }, active: true }),
    Customer.countDocuments({ messId: req.messId, active: true })
  ]);

  res.json(successResponse({
    plan: subscription?.planName || 'STANDARD',
    staff: {
      current: staffCount,
      limit: limits.maxStaff,
      remaining: limits.maxStaff === Infinity ? Infinity : limits.maxStaff - staffCount,
      limitReached: staffCount >= limits.maxStaff
    },
    customers: {
      current: customerCount,
      limit: limits.maxCustomers,
      remaining: limits.maxCustomers === Infinity ? Infinity : limits.maxCustomers - customerCount,
      limitReached: customerCount >= limits.maxCustomers
    }
  }));
}));

export default router;
