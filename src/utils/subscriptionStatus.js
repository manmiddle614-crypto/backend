/**
 * Central Subscription Status Calculator
 * Single source of truth for subscription state
 */

export function calculateSubscriptionMeta(subscription) {
  if (!subscription) {
    return {
      status: 'expired',
      daysRemaining: 0,
      isExpiringSoon: false,
      isExpired: true,
      isGrace: false,
      canAccessFeatures: false
    };
  }

  const now = new Date();
  const endDate = subscription.status === 'trial' ? subscription.trialEndsAt : subscription.endDate;
  const graceEndsAt = subscription.gracePeriodEndsAt;

  // Calculate days remaining
  const diffMs = endDate - now;
  const daysRemaining = Math.max(0, Math.ceil(diffMs / 86400000));

  // Determine actual status
  let actualStatus = subscription.status;
  let isGrace = false;
  let isExpired = false;

  if (now > endDate) {
    if (graceEndsAt && now <= graceEndsAt) {
      actualStatus = 'grace';
      isGrace = true;
    } else {
      actualStatus = 'expired';
      isExpired = true;
    }
  }

  // Check if expiring soon (3 days or less)
  const isExpiringSoon = daysRemaining <= 3 && daysRemaining > 0 && ['trial', 'active'].includes(actualStatus);

  // Can access features?
  const canAccessFeatures = ['trial', 'active', 'grace'].includes(actualStatus);

  return {
    status: actualStatus,
    daysRemaining,
    isExpiringSoon,
    isExpired,
    isGrace,
    canAccessFeatures
  };
}
