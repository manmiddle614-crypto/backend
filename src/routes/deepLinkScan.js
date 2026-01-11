import express from 'express';
import { deepLinkService } from '../services/deepLinkService.js';
import { scanService } from '../services/scanService.js';
import { Customer } from '../models/Customer.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// Store used nonces (in-memory, use Redis in production)
const usedNonces = new Map();

// Clean up expired nonces every 10 minutes
setInterval(() => {
  const now = Date.now();
  for (const [nonce, timestamp] of usedNonces.entries()) {
    if (now - timestamp > 10 * 60 * 1000) {
      usedNonces.delete(nonce);
    }
  }
}, 10 * 60 * 1000);

/**
 * POST /api/deep-link/generate
 * Generate deep-link for customer QR
 */
router.post('/generate', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const { customerId, expiryMinutes = 3 } = req.body;

  if (!customerId) {
    throw new ApiError('Customer ID required', 400, 'VALIDATION_ERROR');
  }

  if (expiryMinutes < 1 || expiryMinutes > 5) {
    throw new ApiError('Expiry must be 1-5 minutes', 400, 'INVALID_EXPIRY');
  }

  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  const deepLink = deepLinkService.generateDeepLink(
    customer._id.toString(),
    customer.messId.toString(),
    expiryMinutes
  );

  res.json(successResponse({ 
    deepLink,
    expiresIn: `${expiryMinutes} minutes`,
    customer: {
      id: customer._id,
      name: customer.name,
      roomNo: customer.roomNo
    }
  }));
}));

/**
 * GET /api/deep-link/verify
 * Verify deep-link token and return customer info
 */
router.get('/verify', asyncHandler(async (req, res) => {
  const { token } = req.query;

  if (!token) {
    throw new ApiError('Token required', 400, 'VALIDATION_ERROR');
  }

  // Verify token
  const tokenData = deepLinkService.verifyDeepLink(token);

  // Check if nonce already used (replay attack prevention)
  if (usedNonces.has(tokenData.nonce)) {
    throw new ApiError('Link already used', 400, 'LINK_USED');
  }

  // Get customer info
  const customer = await Customer.findById(tokenData.customerId)
    .select('name phone roomNo messId')
    .lean();

  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  res.json(successResponse({
    customer: {
      id: customer._id,
      name: customer.name,
      phone: customer.phone,
      roomNo: customer.roomNo
    },
    messId: tokenData.messId,
    token,
    expiresAt: new Date((tokenData.issuedAt + 180) * 1000) // 3 min default
  }));
}));

/**
 * POST /api/deep-link/confirm
 * Staff confirms scan and deducts meal
 */
router.post('/confirm', requireAuth, requireRole(['admin', 'staff']), asyncHandler(async (req, res) => {
  const { token } = req.body;

  if (!token) {
    throw new ApiError('Token required', 400, 'VALIDATION_ERROR');
  }

  // Verify token again
  const tokenData = deepLinkService.verifyDeepLink(token);

  // Check if nonce already used
  if (usedNonces.has(tokenData.nonce)) {
    throw new ApiError('Link already used', 400, 'LINK_USED');
  }

  // Mark nonce as used
  usedNonces.set(tokenData.nonce, Date.now());

  // Verify mess ownership
  if (tokenData.messId !== req.messId.toString()) {
    throw new ApiError('Link belongs to different mess', 403, 'WRONG_MESS');
  }

  // Process scan using existing service
  const result = await scanService.processScan(
    token,
    req.user.sub || req.user.id,
    {
      messId: req.messId,
      scannerRole: req.user.role,
      ipAddress: req.ip,
      deepLink: true
    }
  );

  res.json(successResponse(result, 'Meal deducted successfully'));
}));

export default router;
