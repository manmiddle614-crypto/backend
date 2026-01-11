import { Mess } from '../models/Mess.js';
import { Customer } from '../models/Customer.js';
import { User } from '../models/User.js';
import { ApiError } from '../utils/errorHandler.js';
import { getPlanPermissions } from '../config/planPermissions.js';

/**
 * 🔒 BLOCKER 3: PLAN LIMIT ENFORCEMENT
 * Enforces plan limits server-side (NEVER trust frontend)
 */

export async function enforcePlanLimits(req, res, next) {
  // Skip for non-protected routes
  if (!req.messId) {
    return next();
  }

  try {
    const mess = await Mess.findById(req.messId).select('features subscriptionStatus subscriptionTier');
    
    if (!mess) {
      return next(new ApiError('Mess not found', 404, 'MESS_NOT_FOUND'));
    }

    // Get plan permissions
    const permissions = getPlanPermissions(mess.subscriptionTier || 'standard');
    
    // Attach to request for use in routes
    req.planLimits = {
      maxCustomers: permissions.maxCustomers || mess.features?.maxCustomers || 999999,
      maxStaff: permissions.maxStaff || mess.features?.maxStaff || 999999,
      advancedReports: permissions.advancedReports !== false,
      canExport: permissions.canExport !== false
    };

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Check if customer limit is reached before creating
 */
export async function checkCustomerLimit(req, res, next) {
  if (!req.messId || !req.planLimits) {
    return next();
  }

  try {
    const customerCount = await Customer.countDocuments({ 
      messId: req.messId,
      active: true 
    });

    if (customerCount >= req.planLimits.maxCustomers) {
      return next(new ApiError(
        `Customer limit reached (${req.planLimits.maxCustomers}). Please upgrade your plan.`,
        403,
        'CUSTOMER_LIMIT_REACHED'
      ));
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Check if staff limit is reached before creating
 */
export async function checkStaffLimit(req, res, next) {
  if (!req.messId || !req.planLimits) {
    return next();
  }

  try {
    const staffCount = await User.countDocuments({ 
      messId: req.messId,
      role: { $in: ['staff', 'admin'] },
      active: true 
    });

    if (staffCount >= req.planLimits.maxStaff) {
      return next(new ApiError(
        `Staff limit reached (${req.planLimits.maxStaff}). Please upgrade your plan.`,
        403,
        'STAFF_LIMIT_REACHED'
      ));
    }

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Check if feature is allowed by plan
 */
export function requireFeature(featureName) {
  return (req, res, next) => {
    if (!req.planLimits) {
      return next(new ApiError('Plan limits not loaded', 500, 'INTERNAL_ERROR'));
    }

    if (!req.planLimits[featureName]) {
      return next(new ApiError(
        `This feature is not available in your plan. Please upgrade.`,
        403,
        'FEATURE_NOT_AVAILABLE'
      ));
    }

    next();
  };
}
