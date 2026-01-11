import rateLimit from 'express-rate-limit';

// Aggressive rate limiting for authentication endpoints
export const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 20, // 20 attempts per window
  message: {
    success: false,
    error: {
      code: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many login attempts. Please try again in 15 minutes.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true // Don't count successful logins
});

// Moderate rate limiting for PIN login (more strict)
export const pinLoginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3, // Only 3 PIN attempts per 15 minutes
  message: {
    success: false,
    error: {
      code: 'PIN_RATE_LIMIT_EXCEEDED',
      message: 'Too many PIN attempts. Account temporarily locked.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Scan endpoint rate limiting
export const scanLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 60, // 60 scans per minute per IP
  message: {
    success: false,
    error: {
      code: 'SCAN_RATE_LIMIT',
      message: 'Too many scan attempts. Please slow down.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.sub || req.ip
});

// General API rate limiting
export const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: {
      code: 'API_RATE_LIMIT',
      message: 'Too many requests. Please try again later.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Payment webhook rate limiting (prevent abuse)
export const webhookLimiter = rateLimit({
  windowMs: 1 * 60 * 1000,
  max: 10, // 10 webhooks per minute
  message: {
    success: false,
    error: {
      code: 'WEBHOOK_RATE_LIMIT',
      message: 'Too many webhook requests'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});

// Analytics and reports rate limiting
export const analyticsLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: {
    success: false,
    error: {
      code: 'ANALYTICS_RATE_LIMIT',
      message: 'Too many analytics requests. Please try again later.'
    }
  },
  standardHeaders: true,
  legacyHeaders: false
});
