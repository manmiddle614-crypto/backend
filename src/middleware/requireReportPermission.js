import { getPlanPermissions, getGracePeriodPermissions } from '../config/planPermissions.js';
import { ApiError } from '../utils/errorHandler.js';

/**
 * Middleware factory to check report permissions
 * @param {string} permission - Permission key (e.g., 'daily', 'monthly', 'exportCSV', 'exportPDF')
 */
export function requireReportPermission(permission) {
  return async (req, res, next) => {
    try {
      const subscription = req.subscription;

      // No subscription = no access
      if (!subscription) {
        return next(new ApiError(
          'Subscription required to access reports',
          403,
          'NO_SUBSCRIPTION'
        ));
      }

      // Expired without grace period = no access
      const now = new Date();
      const isExpired = ['expired', 'cancelled'].includes(subscription.status);
      const hasGracePeriod = subscription.gracePeriodEndsAt && now < subscription.gracePeriodEndsAt;

      if (isExpired && !hasGracePeriod) {
        return next(new ApiError(
          'Subscription expired. Please renew to access reports.',
          403,
          'SUBSCRIPTION_EXPIRED'
        ));
      }

      // Get permissions based on status
      let permissions;
      if (hasGracePeriod) {
        // Grace period: view-only, no exports
        permissions = getGracePeriodPermissions();
      } else {
        // Normal: based on plan
        permissions = getPlanPermissions(subscription.planName);
      }

      // Check if permission is allowed
      const hasAccess = permissions.reports[permission];

      if (!hasAccess) {
        const upgradeMessage = subscription.planName === 'BASIC' 
          ? 'Upgrade to Standard or Pro plan to access this feature'
          : subscription.planName === 'STANDARD'
          ? 'Upgrade to Pro plan to access this feature'
          : 'Upgrade your plan to access this feature';

        return next(new ApiError(
          upgradeMessage,
          403,
          'PLAN_UPGRADE_REQUIRED'
        ));
      }

      // Attach permissions to request for controller use
      req.reportPermissions = permissions.reports;
      next();
    } catch (error) {
      next(error);
    }
  };
}
