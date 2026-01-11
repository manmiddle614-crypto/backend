import { MessSubscription } from '../models/MessSubscription.js';
import { ApiError } from '../utils/errorHandler.js';

/**
 * Subscription Guard Middleware
 * Blocks access if subscription is expired (after grace period)
 */
export async function subscriptionGuard(req, res, next) {
  // Skip for public routes
  const publicRoutes = [
    '/auth/signup',
    '/auth/login',
    '/auth/login-pin',
    '/health',
    '/api/mess-subscription/webhooks/razorpay',
    '/api/mess-subscription/status',
    '/api/mess-subscription/create-order',
    '/api/mess-subscription/verify-payment'
  ];

  if (publicRoutes.some(route => req.path.startsWith(route))) {
    return next();
  }

  // Skip if no messId (customer routes)
  if (!req.messId) {
    return next();
  }

  try {
    const subscription = await MessSubscription.findOne({ messId: req.messId });

    if (!subscription) {

      return next();
    }

    const now = new Date();

    // Check trial expiry
    if (subscription.status === 'trial' && now > subscription.trialEndsAt) {
      // Start grace period
      if (!subscription.gracePeriodEndsAt) {
        subscription.gracePeriodEndsAt = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
        await subscription.save();
      }

      // Hard block after grace period
      if (now > subscription.gracePeriodEndsAt) {
        return next(new ApiError(
          'Trial expired. Please subscribe to continue.',
          402,
          'TRIAL_EXPIRED'
        ));
      }

      // Soft block - allow access but warn
      req.subscriptionWarning = {
        type: 'trial_expired',
        message: 'Your trial has expired. Please subscribe to continue using the service.',
        daysRemaining: Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24))
      };
    }

    // Check active subscription expiry
    if (subscription.status === 'active' && now > subscription.endDate) {
      await subscription.expireSubscription();

      // Hard block after grace period
      if (now > subscription.gracePeriodEndsAt) {
        return next(new ApiError(
          'Subscription expired. Please renew to continue.',
          402,
          'SUBSCRIPTION_EXPIRED'
        ));
      }

      // Soft block - allow access but warn
      req.subscriptionWarning = {
        type: 'subscription_expired',
        message: 'Your subscription has expired. Please renew to continue using the service.',
        daysRemaining: Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24))
      };
    }

    // Check past_due status
    if (subscription.status === 'past_due') {
      req.subscriptionWarning = {
        type: 'payment_failed',
        message: 'Your last payment failed. Please update your payment method.',
        daysRemaining: subscription.gracePeriodEndsAt ? 
          Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24)) : 0
      };
    }

    // Attach subscription to request
    req.subscription = subscription;

    next();
  } catch (error) {

    next(error);
  }
}

/**
 * Inject subscription warning into response
 */
export function injectSubscriptionWarning(req, res, next) {
  if (req.subscriptionWarning) {
    const originalJson = res.json.bind(res);
    res.json = function(data) {
      if (data && typeof data === 'object') {
        data.subscriptionWarning = req.subscriptionWarning;
      }
      return originalJson(data);
    };
  }
  next();
}
