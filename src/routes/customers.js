import express from "express";
import { Customer } from "../models/Customer.js";
import { Subscription } from "../models/Subscription.js";
import { MealTransaction } from "../models/MealTransaction.js";
import { generateQrToken } from "../utils/qrHelper.js";
import { generatePinFromName, hashPin } from "../utils/pinHelper.js";
import { ApiError } from "../utils/errorHandler.js";
import { successResponse } from "../utils/response.js";
import { requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";
import { checkCustomerLimit } from "../middleware/planLimitEnforcement.js";

const router = express.Router();

const createCustomerHandler = asyncHandler(async (req, res) => {
  const { name, phone, roomNo, balance, preferredPaymentMethod, upiId } = req.body;

  if (!name || !phone || !roomNo) {
    throw new ApiError("Missing required fields", 400, "VALIDATION_ERROR");
  }

  // 🔒 BLOCKER 3: Check customer limit before creating
  const customerCount = await Customer.countDocuments({ 
    messId: req.messId,
    active: true 
  });

  if (req.planLimits && customerCount >= req.planLimits.maxCustomers) {
    throw new ApiError(
      `Customer limit reached (${req.planLimits.maxCustomers}). Please upgrade your plan.`,
      403,
      'CUSTOMER_LIMIT_REACHED'
    );
  }

  // Generate PIN from customer name
  const pin = generatePinFromName(name);
  const pinHash = await hashPin(pin);

  const customer = new Customer({ 
    name, 
    phone, 
    roomNo,
    pinHash,
    ...(balance !== undefined && { balance: Number(balance) }),
    ...(preferredPaymentMethod && { preferredPaymentMethod }),
    ...(upiId && { upiId })
  });
  await customer.save();

  const qrToken = generateQrToken(customer.qrCodeId, process.env.JWT_SECRET);

  res.status(201).json(
    successResponse(
      {
        customerId: customer._id,
        name: customer.name,
        phone: customer.phone,
        roomNo: customer.roomNo,
        qrCodeId: customer.qrCodeId,
        qrToken,
        pin, // Return the generated PIN
      },
      "Customer created",
    ),
  );
});

const listCustomersHandler = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search } = req.query;

  const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);

  const filter = { 
    messId: req.messId, // 🔒 TENANT ISOLATION
    active: true 
  };
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: "i" } },
      { phone: { $regex: search, $options: "i" } },
      { roomNo: { $regex: search, $options: "i" } },
    ];
  }

  const customers = await Customer.find(filter)
    .select('name phone roomNo balance preferredPaymentMethod upiId active createdAt joinedAt')
    .skip(skip)
    .limit(Number.parseInt(limit, 10))
    .sort({ createdAt: -1 })
    .lean();

  // Ensure balance and preferredPaymentMethod have default values
  const customersWithDefaults = customers.map(c => ({
    ...c,
    balance: c.balance ?? 0,
    preferredPaymentMethod: c.preferredPaymentMethod || 'NONE'
  }));

  const total = await Customer.countDocuments(filter);

  res.json(
    successResponse(
      { customers: customersWithDefaults, pagination: { page: Number(page), limit: Number(limit), total, pages: Math.ceil(total / limit) } },
      "Customers retrieved",
    ),
  );
});

const getCustomerHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customer = await Customer.findOne({ 
    _id: id,
    messId: req.messId // 🔒 TENANT ISOLATION
  });
  
  if (!customer) {
    throw new ApiError("Customer not found", 404, "NOT_FOUND");
  }

  const subscriptions = await Subscription.find({
    customerId: id,
    active: true,
  })
  .select('planId mealsRemaining mealsTotal startDate endDate active')
  .populate('planId', 'name price')
  .lean();

  const qrToken = generateQrToken(customer.qrCodeId, process.env.JWT_SECRET);

  res.json(
    successResponse(
      {
        customer,
        subscriptions,
        qrToken,
      },
      "Customer details retrieved",
    ),
  );
});

const updateCustomerHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, phone, roomNo, active } = req.body;

  const customer = await Customer.findOneAndUpdate(
    { 
      _id: id,
      messId: req.messId // 🔒 TENANT ISOLATION
    },
    {
      ...(name && { name }),
      ...(phone && { phone }),
      ...(roomNo && { roomNo }),
      ...(active !== undefined && { active }),
    },
    { new: true, runValidators: true },
  );

  if (!customer) {
    throw new ApiError("Customer not found", 404, "NOT_FOUND");
  }

  res.json(successResponse(customer, "Customer updated"));
});

const deactivateCustomerHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customer = await Customer.findOneAndUpdate(
    { 
      _id: id,
      messId: req.messId // 🔒 TENANT ISOLATION
    },
    { active: false }, 
    { new: true }
  );

  if (!customer) {
    throw new ApiError("Customer not found", 404, "NOT_FOUND");
  }

  res.json(successResponse(customer, "Customer deactivated"));
});

const deleteCustomerHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const customer = await Customer.findOne({ 
    _id: id,
    messId: req.messId // 🔒 TENANT ISOLATION
  });
  
  if (!customer) {
    throw new ApiError("Customer not found", 404, "NOT_FOUND");
  }

  // Delete all related data
  await Subscription.deleteMany({ customerId: id, messId: req.messId });
  await MealTransaction.deleteMany({ customerId: id, messId: req.messId });

  // Delete customer
  await Customer.findOneAndDelete({ _id: id, messId: req.messId });

  res.json(successResponse({ deletedCustomerId: id }, "Customer and related data deleted"));
});

// Quick search endpoint for staff scanner fallback
const searchCustomerHandler = asyncHandler(async (req, res) => {
  const { q } = req.query;

  if (!q || q.trim().length < 2) {
    throw new ApiError("Query must be at least 2 characters", 400, "VALIDATION_ERROR");
  }

  const customers = await Customer.find({
    messId: req.messId, // 🔒 TENANT ISOLATION
    active: true,
    $or: [
      { phone: { $regex: q.trim(), $options: "i" } },
      { roomNo: { $regex: q.trim(), $options: "i" } },
      { name: { $regex: q.trim(), $options: "i" } },
    ],
  })
  .select('name phone roomNo qrCodeId')
  .limit(20)
  .lean();

  if (!customers || customers.length === 0) {
    return res.json(successResponse([], "No customers found"));
  }

  // Fetch active subscriptions with plan details for all customers
  const customerIds = customers.map(c => c._id);
  const subscriptions = await Subscription.find({
    customerId: { $in: customerIds },
    active: true,
  })
  .select('customerId planId mealsRemaining')
  .populate('planId', 'name')
  .lean();

  // Map subscriptions to customers
  const subscriptionMap = {};
  subscriptions.forEach(sub => {
    subscriptionMap[sub.customerId.toString()] = sub;
  });

  // Combine customer data with subscription info
  const results = customers.map(customer => {
    const subscription = subscriptionMap[customer._id.toString()];
    return {
      _id: customer._id,
      name: customer.name,
      phone: customer.phone,
      roomNo: customer.roomNo,
      qrCodeId: customer.qrCodeId,
      subscription: subscription || null,
      planName: subscription?.planId?.name || 'No Plan',
      mealsRemaining: subscription?.mealsRemaining || 0,
    };
  });

  res.json(successResponse(results, "Customers found"));
});

router.post("/customers", requireRole("admin"), createCustomerHandler);
router.get("/customers", requireRole("admin"), listCustomersHandler);
router.get("/customers/search", searchCustomerHandler);
router.get("/customers/:id", requireRole("admin"), getCustomerHandler);
router.put("/customers/:id", requireRole("admin"), updateCustomerHandler);
router.patch("/customers/:id/deactivate", requireRole("admin"), deactivateCustomerHandler);
router.delete("/customers/:id", requireRole("admin"), deleteCustomerHandler);

export default router;