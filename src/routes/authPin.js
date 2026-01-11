import express from 'express';
import jwt from 'jsonwebtoken';
import rateLimit from 'express-rate-limit';
import { Customer } from '../models/Customer.js';
import { AuditLog } from '../models/AuditLog.js';
import { 
  normalizePhone, 
  verifyPin, 
  hashPin, 
  validatePin, 
  generateDeviceToken, 
  hashDeviceToken 
} from '../utils/pinHelper.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const PIN_MAX_ATTEMPTS = parseInt(process.env.PIN_MAX_ATTEMPTS) || 5;
const PIN_LOCK_MINUTES = parseInt(process.env.PIN_LOCK_MINUTES) || 30;
const DEVICE_TOKEN_EXPIRY_DAYS = parseInt(process.env.DEVICE_TOKEN_EXPIRY_DAYS) || 365;

// Rate limiting
const loginRateLimit = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 attempts per IP
  message: { success: false, error: 'rate_limited', message: 'Too many login attempts' },
  standardHeaders: true,
  legacyHeaders: false,
});

const phoneRateLimit = new Map();

function checkPhoneRateLimit(phone) {
  const now = Date.now();
  const key = phone;
  const attempts = phoneRateLimit.get(key) || [];
  
  // Clean old attempts (older than 15 minutes)
  const validAttempts = attempts.filter(time => now - time < 15 * 60 * 1000);
  
  if (validAttempts.length >= 5) {
    throw new ApiError('Too many attempts for this phone', 429, 'PHONE_RATE_LIMITED');
  }
  
  validAttempts.push(now);
  phoneRateLimit.set(key, validAttempts);
}

const loginPinHandler = asyncHandler(async (req, res) => {
  const { phone, pin, deviceName } = req.body;
  
  if (!phone || !pin) {
    throw new ApiError('Phone and PIN required', 400, 'VALIDATION_ERROR');
  }

  const normalizedPhone = normalizePhone(phone);

  checkPhoneRateLimit(normalizedPhone);

  const customer = await Customer.findOne({ phone: normalizedPhone, active: true });
  if (!customer) {

    throw new ApiError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
  }

  // Check if account is locked
  if (customer.pinLockedUntil && new Date() < customer.pinLockedUntil) {
    await AuditLog.create({
      messId: customer.messId,
      action: 'pin_login_blocked',
      targetId: customer._id,
      targetType: 'Customer',
      details: { phone: normalizedPhone, reason: 'account_locked' },
      ipAddress: req.ip
    });
    
    throw new ApiError('Account locked', 423, 'ACCOUNT_LOCKED', {
      unlockAt: customer.pinLockedUntil
    });
  }

  // Verify PIN
  const isValidPin = await verifyPin(pin, customer.pinHash);
  
  if (!isValidPin) {
    customer.pinFailedAttempts += 1;
    
    if (customer.pinFailedAttempts >= PIN_MAX_ATTEMPTS) {
      customer.pinLockedUntil = new Date(Date.now() + PIN_LOCK_MINUTES * 60 * 1000);
    }
    
    await customer.save();
    
    await AuditLog.create({
      messId: customer.messId,
      action: 'pin_login_failed',
      targetId: customer._id,
      targetType: 'Customer',
      details: { 
        phone: normalizedPhone, 
        attempts: customer.pinFailedAttempts,
        locked: customer.pinFailedAttempts >= PIN_MAX_ATTEMPTS
      },
      ipAddress: req.ip
    });
    
    throw new ApiError('Invalid PIN', 401, 'INVALID_PIN');
  }

  // Reset failed attempts and lock
  customer.pinFailedAttempts = 0;
  customer.pinLockedUntil = null;
  
  // Handle trusted device
  let deviceToken = null;
  if (deviceName) {
    deviceToken = generateDeviceToken();
    const tokenHash = await hashDeviceToken(deviceToken);
    
    customer.trustedDevices.push({
      tokenHash,
      name: deviceName,
      createdAt: new Date()
    });
  }
  
  await customer.save();

  // Create JWT
  const token = jwt.sign(
    { sub: customer._id, role: 'customer', messId: customer.messId },
    process.env.JWT_SECRET,
    { expiresIn: '24h' } // 🔒 BLOCKER 4: Reduced from 7d to 24h
  );

  // Set device cookie if requested
  if (deviceToken) {
    res.cookie('device_token', deviceToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      maxAge: DEVICE_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    });
  }

  await AuditLog.create({
    messId: customer.messId,
    action: 'pin_login_success',
    targetId: customer._id,
    targetType: 'Customer',
    details: { 
      phone: normalizedPhone,
      deviceName: deviceName || null
    },
    ipAddress: req.ip
  });

  res.json(successResponse({
    token,
    requirePinChange: customer.pinChangedAt === null,
    user: {
      id: customer._id,
      phone: customer.phone,
      name: customer.name,
      role: 'customer'
    }
  }, 'Login successful'));
});

const changePinHandler = asyncHandler(async (req, res) => {
  const { oldPin, newPin } = req.body;
  
  if (!newPin || !validatePin(newPin)) {
    throw new ApiError('New PIN must be 4-6 digits', 400, 'INVALID_PIN');
  }

  const customer = await Customer.findById(req.user.sub);
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Verify old PIN if not first-time change
  if (customer.pinChangedAt !== null) {
    if (!oldPin) {
      throw new ApiError('Old PIN required', 400, 'OLD_PIN_REQUIRED');
    }
    
    const isValidOldPin = await verifyPin(oldPin, customer.pinHash);
    if (!isValidOldPin) {
      throw new ApiError('Invalid old PIN', 401, 'INVALID_OLD_PIN');
    }
  }

  const newPinHash = await hashPin(newPin);
  
  customer.pinHash = newPinHash;
  customer.pinChangedAt = new Date();
  customer.pinFailedAttempts = 0;
  customer.pinLockedUntil = null;
  await customer.save();

  await AuditLog.create({
    messId: customer.messId,
    action: 'pin_changed',
    targetId: customer._id,
    targetType: 'Customer',
    details: { 
      customerId: customer._id,
      firstTimeChange: customer.pinChangedAt === null
    },
    ipAddress: req.ip
  });

  res.json(successResponse({}, 'PIN changed successfully'));
});

const logoutHandler = asyncHandler(async (req, res) => {
  const deviceToken = req.cookies?.device_token;
  
  if (deviceToken && req.user?.sub) {
    const customer = await Customer.findById(req.user.sub);
    if (customer) {
      // Remove trusted device
      customer.trustedDevices = customer.trustedDevices.filter(async (device) => {
        const matches = await verifyPin(deviceToken, device.tokenHash);
        return !matches;
      });
      await customer.save();
    }
  }

  // Clear device token cookie
  res.clearCookie('device_token');

  await AuditLog.create({
    messId: req.user?.messId || customer.messId,
    action: 'logout',
    targetId: req.user?.sub || null,
    targetType: 'Customer',
    details: { deviceTokenPresent: !!deviceToken },
    ipAddress: req.ip
  });

  res.json(successResponse({}, 'Logged out successfully'));
});

router.post('/login-pin', loginRateLimit, loginPinHandler);
router.post('/verify', loginRateLimit, loginPinHandler); // Alias for compatibility
router.post('/change-pin', requireAuth, changePinHandler);
router.post('/logout', logoutHandler);

export default router;