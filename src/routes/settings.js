import express from 'express';
import { Settings } from '../models/Settings.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /settings
 * Get system settings
 */
const getSettingsHandler = asyncHandler(async (req, res) => {
  let settings = await Settings.findOne({ messId: req.messId });
  
  // Create default settings if none exist
  if (!settings) {
    settings = await Settings.create({
      messId: req.messId,
      mealWindows: {
        breakfast: { start: '07:00', end: '10:00' },
        lunch: { start: '12:00', end: '15:00' },
        dinner: { start: '19:00', end: '22:00' }
      }
    });
  }

  // Map to frontend format
  const response = {
    mealTimings: settings.mealWindows,
    maxLoginAttempts: settings.pinSettings?.maxAttempts || 5,
    lockoutDuration: settings.pinSettings?.lockoutMinutes || 30,
    pinLength: 4,
    requirePinChange: true,
    qrExpiryMinutes: settings.qrSettings?.expiryMinutes || 2,
    allowOfflineScanning: settings.features?.offlineScanning ?? true,
    lowMealAlert: settings.notifications?.lowMealsAlert ?? true,
    lowMealThreshold: settings.alertThresholdMealsRemaining || 5,
    expiryAlert: settings.notifications?.subscriptionExpiry ?? true,
    expiryAlertDays: 3
  };

  res.json(successResponse({ settings: response }, 'Settings retrieved successfully'));
});

/**
 * PUT /settings
 * Update system settings
 */
const updateSettingsHandler = asyncHandler(async (req, res) => {
  const updates = req.body;

  let settings = await Settings.findOne({ messId: req.messId });
  
  if (!settings) {
    settings = await Settings.create({ messId: req.messId });
  }

  // Map frontend format to backend schema
  if (updates.mealTimings) {
    settings.mealWindows = updates.mealTimings;
  }
  if (updates.maxLoginAttempts !== undefined) {
    settings.pinSettings.maxAttempts = updates.maxLoginAttempts;
  }
  if (updates.lockoutDuration !== undefined) {
    settings.pinSettings.lockoutMinutes = updates.lockoutDuration;
  }
  if (updates.qrExpiryMinutes !== undefined) {
    settings.qrSettings.expiryMinutes = updates.qrExpiryMinutes;
  }
  if (updates.allowOfflineScanning !== undefined) {
    settings.features.offlineScanning = updates.allowOfflineScanning;
  }
  if (updates.lowMealAlert !== undefined) {
    settings.notifications.lowMealsAlert = updates.lowMealAlert;
  }
  if (updates.lowMealThreshold !== undefined) {
    settings.alertThresholdMealsRemaining = updates.lowMealThreshold;
  }
  if (updates.expiryAlert !== undefined) {
    settings.notifications.subscriptionExpiry = updates.expiryAlert;
  }

  settings.lastUpdatedBy = req.user.sub || req.user.id;
  await settings.save();

  await AuditLog.create({
    messId: req.messId,
    action: 'settings_updated',
    userId: req.user.sub || req.user.id,
    targetId: settings._id,
    targetType: 'Settings',
    details: { updates },
    ipAddress: req.ip
  });

  res.json(successResponse({ settings }, 'Settings updated successfully'));
});

// Apply role-based access control
router.use(requireRole(['admin']));

// Routes
router.get('/', getSettingsHandler);
router.put('/', updateSettingsHandler);

export default router;
