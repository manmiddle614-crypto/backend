import express from 'express';
import { Mess } from '../models/Mess.js';
import { Customer } from '../models/Customer.js';
import { Plan } from '../models/Plan.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { Settings } from '../models/Settings.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { successResponse } from '../utils/response.js';
import { ApiError } from '../utils/errorHandler.js';

const router = express.Router();

/**
 * GET /api/onboarding/status
 * Get onboarding checklist status
 */
router.get('/status', requireAuth, requireAdmin, resolveTenant, asyncHandler(async (req, res) => {
  const mess = await Mess.findById(req.messId);
  if (!mess) throw new ApiError('Mess not found', 404);

  // Auto-check steps based on actual data
  const [customerCount, planCount, scanCount, settings] = await Promise.all([
    Customer.countDocuments({ messId: req.messId }),
    Plan.countDocuments({ messId: req.messId }),
    MealTransaction.countDocuments({ messId: req.messId }),
    Settings.findOne({ messId: req.messId })
  ]);

  const steps = {
    profileSetup: mess.onboarding?.steps?.profileSetup || !!(mess.phone && mess.email),
    firstPlan: mess.onboarding?.steps?.firstPlan || planCount > 0,
    firstCustomer: mess.onboarding?.steps?.firstCustomer || customerCount > 0,
    firstScan: mess.onboarding?.steps?.firstScan || scanCount > 0,
    paymentSetup: mess.onboarding?.steps?.paymentSetup || !!(settings?.razorpayKeyId)
  };

  const totalSteps = Object.keys(steps).length;
  const completedSteps = Object.values(steps).filter(Boolean).length;
  const progress = Math.round((completedSteps / totalSteps) * 100);
  const allComplete = completedSteps === totalSteps;

  // Auto-complete if all done
  if (allComplete && !mess.onboarding?.completed) {
    mess.onboarding = mess.onboarding || {};
    mess.onboarding.completed = true;
    mess.onboarding.completedAt = new Date();
    mess.onboarding.steps = steps;
    await mess.save();
  }

  res.json(successResponse({
    completed: allComplete,
    progress,
    completedSteps,
    totalSteps,
    steps,
    completedAt: mess.onboarding?.completedAt
  }));
}));

/**
 * PATCH /api/onboarding/complete/:step
 * Manually mark a step as complete
 */
router.patch('/complete/:step', requireAuth, requireAdmin, resolveTenant, asyncHandler(async (req, res) => {
  const { step } = req.params;
  const validSteps = ['profileSetup', 'firstPlan', 'firstCustomer', 'firstScan', 'paymentSetup'];
  
  if (!validSteps.includes(step)) {
    throw new ApiError('Invalid step', 400);
  }

  const mess = await Mess.findById(req.messId);
  if (!mess) throw new ApiError('Mess not found', 404);

  mess.onboarding = mess.onboarding || { steps: {} };
  mess.onboarding.steps = mess.onboarding.steps || {};
  mess.onboarding.steps[step] = true;

  await mess.save();

  res.json(successResponse({ step, completed: true }, 'Step marked complete'));
}));

/**
 * POST /api/onboarding/dismiss
 * Dismiss onboarding (mark as completed without finishing)
 */
router.post('/dismiss', requireAuth, requireAdmin, resolveTenant, asyncHandler(async (req, res) => {
  const mess = await Mess.findById(req.messId);
  if (!mess) throw new ApiError('Mess not found', 404);

  mess.onboarding = mess.onboarding || {};
  mess.onboarding.completed = true;
  mess.onboarding.completedAt = new Date();
  await mess.save();

  res.json(successResponse({ dismissed: true }));
}));

export default router;
