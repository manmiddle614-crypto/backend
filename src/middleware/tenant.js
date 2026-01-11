import { ApiError } from '../utils/errorHandler.js';
import { Mess } from '../models/Mess.js';

/**
 * Tenant isolation middleware
 * Extracts messId from JWT and injects into request context
 */
export const resolveTenant = async (req, res, next) => {
  try {
    // Extract messId from JWT (set by auth middleware)
    const messId = req.user?.messId;
    
    if (!messId) {
      throw new ApiError('Tenant context missing', 403, 'TENANT_REQUIRED');
    }

    // Verify mess exists and is active
    const mess = await Mess.findOne({ _id: messId, active: true }).lean();
    if (!mess) {
      throw new ApiError('Invalid or inactive tenant', 403, 'INVALID_TENANT');
    }

    // Inject tenant context into request
    req.messId = messId;
    req.mess = mess;
    
    next();
  } catch (error) {
    next(error);
  }
};

/**
 * Helper to build tenant-scoped query
 */
export const tenantQuery = (req, additionalFilters = {}) => {
  return { messId: req.messId, ...additionalFilters };
};

/**
 * Middleware to ensure data includes messId before save
 */
export const enforceTenantOnSave = (schema) => {
  schema.pre('save', function(next) {
    if (this.isNew && !this.messId) {
      return next(new Error('messId is required'));
    }
    next();
  });
};
