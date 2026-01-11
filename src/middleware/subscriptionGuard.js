import { MessSubscription } from '../models/MessSubscription.js';
import { ApiError } from '../utils/errorHandler.js';

// Routes that are ALWAYS allowed (public + auth)
const ALLOWLIST = {
  public: [
    '/health',
    '/auth/signup',
    '/auth/login',
    '/auth/login-pin',
    '/api/auth',
    '/api/auth-pin',
    '/super-admin'
  ],
  // Allowed even when subscription expired
  billing: [
    '/api/mess-subscription/status',
    '/api/mess-subscription/create-order',
    '/api/mess-subscription/verify-payment',
    '/api/mess-subscription/webhooks/razorpay',
    '/api/mess-subscription/cancel',
    '/api/mess-subscription/upgrade'
  ]
};

// Routes that are BLOCKED when subscription expired
const BLOCKED_ROUTES = {
  scans: ['/api/scan', '/api/scan-v2', '/api/scan-core', '/api/scan-batch', '/api/deep-link-scan'],
  customers: ['/api/customers', '/api/admin/customers'],
  staff: ['/api/admin/staff'],
  reports: ['/api/reports', '/api/customer/reports'],
  settings: ['/api/settings']
};

/**
 * Check if route is in allowlist
 */
function isAllowedRoute(path) {
  return [...ALLOWLIST.public, ...ALLOWLIST.billing].some(route => 
    path.startsWith(route)
  );
}

/**
 * Check if route should be blocked when expired
 */
function isBlockedRoute(path) {
  return Object.values(BLOCKED_ROUTES).flat().some(route => 
    path.startsWith(route)
  );
}

/**
 * SaaS Subscription Guard Middleware
 * Validates subscription status and blocks access to protected routes
 */
export async function subscriptionGuard(req, res, next) {
  // Skip allowlisted routes
  if (isAllowedRoute(req.path)) {
    return next();
  }

  // Skip if no messId (customer-only routes)
  if (!req.messId) {
    return next();
  }

  try {
    // Fetch subscription with timeout
    const subscription = await MessSubscription.findOne({ messId: req.messId })
      .maxTimeMS(5000) // 5 second timeout
      .lean();

    if (!subscription) {

      return next();
    }

    const now = new Date();
    const gracePeriodDays = 7;

    // Check trial expiry
    if (subscription.status === 'trial' && now > subscription.trialEndsAt) {
      // Initialize grace period if not set
      if (!subscription.gracePeriodEndsAt) {
        subscription.gracePeriodEndsAt = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
        await subscription.save();
      }

      // IMMEDIATE block for scans, even during grace period
      if (req.path.startsWith('/api/scan')) {
        return next(new ApiError(
          'Trial expired. Please subscribe to continue scanning.',
          402,
          'TRIAL_EXPIRED'
        ));
      }

      // Hard block other routes after grace period
      if (now > subscription.gracePeriodEndsAt && isBlockedRoute(req.path)) {
        return next(new ApiError(
          'Trial expired. Please subscribe to continue.',
          402,
          'TRIAL_EXPIRED'
        ));
      }

      // Soft warning during grace period
      req.subscriptionWarning = {
        type: 'trial_expired',
        message: 'Your trial has expired. Please subscribe to continue.',
        daysRemaining: Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24)),
        gracePeriodEndsAt: subscription.gracePeriodEndsAt
      };
    }

    // Check active subscription expiry
    if (subscription.status === 'active' && now > subscription.endDate) {
      // Mark as expired and start grace period
      if (!subscription.gracePeriodEndsAt) {
        subscription.status = 'expired';
        subscription.gracePeriodEndsAt = new Date(now.getTime() + gracePeriodDays * 24 * 60 * 60 * 1000);
        await subscription.save();
      }

      // IMMEDIATE block for scans, even during grace period
      if (req.path.startsWith('/api/scan')) {
        return next(new ApiError(
          'Subscription expired. Please renew to continue scanning.',
          402,
          'SUBSCRIPTION_EXPIRED'
        ));
      }

      // Hard block other routes after grace period
      if (now > subscription.gracePeriodEndsAt && isBlockedRoute(req.path)) {
        return next(new ApiError(
          'Subscription expired. Please renew to continue.',
          402,
          'SUBSCRIPTION_EXPIRED'
        ));
      }

      // Soft warning during grace period
      req.subscriptionWarning = {
        type: 'subscription_expired',
        message: 'Your subscription has expired. Please renew to continue.',
        daysRemaining: Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24)),
        gracePeriodEndsAt: subscription.gracePeriodEndsAt
      };
    }

    // Check expired status (already in grace period)
    if (subscription.status === 'expired') {
      // IMMEDIATE block for scans
      if (req.path.startsWith('/api/scan')) {
        return next(new ApiError(
          'Subscription expired. Please renew to continue scanning.',
          402,
          'SUBSCRIPTION_EXPIRED'
        ));
      }

      if (now > subscription.gracePeriodEndsAt && isBlockedRoute(req.path)) {
        return next(new ApiError(
          'Subscription expired. Please renew to continue.',
          402,
          'SUBSCRIPTION_EXPIRED'
        ));
      }

      req.subscriptionWarning = {
        type: 'subscription_expired',
        message: 'Your subscription has expired. Please renew to continue.',
        daysRemaining: Math.max(0, Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24))),
        gracePeriodEndsAt: subscription.gracePeriodEndsAt
      };
    }

    // Check past_due status
    if (subscription.status === 'past_due') {
      req.subscriptionWarning = {
        type: 'payment_failed',
        message: 'Your last payment failed. Please update your payment method.',
        daysRemaining: subscription.gracePeriodEndsAt ? 
          Math.max(0, Math.ceil((subscription.gracePeriodEndsAt - now) / (1000 * 60 * 60 * 24))) : 0
      };
    }

    // Attach subscription to request
    req.subscription = subscription;

    next();
  } catch (error) {

    // On DB error, allow request to proceed (fail open)
    return next();
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
