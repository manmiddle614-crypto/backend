import mongoose from 'mongoose';
import { MessSubscription } from '../models/MessSubscription.js';
import { User } from '../models/User.js';
import { Customer } from '../models/Customer.js';
import { getPlanLimits, isLimitReached } from '../utils/planConfig.js';
import { ApiError } from '../utils/errorHandler.js';

/**
 * Feature configuration mapping
 */
const FEATURE_CONFIG = {
  CREATE_STAFF: {
    model: User,
    filter: (messId) => ({ messId, role: { $in: ['admin', 'staff'] }, active: true }),
    limitKey: 'maxStaff',
    errorMessage: 'Staff limit reached. Upgrade plan to add more staff.'
  },
  CREATE_CUSTOMER: {
    model: Customer,
    filter: (messId) => ({ messId, active: true }),
    limitKey: 'maxCustomers',
    errorMessage: 'Customer limit reached. Upgrade plan to add more customers.'
  }
};

/**
 * Generic feature guard middleware
 * @param {string} featureName - Feature to check (CREATE_STAFF, CREATE_CUSTOMER)
 * @returns {Function} Express middleware
 */
export function checkFeatureLimit(featureName) {
  return async (req, res, next) => {
    const feature = FEATURE_CONFIG[featureName];
    
    if (!feature) {
      return next(new ApiError(`Unknown feature: ${featureName}`, 500, 'INVALID_FEATURE'));
    }

    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Fetch subscription
      const subscription = await MessSubscription.findOne({ 
        messId: req.messId 
      }).session(session);

      if (!subscription) {
        await session.abortTransaction();
        return next(new ApiError('No subscription found', 404, 'NO_SUBSCRIPTION'));
      }

      // 2. Get plan limits
      const limits = getPlanLimits(subscription.planName);
      const limit = limits[feature.limitKey];

      // 3. Count current usage
      const currentCount = await feature.model.countDocuments(
        feature.filter(req.messId)
      ).session(session);

      // 4. Check limit
      if (isLimitReached(currentCount, limit)) {
        await session.abortTransaction();
        return next(new ApiError(
          `${feature.errorMessage} (${limit} max)`,
          403,
          `${featureName}_LIMIT_REACHED`
        ));
      }

      // 5. Attach usage info to request
      req.featureUsage = {
        current: currentCount,
        limit,
        remaining: limit === Infinity ? Infinity : limit - currentCount
      };

      // 6. Attach session for route handler to use
      req.dbSession = session;

      next();
    } catch (error) {
      await session.abortTransaction();
      session.endSession();
      next(error);
    }
  };
}

/**
 * Cleanup middleware - commit or abort transaction
 * Must be used after route handler
 */
export async function cleanupFeatureGuard(req, res, next) {
  if (req.dbSession) {
    try {
      if (res.statusCode >= 200 && res.statusCode < 300) {
        await req.dbSession.commitTransaction();
      } else {
        await req.dbSession.abortTransaction();
      }
    } finally {
      req.dbSession.endSession();
    }
  }
  next();
}
