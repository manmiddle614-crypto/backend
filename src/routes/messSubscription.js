import express from 'express';
import crypto from 'crypto';
import getRazorpayInstance, { createOrder, verifyPaymentSignature } from '../services/razorpay.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { Mess } from '../models/Mess.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPlanPermissions, getGracePeriodPermissions } from '../config/planPermissions.js';
import { calculateSubscriptionMeta } from '../utils/subscriptionStatus.js';

const router = express.Router();

// Fixed pricing - NEVER trust frontend
const PRICING = {
  standard: {
    monthly: 999,
    yearly: 9999
  }
};

/**
 * GET /api/mess-subscription
 * Get current subscription
 */
router.get('/', requireAuth, asyncHandler(async (req, res) => {
  const subscription = await MessSubscription.findOne({ messId: req.messId });
  
  if (!subscription) {
    return res.json(successResponse({
      subscription: null,
      message: 'No subscription found'
    }));
  }

  res.json(successResponse({
    subscription: {
      status: subscription.status,
      plan: subscription.planName,
      planName: subscription.planName,
      price: subscription.price,
      billingCycle: subscription.billingCycle,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      trialEndsAt: subscription.trialEndsAt,
      daysRemaining: subscription.daysRemaining,
      isActive: subscription.isActive,
      isInGracePeriod: subscription.isInGracePeriod,
      nextBillingDate: subscription.nextBillingDate,
      autoRenew: subscription.autoRenew
    }
  }));
}));

/**
 * GET /api/mess-subscription/status
 * Get current subscription status
 */
router.get('/status', requireAuth, asyncHandler(async (req, res) => {
  const subscription = await MessSubscription.findOne({ messId: req.messId });
  
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  // Calculate subscription meta (single source of truth)
  const meta = calculateSubscriptionMeta(subscription);

  // Get permissions based on actual status
  const permissions = meta.isGrace 
    ? getGracePeriodPermissions() 
    : getPlanPermissions(subscription.planName);

  res.json(successResponse({
    subscription: {
      status: subscription.status,
      planName: subscription.planName,
      price: subscription.price,
      billingCycle: subscription.billingCycle,
      startDate: subscription.startDate,
      endDate: subscription.endDate,
      trialEndsAt: subscription.trialEndsAt,
      nextBillingDate: subscription.nextBillingDate,
      autoRenew: subscription.autoRenew
    },
    permissions,
    meta
  }));
}));

/**
 * POST /api/mess-subscription/start-trial
 * Start free trial
 */
router.post('/start-trial', requireAuth, asyncHandler(async (req, res) => {
  let subscription = await MessSubscription.findOne({ messId: req.messId });
  
  if (subscription && subscription.status !== 'EXPIRED') {
    throw new ApiError('Subscription already exists', 400, 'ALREADY_EXISTS');
  }

  // Create or update subscription with trial
  if (!subscription) {
    subscription = new MessSubscription({
      messId: req.messId,
      planName: 'TRIAL',
      status: 'TRIAL',
      billingCycle: 'monthly',
      price: 0
    });
  }

  const trialDays = 14;
  subscription.startDate = new Date();
  subscription.trialEndsAt = new Date(Date.now() + trialDays * 24 * 60 * 60 * 1000);
  subscription.endDate = subscription.trialEndsAt;
  subscription.status = 'TRIAL';
  
  await subscription.save();

  // Update mess
  await Mess.findByIdAndUpdate(req.messId, {
    subscriptionStatus: 'trial',
    subscriptionEndsAt: subscription.endDate
  });

  await AuditLog.create({
    messId: req.messId,
    action: 'trial_started',
    userId: req.user.sub,
    targetId: subscription._id,
    targetType: 'MessSubscription',
    ipAddress: req.ip
  });

  res.json(successResponse({
    message: 'Trial started successfully',
    subscription: {
      status: subscription.status,
      endDate: subscription.endDate
    }
  }));
}));

/**
 * POST /api/mess-subscription/create-order
 * Create Razorpay order for subscription payment
 */
router.post('/create-order', requireAuth, asyncHandler(async (req, res) => {
  const { billingCycle = 'monthly' } = req.body;

  // Get subscription
  const subscription = await MessSubscription.findOne({ messId: req.messId });
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  // Get mess details
  const mess = await Mess.findById(req.messId);
  if (!mess) {
    throw new ApiError('Mess not found', 404, 'NOT_FOUND');
  }

  // Validate billing cycle
  if (!['monthly', '6month', 'yearly'].includes(billingCycle)) {
    throw new ApiError('Invalid billing cycle. Use: monthly, 6month, or yearly', 400, 'INVALID_BILLING_CYCLE');
  }

  // Get price from backend (NEVER trust frontend)
  const PRICING = {
    standard: {
      monthly: 999,
      '6month': 5499,
      yearly: 9999
    }
  };
  
  const amount = PRICING.standard[billingCycle];
  if (!amount) {
    throw new ApiError('Invalid billing cycle', 400, 'INVALID_BILLING_CYCLE');
  }

  try {
    // Create Razorpay order (receipt max 40 chars)
    const order = await createOrder(
      amount,
      'INR',
      `sub_${Date.now()}`,
      {
        messId: req.messId.toString(),
        subscriptionId: subscription._id.toString(),
        planName: 'STANDARD',
        billingCycle
      }
    );

    // Save order ID (don't modify planName if already set correctly)
    subscription.razorpayOrderId = order.id;
    subscription.billingCycle = billingCycle;
    subscription.price = amount;
    // Only update planName if it's not already uppercase
    if (!['BASIC', 'STANDARD', 'PRO', 'TRIAL'].includes(subscription.planName)) {
      subscription.planName = 'STANDARD';
    }
    await subscription.save();

    // Audit log
    await AuditLog.create({
      messId: req.messId,
      action: 'subscription_order_created',
      userId: req.user.sub,
      targetId: subscription._id,
      targetType: 'MessSubscription',
      details: {
        orderId: order.id,
        amount,
        billingCycle
      },
      ipAddress: req.ip
    });

    res.json(successResponse({
      orderId: order.id,
      amount,
      currency: 'INR',
      keyId: process.env.RAZORPAY_KEY_ID,
      messName: mess.name,
      ownerEmail: mess.ownerEmail,
      ownerPhone: mess.ownerPhone
    }));
  } catch (error) {

    throw new ApiError(
      error.message || 'Failed to create payment order',
      400,
      'PAYMENT_ORDER_FAILED'
    );
  }
}));

/**
 * POST /api/mess-subscription/verify-payment
 * Verify Razorpay payment signature (called by frontend after payment)
 */
router.post('/verify-payment', requireAuth, asyncHandler(async (req, res) => {
  const { razorpay_order_id, razorpay_payment_id, razorpay_signature } = req.body;

  if (!razorpay_order_id || !razorpay_payment_id || !razorpay_signature) {
    throw new ApiError('Missing payment details', 400, 'INVALID_PAYMENT');
  }

  // Verify signature
  const body = razorpay_order_id + '|' + razorpay_payment_id;
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(body)
    .digest('hex');

  if (expectedSignature !== razorpay_signature) {
    throw new ApiError('Invalid payment signature', 400, 'INVALID_SIGNATURE');
  }

  // Find subscription
  const subscription = await MessSubscription.findOne({ 
    messId: req.messId,
    razorpayOrderId: razorpay_order_id
  });

  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  // IDEMPOTENCY CHECK: Prevent double activation
  if (subscription.razorpayPaymentId === razorpay_payment_id) {
    logger.info('✅ Payment already processed (idempotency)', { paymentId: razorpay_payment_id });
    return res.json(successResponse({
      message: 'Payment already processed',
      subscription: {
        status: subscription.status,
        planName: subscription.planName,
        endDate: subscription.endDate
      },
      alreadyProcessed: true
    }));
  }

  // 🔒 BLOCKER 2: VERIFY PAYMENT AMOUNT (prevent partial payment fraud)
  const expectedAmount = PRICING.standard[subscription.billingCycle];
  
  // Fetch actual payment details from Razorpay
  try {
    const razorpay = getRazorpayInstance();
    const payment = await razorpay.payments.fetch(razorpay_payment_id);
    
    const actualAmount = payment.amount / 100; // Convert paise to rupees
    
    if (actualAmount !== expectedAmount) {
      logger.error('❌ Payment amount mismatch', {
        expected: expectedAmount,
        actual: actualAmount,
        paymentId: razorpay_payment_id
      });
      throw new ApiError(
        `Payment amount mismatch. Expected ₹${expectedAmount}, got ₹${actualAmount}`,
        400,
        'AMOUNT_MISMATCH'
      );
    }
    
    if (payment.status !== 'captured') {
      throw new ApiError('Payment not captured', 400, 'PAYMENT_NOT_CAPTURED');
    }
  } catch (error) {
    if (error instanceof ApiError) throw error;
    logger.error('❌ Failed to verify payment', { error: error.message });
    throw new ApiError('Failed to verify payment with Razorpay', 500, 'VERIFICATION_FAILED');
  }

  // Activate subscription
  await subscription.activateSubscription({
    razorpayPaymentId: razorpay_payment_id,
    razorpaySignature: razorpay_signature
  });

  // Update mess status
  await Mess.findByIdAndUpdate(req.messId, {
    subscriptionStatus: 'active',
    subscriptionEndsAt: subscription.endDate
  });

  // Audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_activated',
    userId: req.user.sub,
    targetId: subscription._id,
    targetType: 'MessSubscription',
    details: {
      paymentId: razorpay_payment_id,
      orderId: razorpay_order_id
    },
    ipAddress: req.ip
  });

  res.json(successResponse({
    message: 'Subscription activated successfully',
    subscription: {
      status: subscription.status,
      planName: subscription.planName,
      endDate: subscription.endDate,
      nextBillingDate: subscription.nextBillingDate
    },
    refreshRequired: true
  }));
}));

/**
 * POST /webhooks/razorpay
 * Razorpay webhook handler (NO AUTH - verified by signature)
 */
router.post('/webhooks/razorpay', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
  // CRITICAL: Fail fast if webhook secret not configured
  if (!process.env.RAZORPAY_WEBHOOK_SECRET) {

    return res.status(500).json({ error: 'Webhook not configured' });
  }

  const signature = req.headers['x-razorpay-signature'];
  
  if (!signature) {

    return res.status(400).json({ error: 'Missing signature' });
  }

  // Verify webhook signature
  const expectedSignature = crypto
    .createHmac('sha256', process.env.RAZORPAY_WEBHOOK_SECRET)
    .update(req.body)
    .digest('hex');

  if (signature !== expectedSignature) {

    return res.status(400).json({ error: 'Invalid signature' });
  }

  const event = JSON.parse(req.body.toString());

  // Handle payment.captured event
  if (event.event === 'payment.captured') {
    const payment = event.payload.payment.entity;
    const orderId = payment.order_id;
    const paymentId = payment.id;

    // Find subscription by order ID
    const subscription = await MessSubscription.findOne({ razorpayOrderId: orderId });
    
    if (!subscription) {

      return res.status(404).json({ error: 'Subscription not found' });
    }

    // IDEMPOTENCY: Check if already processed
    if (subscription.razorpayPaymentId === paymentId) {

      return res.json({ status: 'ok', message: 'Already processed' });
    }

    // VERIFY PAYMENT AMOUNT (prevent partial payment fraud)
    const expectedAmount = PRICING.standard[subscription.billingCycle] * 100; // Razorpay uses paise
    if (payment.amount !== expectedAmount) {
      console.error('❌ Payment amount mismatch:', {
        expected: expectedAmount,
        received: payment.amount
      });
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // Activate subscription (webhook is source of truth)
    await subscription.activateSubscription({
      razorpayPaymentId: paymentId,
      razorpaySignature: signature
    });

    // Update mess status
    await Mess.findByIdAndUpdate(subscription.messId, {
      subscriptionStatus: 'active',
      subscriptionEndsAt: subscription.endDate
    });

    // Audit log
    await AuditLog.create({
      messId: subscription.messId,
      action: 'subscription_activated_webhook',
      targetId: subscription._id,
      targetType: 'MessSubscription',
      details: {
        paymentId,
        orderId,
        amount: payment.amount / 100
      }
    });

  }

  // Handle payment.failed event
  if (event.event === 'payment.failed') {
    const payment = event.payload.payment.entity;
    const orderId = payment.order_id;

    const subscription = await MessSubscription.findOne({ razorpayOrderId: orderId });
    if (subscription) {
      await subscription.markPastDue();
      
      await AuditLog.create({
        messId: subscription.messId,
        action: 'subscription_payment_failed',
        targetId: subscription._id,
        targetType: 'MessSubscription',
        details: {
          orderId,
          reason: payment.error_description
        }
      });
    }
  }

  res.json({ status: 'ok' });
}));

/**
 * POST /api/mess-subscription/upgrade
 * Upgrade subscription plan
 */
router.post('/upgrade', requireAuth, asyncHandler(async (req, res) => {
  const { planName } = req.body;

  if (!['BASIC', 'STANDARD', 'PRO'].includes(planName)) {
    throw new ApiError('Invalid plan', 400, 'INVALID_PLAN');
  }

  const subscription = await MessSubscription.findOne({ messId: req.messId });
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  const oldPlan = subscription.planName;
  subscription.planName = planName;
  await subscription.save();

  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_upgraded',
    userId: req.user.sub,
    targetId: subscription._id,
    targetType: 'MessSubscription',
    details: { oldPlan, newPlan: planName },
    ipAddress: req.ip
  });

  res.json(successResponse({
    message: 'Plan upgraded successfully',
    subscription: {
      planName: subscription.planName,
      status: subscription.status
    }
  }));
}));

/**
 * POST /api/mess-subscription/cancel
 * Cancel subscription
 */
router.post('/cancel', requireAuth, asyncHandler(async (req, res) => {
  const { reason } = req.body;

  const subscription = await MessSubscription.findOne({ messId: req.messId });
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  await subscription.cancelSubscription(reason);

  await AuditLog.create({
    messId: req.messId,
    action: 'subscription_cancelled',
    userId: req.user.sub,
    targetId: subscription._id,
    targetType: 'MessSubscription',
    details: { reason },
    ipAddress: req.ip
  });

  res.json(successResponse({
    message: 'Subscription cancelled successfully'
  }));
}));

export default router;
