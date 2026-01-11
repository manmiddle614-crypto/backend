import express from 'express';
import crypto from 'crypto';
import { Payment } from '../models/Payment.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { Mess } from '../models/Mess.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { PLANS, getPlanPrice, calculateEndDate, calculateGraceEndDate } from '../config/plans.js';
import getRazorpayInstance from '../services/razorpay.js';

const router = express.Router();

/**
 * POST /api/billing/create-order
 * Create Razorpay order (SECURE - price from server only)
 */
router.post('/create-order', requireAuth, asyncHandler(async (req, res) => {
  const { planKey, billingCycle } = req.body;

  // Validate inputs
  if (!planKey || !PLANS[planKey]) {
    throw new ApiError('Invalid plan selected', 400, 'INVALID_PLAN');
  }

  if (!['monthly', '6month', 'yearly'].includes(billingCycle)) {
    throw new ApiError('Invalid billing cycle', 400, 'INVALID_BILLING_CYCLE');
  }

  // Get subscription
  const subscription = await MessSubscription.findOne({ messId: req.messId })
    .select('status razorpayPaymentId')
    .lean();
  if (!subscription) {
    throw new ApiError('Subscription not found', 404, 'NOT_FOUND');
  }

  // Check if already has active paid subscription
  if (subscription.status === 'active' && subscription.razorpayPaymentId) {
    throw new ApiError('Active subscription already exists', 400, 'ALREADY_ACTIVE');
  }

  // Get price from server (NEVER trust frontend)
  const amountExpected = getPlanPrice(planKey, billingCycle);
  const currency = 'INR';

  // Create Razorpay order
  const razorpay = getRazorpayInstance();
  const order = await razorpay.orders.create({
    amount: amountExpected * 100, // Convert to paise
    currency,
    receipt: `order_${req.messId}_${Date.now()}`,
    notes: {
      messId: req.messId.toString(),
      planKey,
      billingCycle
    }
  });

  // Create immutable Payment record
  const payment = await Payment.create({
    messId: req.messId,
    planKey,
    billingCycle,
    amountExpected,
    amountPaid: 0,
    currency,
    razorpayOrderId: order.id,
    status: 'created',
    idempotencyKey: `${req.messId}_${order.id}`,
    metadata: {
      planName: PLANS[planKey].name,
      userId: req.user.sub
    }
  });

  // Audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'payment_order_created',
    userId: req.user.sub,
    targetId: payment._id,
    targetType: 'Payment',
    details: {
      orderId: order.id,
      planKey,
      billingCycle,
      amount: amountExpected
    },
    ipAddress: req.ip
  });

  // Get mess details for checkout
  const mess = await Mess.findById(req.messId);

  res.json(successResponse({
    orderId: order.id,
    amount: amountExpected,
    currency,
    keyId: process.env.RAZORPAY_KEY_ID,
    prefill: {
      name: mess.ownerName,
      email: mess.ownerEmail,
      contact: mess.ownerPhone
    }
  }));
}));

/**
 * POST /api/billing/webhook
 * Razorpay webhook handler (ONLY way to activate subscription)
 */
router.post('/webhook', express.raw({ type: 'application/json' }), asyncHandler(async (req, res) => {
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
    const paymentEntity = event.payload.payment.entity;
    const orderId = paymentEntity.order_id;
    const paymentId = paymentEntity.id;
    const amountPaid = paymentEntity.amount / 100; // Convert from paise

    // Find payment record
    const payment = await Payment.findOne({ razorpayOrderId: orderId })
      .select('status razorpayPaymentId amountExpected currency messId planKey billingCycle metadata');
    
    if (!payment) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    // IDEMPOTENCY: Check if already processed
    if (payment.status === 'paid' && payment.razorpayPaymentId === paymentId) {
      return res.json({ status: 'ok', message: 'Already processed' });
    }

    // VERIFY PAYMENT AMOUNT (prevent partial payment fraud)
    if (amountPaid !== payment.amountExpected) {
      // Mark payment as failed
      payment.status = 'failed';
      payment.metadata = { ...payment.metadata, error: 'Amount mismatch' };
      await payment.save();
      
      return res.status(400).json({ error: 'Amount mismatch' });
    }

    // VERIFY CURRENCY
    if (paymentEntity.currency !== payment.currency) {
      payment.status = 'failed';
      await payment.save();
      return res.status(400).json({ error: 'Currency mismatch' });
    }

    // Update payment record (mark as paid)
    payment.status = 'paid';
    payment.amountPaid = amountPaid;
    payment.razorpayPaymentId = paymentId;
    payment.razorpaySignature = signature;
    await payment.save();

    // ACTIVATE SUBSCRIPTION
    const subscription = await MessSubscription.findOne({ messId: payment.messId })
      .select('planName billingCycle price status startDate endDate gracePeriodEndsAt lastPaymentDate nextBillingDate razorpayOrderId razorpayPaymentId razorpaySignature paymentReference');
    
    if (!subscription) {
      return res.status(404).json({ error: 'Subscription not found' });
    }

    // Calculate dates
    const startDate = new Date();
    const endDate = calculateEndDate(payment.billingCycle, startDate);
    const graceEndDate = calculateGraceEndDate(endDate);

    // Update subscription
    subscription.planName = payment.planKey;
    subscription.billingCycle = payment.billingCycle;
    subscription.price = payment.amountPaid;
    subscription.status = 'active';
    subscription.startDate = startDate;
    subscription.endDate = endDate;
    subscription.gracePeriodEndsAt = graceEndDate;
    subscription.lastPaymentDate = startDate;
    subscription.nextBillingDate = endDate;
    subscription.razorpayOrderId = orderId;
    subscription.razorpayPaymentId = paymentId;
    subscription.razorpaySignature = signature;
    subscription.paymentReference = paymentId;
    
    await subscription.save();

    // Update mess status
    await Mess.findByIdAndUpdate(payment.messId, {
      subscriptionStatus: 'active',
      subscriptionEndsAt: endDate
    });

    // Audit log
    await AuditLog.create({
      messId: payment.messId,
      action: 'subscription_activated_webhook',
      targetId: subscription._id,
      targetType: 'MessSubscription',
      details: {
        paymentId,
        orderId,
        planKey: payment.planKey,
        billingCycle: payment.billingCycle,
        amount: amountPaid,
        endDate
      }
    });
  }

  // Handle payment.failed event
  if (event.event === 'payment.failed') {
    const paymentEntity = event.payload.payment.entity;
    const orderId = paymentEntity.order_id;

    const payment = await Payment.findOne({ razorpayOrderId: orderId })
      .select('status messId metadata');
    if (payment && payment.status !== 'failed') {
      payment.status = 'failed';
      payment.metadata = { 
        ...payment.metadata, 
        error: paymentEntity.error_description 
      };
      await payment.save();
      
      await AuditLog.create({
        messId: payment.messId,
        action: 'payment_failed',
        targetId: payment._id,
        targetType: 'Payment',
        details: {
          orderId,
          reason: paymentEntity.error_description
        }
      });
    }
  }

  res.json({ status: 'ok' });
}));

/**
 * GET /api/billing/history
 * Get payment history
 */
router.get('/history', requireAuth, asyncHandler(async (req, res) => {
  const { page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const payments = await Payment.find({ messId: req.messId })
    .select('planKey billingCycle amountExpected amountPaid currency status razorpayOrderId razorpayPaymentId createdAt')
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .skip(skip)
    .lean();

  const total = await Payment.countDocuments({ messId: req.messId });

  res.json(successResponse({
    payments,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  }));
}));

/**
 * GET /api/billing/plans
 * Get available plans (public)
 */
router.get('/plans', asyncHandler(async (req, res) => {
  // Return plans without exposing internal limits
  const plans = Object.entries(PLANS).map(([key, plan]) => ({
    key,
    name: plan.name,
    pricing: plan.pricing,
    features: plan.features
  }));

  res.json(successResponse({ plans }));
}));

export default router;
