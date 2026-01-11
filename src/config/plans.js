

export const PLANS = {
  BASIC: {
    name: 'Basic',
    limits: {
      staff: 2,
      customers: 100
    },
    pricing: {
      monthly: 699,
      '6month': 3999,  // ~667/month (4% savings)
      yearly: 6999     // ~583/month (17% savings)
    },
    features: [
      'Up to 2 staff members',
      'Up to 100 customers',
      'QR code scanning',
      'Basic reports',
      'Email support'
    ]
  },
  STANDARD: {
    name: 'Standard',
    limits: {
      staff: 5,
      customers: 150
    },
    pricing: {
      monthly: 999,
      '6month': 5499,  // ~917/month (8% savings)
      yearly: 9999     // ~833/month (17% savings)
    },
    features: [
      'Up to 5 staff members',
      'Up to 150 customers',
      'QR code scanning',
      'Advanced reports',
      'Priority email support',
      'Offline mode'
    ]
  },
  PRO: {
    name: 'Pro',
    limits: {
      staff: 20,
      customers: 500
    },
    pricing: {
      monthly: 1999,
      '6month': 10999, // ~1833/month (8% savings)
      yearly: 19999    // ~1667/month (17% savings)
    },
    features: [
      'Up to 20 staff members',
      'Up to 500 customers',
      'QR code scanning',
      'Advanced reports & analytics',
      'Priority support',
      'Offline mode',
      'Custom integrations',
      'Dedicated account manager'
    ]
  }
};

/**
 * Get plan price (server-side only)
 */
export function getPlanPrice(planKey, billingCycle) {
  const plan = PLANS[planKey];
  if (!plan) {
    throw new Error(`Invalid plan: ${planKey}`);
  }
  
  const price = plan.pricing[billingCycle];
  if (!price) {
    throw new Error(`Invalid billing cycle: ${billingCycle}`);
  }
  
  return price;
}

/**
 * Get plan limits
 */
export function getPlanLimits(planKey) {
  const plan = PLANS[planKey];
  if (!plan) {
    throw new Error(`Invalid plan: ${planKey}`);
  }
  
  return plan.limits;
}

/**
 * Calculate subscription end date
 */
export function calculateEndDate(billingCycle, startDate = new Date()) {
  const start = new Date(startDate);
  
  switch (billingCycle) {
    case 'monthly':
      return new Date(start.setMonth(start.getMonth() + 1));
    case '6month':
      return new Date(start.setMonth(start.getMonth() + 6));
    case 'yearly':
      return new Date(start.setFullYear(start.getFullYear() + 1));
    default:
      throw new Error(`Invalid billing cycle: ${billingCycle}`);
  }
}

/**
 * Calculate grace period end date (7 days after expiry)
 */
export function calculateGraceEndDate(expiryDate) {
  const grace = new Date(expiryDate);
  grace.setDate(grace.getDate() + 7);
  return grace;
}

export default PLANS;