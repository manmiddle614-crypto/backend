import { MessSubscription } from '../models/MessSubscription.js';
import { User } from '../models/User.js';
import { Customer } from '../models/Customer.js';
import { PlanOverride } from '../models/PlanOverride.js';
import { getPlanLimits, isLimitReached } from '../utils/planConfig.js';
import { ApiError } from '../utils/errorHandler.js';

/**
 * Get effective limit with override check
 */
async function getEffectiveLimit(messId, overrideType, defaultLimit) {
  const override = await PlanOverride.findOne({
    messId,
    overrideType,
    active: true,
    $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }]
  }).sort({ createdAt: -1 });

  return override ? override.newLimit : defaultLimit;
}

/**
 * Middleware to check staff limit before creation
 */
export async function checkStaffLimit(req, res, next) {
  try {
    const subscription = await MessSubscription.findOne({ messId: req.messId });
    if (!subscription) return next();

    const limits = getPlanLimits(subscription.planName);
    const effectiveLimit = await getEffectiveLimit(req.messId, 'STAFF_LIMIT', limits.maxStaff);
    const currentStaff = await User.countDocuments({ messId: req.messId, active: true });

    if (isLimitReached(currentStaff, effectiveLimit)) {
      throw new ApiError(
        `Staff limit reached (${effectiveLimit}). Upgrade plan to add more.`,
        403,
        'STAFF_LIMIT_REACHED'
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Middleware to check customer limit before creation
 */
export async function checkCustomerLimit(req, res, next) {
  try {
    const subscription = await MessSubscription.findOne({ messId: req.messId });
    if (!subscription) return next();

    const limits = getPlanLimits(subscription.planName);
    const effectiveLimit = await getEffectiveLimit(req.messId, 'CUSTOMER_LIMIT', limits.maxCustomers);
    const currentCustomers = await Customer.countDocuments({ messId: req.messId, active: true });

    if (isLimitReached(currentCustomers, effectiveLimit)) {
      throw new ApiError(
        `Customer limit reached (${effectiveLimit}). Upgrade plan to add more.`,
        403,
        'CUSTOMER_LIMIT_REACHED'
      );
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Utility to get current usage and limits
 */
export async function getUsageStats(messId) {
  const subscription = await MessSubscription.findOne({ messId });
  const limits = getPlanLimits(subscription?.planName);

  const [staffCount, customerCount] = await Promise.all([
    User.countDocuments({ messId, active: true }),
    Customer.countDocuments({ messId, active: true })
  ]);

  return {
    plan: subscription?.planName || 'STANDARD',
    staff: {
      current: staffCount,
      limit: limits.maxStaff,
      remaining: limits.maxStaff === Infinity ? Infinity : limits.maxStaff - staffCount
    },
    customers: {
      current: customerCount,
      limit: limits.maxCustomers,
      remaining: limits.maxCustomers === Infinity ? Infinity : limits.maxCustomers - customerCount
    }
  };
}
