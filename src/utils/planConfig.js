/**
 * Centralized Plan Configuration
 * All feature limits defined here - NEVER hardcode in routes
 */

export const PLAN_CONFIG = {
  BASIC: {
    name: 'Basic',
    price: 499,
    maxStaff: 2,
    maxCustomers: 100,
    maxScansPerDay: 150,
    features: {
      reports: false,
      analytics: false,
      apiAccess: false,
      customBranding: false,
      prioritySupport: false
    }
  },
  
  STANDARD: {
    name: 'Standard',
    price: 999,
    maxStaff: 5,
    maxCustomers: 150,
    maxScansPerDay: Infinity,
    features: {
      reports: true,
      analytics: true,
      apiAccess: false,
      customBranding: false,
      prioritySupport: false
    }
  },
  
  PRO: {
    name: 'Pro',
    price: 1999,
    maxStaff: 20,
    maxCustomers: 500,
    maxScansPerDay: Infinity,
    features: {
      reports: true,
      analytics: true,
      apiAccess: true,
      customBranding: true,
      prioritySupport: true
    }
  }
};

export const DEFAULT_PLAN = 'STANDARD';

/**
 * Get plan configuration by name
 */
export function getPlanConfig(planName) {
  return PLAN_CONFIG[planName?.toUpperCase()] || PLAN_CONFIG[DEFAULT_PLAN];
}

/**
 * Get plan limits for a mess
 */
export function getPlanLimits(planName) {
  const config = getPlanConfig(planName);
  return {
    maxStaff: config.maxStaff,
    maxCustomers: config.maxCustomers,
    maxScansPerDay: config.maxScansPerDay
  };
}

/**
 * Check if feature is enabled for plan
 */
export function hasFeature(planName, featureName) {
  const config = getPlanConfig(planName);
  return config.features[featureName] === true;
}

/**
 * Check if limit is reached
 */
export function isLimitReached(current, limit) {
  if (limit === Infinity) return false;
  return current >= limit;
}
