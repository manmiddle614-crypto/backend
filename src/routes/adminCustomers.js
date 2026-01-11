import express from 'express';
import mongoose from 'mongoose';
import { Customer } from '../models/Customer.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { AuditLog } from '../models/AuditLog.js';
import { generatePin, hashPin, validatePin, generatePinFromName } from '../utils/pinHelper.js';
import { generateQrCodeImage, generatePrintableCard } from '../utils/qrGenerator.js';
import { qrTokenService } from '../services/qrTokenService.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPlanLimits, isLimitReached } from '../utils/planConfig.js';

const router = express.Router();

/**
 * GET /admin/customers
 * List customers with search, filter, and pagination
 * Includes active subscription data (meals remaining)
 */
const listCustomersHandler = asyncHandler(async (req, res) => {
  const { 
    page = 1, 
    limit = 20, 
    search, 
    active, 
    sortBy = 'createdAt', 
    sortOrder = 'desc'
  } = req.query;

  const pageNum = Math.max(parseInt(page), 1);
  const limitNum = Math.min(parseInt(limit), 100);
  const skip = (pageNum - 1) * limitNum;
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  // Build filter with messId isolation
  const filter = { messId: req.messId };
  
  if (active !== undefined) {
    filter.active = active === 'true';
  }

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { roomNo: { $regex: search, $options: 'i' } }
    ];
  }

  const customers = await Customer.find(filter)
    .select('name phone roomNo active balance createdAt qrCodeId preferredPaymentMethod upiId')
    .sort(sort)
    .skip(skip)
    .limit(limitNum)
    .lean();

  // Fetch active subscriptions for all customers
  const customerIds = customers.map(c => c._id);
  const now = new Date();
  const activeSubscriptions = await Subscription.find({
    messId: req.messId,
    customerId: { $in: customerIds },
    active: true,
    endDate: { $gte: now },
    mealsRemaining: { $gt: 0 }
  })
  .select('customerId mealsRemaining')
  .lean();

  // Create a map of customerId -> subscription
  const subscriptionMap = {};
  activeSubscriptions.forEach(sub => {
    subscriptionMap[sub.customerId.toString()] = sub;
  });

  // Enrich customers with subscription data
  const enrichedCustomers = customers.map(customer => {
    const subscription = subscriptionMap[customer._id.toString()];
    const enriched = {
      ...customer,
      mealsRemaining: subscription?.mealsRemaining || 0,
      hasActiveSub: !!subscription,
      balance: customer.balance !== undefined ? customer.balance : 0
    };
    
  
    return enriched;
  });

  const total = await Customer.countDocuments(filter);

  res.json(successResponse({
    customers: enrichedCustomers,
    pagination: {
      page: pageNum,
      limit: limitNum,
      total,
      pages: Math.ceil(total / limitNum)
    }
  }, 'Customers retrieved successfully'));
});

/**
 * POST /admin/customers
 * Create new customer with plan limit enforcement
 */
const createCustomerHandler = asyncHandler(async (req, res) => {
  const { name, phone, roomNo, balance, preferredPaymentMethod, upiId, isExistingCustomer, previousMealsConsumed, messStartDate } = req.body;

  if (!name || !phone) {
    throw new ApiError('Name and phone are required', 400, 'VALIDATION_ERROR');
  }

  // Validate existing customer fields
  if (isExistingCustomer) {
    if (!previousMealsConsumed || previousMealsConsumed < 0) {
      throw new ApiError('Previous meals consumed is required for existing customers', 400, 'VALIDATION_ERROR');
    }
    if (!messStartDate) {
      throw new ApiError('Mess start date is required for existing customers', 400, 'VALIDATION_ERROR');
    }
  }

  // Atomic check with transaction
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // 1. Fetch subscription
    const subscription = await MessSubscription.findOne({ messId: req.messId }).session(session);
    if (!subscription) {
      throw new ApiError('No subscription found', 404, 'NO_SUBSCRIPTION');
    }

    // 2. Get plan limits
    const limits = getPlanLimits(subscription.planName);

    // 3. Count active customers only (disabled customers don't count)
    const activeCustomerCount = await Customer.countDocuments({
      messId: req.messId,
      active: true
    }).session(session);

    // 4. Check limit
    if (isLimitReached(activeCustomerCount, limits.maxCustomers)) {
      throw new ApiError(
        `Customer limit reached (${limits.maxCustomers}). Upgrade plan to add more customers.`,
        403,
        'CUSTOMER_LIMIT_REACHED'
      );
    }

    // 5. Generate PIN from customer name
    const pin = generatePinFromName(name);
    const pinHash = await hashPin(pin);

    // 6. Create customer
    const customerData = {
      messId: req.messId,
      name: name.trim(),
      phone: phone.trim(),
      roomNo: roomNo?.trim(),
      pinHash,
      balance: balance !== undefined ? Number(balance) : 0,
      preferredPaymentMethod: preferredPaymentMethod || 'NONE',
      upiId: preferredPaymentMethod === 'UPI' && upiId ? upiId.trim() : null,
      pinChangedAt: null,
      pinFailedAttempts: 0,
      pinLockedUntil: null,
      trustedDevices: [],
      active: true,
      isExistingCustomer: isExistingCustomer || false,
      previousMealsConsumed: isExistingCustomer ? parseInt(previousMealsConsumed) : 0,
      messStartDate: isExistingCustomer ? new Date(messStartDate) : null
    };

    const [customer] = await Customer.create([customerData], { session });

    // 7. Audit log
    await AuditLog.create([{
      messId: req.messId,
      action: 'customer_created',
      userId: req.user.sub || req.user.id,
      targetId: customer._id,
      targetType: 'Customer',
      details: {
        customerName: customer.name,
        phone: customer.phone,
        roomNo: customer.roomNo,
        isExistingCustomer: customer.isExistingCustomer,
        previousMealsConsumed: customer.previousMealsConsumed,
        messStartDate: customer.messStartDate,
        currentCount: activeCustomerCount + 1,
        limit: limits.maxCustomers
      },
      ipAddress: req.ip
    }], { session });

    await session.commitTransaction();

    const response = {
      customer: {
        id: customer._id,
        name: customer.name,
        phone: customer.phone,
        roomNo: customer.roomNo,
        qrCodeId: customer.qrCodeId,
        active: customer.active,
        createdAt: customer.createdAt
      },
      pin: pin, // Always return PIN for admin to share with customer
      usage: {
        current: activeCustomerCount + 1,
        limit: limits.maxCustomers,
        remaining: limits.maxCustomers === Infinity ? Infinity : limits.maxCustomers - activeCustomerCount - 1
      }
    };

    res.status(201).json(successResponse(response, 'Customer created successfully'));
  } catch (error) {
    await session.abortTransaction();
    throw error;
  } finally {
    session.endSession();
  }
});

/**
 * POST /admin/customers/:id/set-pin
 * Set or reset customer PIN
 */
const setPinHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { pin } = req.body;

  const customer = await Customer.findOne({ _id: id, messId: req.messId });
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Generate or validate PIN
  const newPin = pin || generatePin();
  if (!validatePin(newPin)) {
    throw new ApiError('PIN must be 4-6 digits', 400, 'INVALID_PIN');
  }

  // Hash and save PIN
  const pinHash = await hashPin(newPin);
  customer.pinHash = pinHash;
  customer.pinChangedAt = null;
  customer.pinFailedAttempts = 0;
  customer.pinLockedUntil = null;
  await customer.save();

  // Create audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'pin_set',
    userId: req.user.sub || req.user.id,
    targetId: customer._id,
    targetType: 'Customer',
    details: {
      customerName: customer.name
    },
    ipAddress: req.ip
  });

  const response = { success: true };
  
  // Include PIN only in development
  if (process.env.NODE_ENV !== 'production') {
    response.pin = newPin;
  }

  res.json(successResponse(response, 'PIN set successfully'));
});

// Routes
router.get('/', requireRole(['admin', 'manager']), listCustomersHandler);
router.post('/', requireRole(['admin', 'manager']), createCustomerHandler);
router.post('/:id/set-pin', requireRole(['admin', 'manager']), setPinHandler);
router.get('/:id/qr', requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  if (!mongoose.Types.ObjectId.isValid(id)) {
    throw new ApiError('Invalid customer ID', 400, 'INVALID_ID');
  }
  
  const customer = await Customer.findOne({ _id: id, messId: req.messId });
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }
  
  // Ensure messId exists
  const messId = customer.messId || req.messId;
  if (!messId) {
    throw new ApiError('Mess ID not found', 400, 'MISSING_MESS_ID');
  }
  
  const qrToken = qrTokenService.generateToken({
    customerId: customer._id.toString(),
    messId: messId.toString(),
    qrCodeId: customer.qrCodeId
  });
  const tokenInfo = qrTokenService.getTokenInfo(qrToken);
  res.json(successResponse({ 
    qrToken, 
    qrCodeId: customer.qrCodeId, 
    expiresAt: tokenInfo.expiresAt,
    daysUntilExpiry: tokenInfo.daysUntilExpiry
  }, 'QR token generated'));
}));

router.post('/:id/permanent-qr', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const customer = await Customer.findOne({ _id: id, messId: req.messId });
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  // Generate a long-lived QR token (10 years)
  const qrToken = qrTokenService.generateToken({
    customerId: customer._id.toString(),
    messId: customer.messId.toString(),
    qrCodeId: customer.qrCodeId
  }, 3650); // 10 years

  const qrImage = await generateQrCodeImage(qrToken, { width: 512 });

  await AuditLog.create({
    messId: req.messId,
    action: 'permanent_qr_generated',
    userId: req.user.sub || req.user.id,
    targetId: customer._id,
    targetType: 'Customer',
    details: { customerName: customer.name },
    ipAddress: req.ip
  });

  const tokenInfo = qrTokenService.getTokenInfo(qrToken);

  res.json(successResponse({ 
    qrToken, 
    qrCodeId: customer.qrCodeId,
    dataUrl: qrImage.dataUrl,
    expiresAt: tokenInfo.expiresAt,
    daysUntilExpiry: tokenInfo.daysUntilExpiry
  }, 'Permanent QR token and image generated successfully'));
}));
router.delete('/:id', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const customer = await Customer.findOne({ _id: id, messId: req.messId });
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }
  await Customer.findOneAndDelete({ _id: id, messId: req.messId });
  await Subscription.deleteMany({ customerId: id, messId: req.messId });
  await MealTransaction.deleteMany({ customerId: id, messId: req.messId });
  await AuditLog.create({
    messId: req.messId,
    action: 'customer_deleted',
    userId: req.user.sub || req.user.id,
    targetId: id,
    targetType: 'Customer',
    details: { customerName: customer.name, phone: customer.phone },
    ipAddress: req.ip
  });
  res.json(successResponse({ id }, 'Customer deleted successfully'));
}));
router.put('/:id', requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, phone, roomNo, active } = req.body;

  const customer = await Customer.findOne({ _id: id, messId: req.messId });
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (phone !== undefined) updates.phone = phone.trim();
  if (roomNo !== undefined) updates.roomNo = roomNo.trim();
  if (active !== undefined) updates.active = active;

  const updatedCustomer = await Customer.findOneAndUpdate(
    { _id: id, messId: req.messId },
    updates, 
    { new: true }
  );

  await AuditLog.create({
    messId: req.messId,
    action: 'customer_updated',
    userId: req.user.sub || req.user.id,
    targetId: customer._id,
    targetType: 'Customer',
    details: { updates },
    ipAddress: req.ip
  });

  res.json(successResponse({ customer: updatedCustomer }, 'Customer updated successfully'));
}));

export default router;