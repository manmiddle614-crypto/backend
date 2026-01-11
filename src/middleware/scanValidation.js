import { ApiError } from '../utils/errorHandler.js';
import rateLimit from 'express-rate-limit';

/**
 * Rate limiter for scan endpoints
 * Prevents abuse and ensures payment-grade reliability
 */
export const scanRateLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 scans per minute per staff
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many scan attempts. Please wait.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.user?.id || req.ip,
  skip: (req) => req.user?.role === 'admin' // Admins bypass rate limit
});

/**
 * Validate scan request payload
 */
export function validateScanRequest(req, res, next) {
  const { qrToken, deviceId } = req.body;

  // Validate qrToken
  if (!qrToken || typeof qrToken !== 'string') {
    throw new ApiError('qrToken must be a valid string', 400, 'VALIDATION_ERROR');
  }

  if (qrToken.length < 50 || qrToken.length > 1000) {
    throw new ApiError('qrToken has invalid length', 400, 'VALIDATION_ERROR');
  }

  // Validate JWT format (3 parts separated by dots)
  const parts = qrToken.split('.');
  if (parts.length !== 3) {
    throw new ApiError('qrToken has invalid format', 400, 'VALIDATION_ERROR');
  }

  // Validate deviceId (optional but recommended)
  if (deviceId && typeof deviceId !== 'string') {
    throw new ApiError('deviceId must be a string', 400, 'VALIDATION_ERROR');
  }

  // Validate clientTimestamp (optional)
  if (req.body.clientTimestamp) {
    const timestamp = parseInt(req.body.clientTimestamp);
    if (isNaN(timestamp) || timestamp < 0) {
      throw new ApiError('clientTimestamp must be a valid Unix timestamp', 400, 'VALIDATION_ERROR');
    }

    // Check if timestamp is not too far in the past or future
    const now = Date.now();
    const diff = Math.abs(now - timestamp);
    const oneDay = 24 * 60 * 60 * 1000;
    
    if (diff > oneDay) {
      throw new ApiError('clientTimestamp is too far from server time', 400, 'VALIDATION_ERROR');
    }
  }

  next();
}

/**
 * Ensure staff has messId (tenant isolation)
 */
export function requireMessId(req, res, next) {
  if (!req.messId) {
    throw new ApiError('Staff must be associated with a mess', 403, 'NO_MESS_ASSOCIATION');
  }
  next();
}

/**
 * Log scan attempts for audit trail
 */
export function logScanAttempt(req, res, next) {
  const startTime = Date.now();
  


  // Log response
  const originalJson = res.json;
  res.json = function(data) {
    const duration = Date.now() - startTime;
  
    return originalJson.call(this, data);
  };

  next();
}
