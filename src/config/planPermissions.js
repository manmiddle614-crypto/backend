/**
 * Plan-Based Report Permissions
 * Single source of truth for report access control
 */

export const PLAN_PERMISSIONS = {
  BASIC: {
    reports: {
      daily: true,
      monthly: false,
      dateRange: false,
      exportCSV: false,
      exportPDF: false,
      analytics: false
    }
  },
  STANDARD: {
    reports: {
      daily: true,
      monthly: true,
      dateRange: false,
      exportCSV: true,
      exportPDF: false,
      analytics: 'basic'
    }
  },
  PRO: {
    reports: {
      daily: true,
      monthly: true,
      dateRange: true,
      exportCSV: true,
      exportPDF: true,
      analytics: 'advanced'
    }
  }
};

// Trial uses BASIC permissions
PLAN_PERMISSIONS.TRIAL = PLAN_PERMISSIONS.BASIC;

/**
 * Get permissions for a plan
 */
export function getPlanPermissions(planName) {
  return PLAN_PERMISSIONS[planName?.toUpperCase()] || PLAN_PERMISSIONS.BASIC;
}

/**
 * Check if plan has specific permission
 */
export function hasPermission(planName, feature) {
  const permissions = getPlanPermissions(planName);
  const [category, permission] = feature.split('.');
  return permissions[category]?.[permission] === true;
}

/**
 * Get grace period permissions (view-only, no exports)
 */
export function getGracePeriodPermissions() {
  return {
    reports: {
      daily: true,
      monthly: true,
      dateRange: true,
      exportCSV: false,
      exportPDF: false,
      analytics: false
    }
  };
}
