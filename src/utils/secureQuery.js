/**
 * Secure Query Helpers - Enforce Multi-Tenant Isolation
 * 
 * These helpers automatically inject messId into all queries
 * to prevent cross-tenant data leakage.
 */

import { ApiError } from './errorHandler.js';

/**
 * Secure find - Always includes messId filter
 */
export function secureFind(Model, req, filter = {}, options = {}) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.find({ ...filter, messId: req.messId }, null, options);
}

/**
 * Secure findOne - Always includes messId filter
 */
export function secureFindOne(Model, req, filter = {}) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.findOne({ ...filter, messId: req.messId });
}

/**
 * Secure findById - Includes messId verification
 */
export function secureFindById(Model, req, id) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.findOne({ _id: id, messId: req.messId });
}

/**
 * Secure count - Always includes messId filter
 */
export function secureCount(Model, req, filter = {}) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.countDocuments({ ...filter, messId: req.messId });
}

/**
 * Secure update - Always includes messId filter
 */
export function secureUpdateOne(Model, req, filter, update, options = {}) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.updateOne({ ...filter, messId: req.messId }, update, options);
}

/**
 * Secure updateMany - Always includes messId filter
 */
export function secureUpdateMany(Model, req, filter, update, options = {}) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.updateMany({ ...filter, messId: req.messId }, update, options);
}

/**
 * Secure delete - Always includes messId filter
 */
export function secureDeleteOne(Model, req, filter) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.deleteOne({ ...filter, messId: req.messId });
}

/**
 * Secure deleteMany - Always includes messId filter
 */
export function secureDeleteMany(Model, req, filter) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.deleteMany({ ...filter, messId: req.messId });
}

/**
 * Secure aggregate - Injects $match stage with messId
 */
export function secureAggregate(Model, req, pipeline = []) {
  if (!req.messId) {
    throw new ApiError('messId required for query', 500, 'MISSING_MESS_ID');
  }
  return Model.aggregate([
    { $match: { messId: req.messId } },
    ...pipeline
  ]);
}

/**
 * Secure create - Automatically adds messId
 */
export function secureCreate(Model, req, data) {
  if (!req.messId) {
    throw new ApiError('messId required for create', 500, 'MISSING_MESS_ID');
  }
  
  if (Array.isArray(data)) {
    return Model.create(data.map(item => ({ ...item, messId: req.messId })));
  }
  
  return Model.create({ ...data, messId: req.messId });
}

export default {
  find: secureFind,
  findOne: secureFindOne,
  findById: secureFindById,
  count: secureCount,
  updateOne: secureUpdateOne,
  updateMany: secureUpdateMany,
  deleteOne: secureDeleteOne,
  deleteMany: secureDeleteMany,
  aggregate: secureAggregate,
  create: secureCreate
};
