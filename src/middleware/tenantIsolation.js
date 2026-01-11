import jwt from 'jsonwebtoken';
import { ApiError } from '../utils/errorHandler.js';
import { Mess } from '../models/Mess.js';

/**
 * Tenant Isolation Middleware
 * Extracts messId from JWT and enforces mess-level data isolation
 * 🔒 SINGLE SOURCE OF TRUTH - messId ONLY from JWT, never from request
 */
export function tenantIsolation(req, res, next) {
  // Skip for public routes
  const publicRoutes = ['/auth/signup', '/auth/login', '/auth/forgot-password', '/auth/verify-otp', '/auth/reset-password', '/auth/resend-otp', '/health', '/api/auth', '/api/auth-pin'];
  if (publicRoutes.some(route => req.path.startsWith(route))) {
    return next();
  }

  // Extract messId from JWT (set by requireAuth middleware)
  const messId = req.user?.messId;

  if (!messId) {
    // Skip if no user (will be handled by requireAuth)
    if (!req.user) {
      return next();
    }
    
    // 🔒 CRITICAL: No messId = No access
    return next(new ApiError('Tenant context missing', 403, 'NO_TENANT_CONTEXT'));
  }

  // 🔒 Attach messId to request - SINGLE SOURCE OF TRUTH
  req.messId = messId;
  req.tenantId = messId;

  next();
}

/**
 * Verify mess exists and is active
 */
export async function verifyMessAccess(req, res, next) {
  if (!req.messId) {
    return next();
  }

  try {
    const mess = await Mess.findById(req.messId);

    if (!mess) {
      return next(new ApiError('Mess not found', 404, 'MESS_NOT_FOUND'));
    }

    if (!mess.active) {
      return next(new ApiError('Mess account is inactive', 403, 'MESS_INACTIVE'));
    }

    // Check subscription status
    if (!mess.hasValidSubscription) {
      return next(new ApiError('Subscription expired', 402, 'SUBSCRIPTION_EXPIRED'));
    }

    // Attach mess to request
    req.mess = mess;

    next();
  } catch (error) {
    next(error);
  }
}

/**
 * Mongoose plugin to auto-inject messId in queries
 */
export function tenantPlugin(schema) {
  // Add messId field if not exists
  if (!schema.path('messId')) {
    schema.add({
      messId: {
        type: schema.constructor.Types.ObjectId,
        ref: 'Mess',
        required: true,
        index: true
      }
    });
  }

  // Auto-inject messId in find queries
  schema.pre(/^find/, function() {
    if (this.options._skipTenantFilter) {
      return;
    }
    
    const messId = this.options.messId || this.getQuery().messId;
    if (messId) {
      this.where({ messId });
    }
  });

  // Auto-inject messId in aggregation
  schema.pre('aggregate', function() {
    if (this.options._skipTenantFilter) {
      return;
    }

    const messId = this.options.messId;
    if (messId) {
      this.pipeline().unshift({ $match: { messId } });
    }
  });
}

/**
 * Helper to create tenant-scoped model methods
 */
export function createTenantModel(Model) {
  return {
    find: (messId, query = {}, options = {}) => {
      return Model.find({ ...query, messId }, null, options);
    },
    
    findOne: (messId, query = {}, options = {}) => {
      return Model.findOne({ ...query, messId }, null, options);
    },
    
    findById: (messId, id, options = {}) => {
      return Model.findOne({ _id: id, messId }, null, options);
    },
    
    create: (messId, data) => {
      return Model.create({ ...data, messId });
    },
    
    updateOne: (messId, query, update, options = {}) => {
      return Model.updateOne({ ...query, messId }, update, options);
    },
    
    updateMany: (messId, query, update, options = {}) => {
      return Model.updateMany({ ...query, messId }, update, options);
    },
    
    deleteOne: (messId, query, options = {}) => {
      return Model.deleteOne({ ...query, messId }, options);
    },
    
    deleteMany: (messId, query, options = {}) => {
      return Model.deleteMany({ ...query, messId }, options);
    },
    
    countDocuments: (messId, query = {}) => {
      return Model.countDocuments({ ...query, messId });
    },
    
    aggregate: (messId, pipeline) => {
      return Model.aggregate([
        { $match: { messId } },
        ...pipeline
      ]);
    }
  };
}
