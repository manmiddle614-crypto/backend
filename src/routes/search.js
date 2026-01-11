import express from 'express';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * GET /search
 * Search and filter customers (staff/admin view)
 * Query params: search, phone, roomNo, active, minMeals, maxMeals, sort, page, limit
 */
const searchCustomersHandler = asyncHandler(async (req, res) => {
  const {
    search,
    phone,
    roomNo,
    active,
    minMeals,
    maxMeals,
    sort = 'name',
    page = 1,
    limit = 25,
  } = req.query;

  const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);

  // Build filter
  const filter = {};

  if (active !== undefined) {
    filter.active = active === 'true';
  }

  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } },
      { roomNo: { $regex: search, $options: 'i' } },
      { qrCodeId: { $regex: search, $options: 'i' } },
    ];
  } else {
    if (phone) filter.phone = { $regex: phone, $options: 'i' };
    if (roomNo) filter.roomNo = { $regex: roomNo, $options: 'i' };
  }

  // Build sort
  const sortObj = {};
  if (sort === 'mealsRemaining:asc') {
    sortObj.mealsRemaining = 1;
  } else if (sort === 'mealsRemaining:desc') {
    sortObj.mealsRemaining = -1;
  } else if (sort === 'joinedAt:asc') {
    sortObj.createdAt = 1;
  } else if (sort === 'joinedAt:desc') {
    sortObj.createdAt = -1;
  } else {
    sortObj.name = 1;
  }

  // Get customers
  let customers = await Customer.find(filter)
    .skip(skip)
    .limit(Number.parseInt(limit, 10))
    .sort(sortObj)
    .select('_id name phone roomNo active qrCodeId createdAt');

  // Populate meals remaining from subscriptions
  customers = await Promise.all(
    customers.map(async (customer) => {
      const subscription = await Subscription.findOne({
        customerId: customer._id,
        active: true,
        endDate: { $gte: new Date() },
      }).select('mealsRemaining planId');

      return {
        ...customer.toObject(),
        mealsRemaining: subscription?.mealsRemaining || 0,
        planId: subscription?.planId || null,
      };
    }),
  );

  // Apply meals filter on results
  if (minMeals !== undefined || maxMeals !== undefined) {
    customers = customers.filter((c) => {
      const meals = c.mealsRemaining || 0;
      if (minMeals !== undefined && meals < Number.parseInt(minMeals, 10)) return false;
      if (maxMeals !== undefined && meals > Number.parseInt(maxMeals, 10)) return false;
      return true;
    });
  }

  const total = await Customer.countDocuments(filter);

  res.json(
    successResponse(
      {
        data: customers,
        meta: {
          total,
          page: Number.parseInt(page, 10),
          limit: Number.parseInt(limit, 10),
          pages: Math.ceil(total / Number.parseInt(limit, 10)),
        },
      },
      'Customers found',
    ),
  );
});

/**
 * PATCH /admin/customers/:id/active
 * Activate or deactivate a customer
 */
const toggleCustomerActiveHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { active } = req.body;

  if (active === undefined) {
    throw new ApiError('Active flag required', 400, 'VALIDATION_ERROR');
  }

  const customer = await Customer.findByIdAndUpdate(
    id,
    { active: Boolean(active) },
    { new: true },
  );

  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  res.json(successResponse(customer, `Customer ${active ? 'activated' : 'deactivated'}`));
});

/**
 * POST /admin/jobs/run-deactivate
 * Auto-deactivate customers with expired subscriptions
 * Run this job nightly or on-demand
 */
const runDeactivateJobHandler = asyncHandler(async (req, res) => {
  const now = new Date();

  // Find subscriptions that are expired or have no meals left
  const expiredSubscriptions = await Subscription.updateMany(
    {
      $or: [
        { mealsRemaining: { $lte: 0 } },
        { endDate: { $lt: now } },
      ],
      active: true,
    },
    { active: false, updatedAt: now },
  );

  // Find customers with no active subscriptions and deactivate them
  const customersWithExpiredSubs = await Subscription.find({
    active: false,
  }).distinct('customerId');

  const deactivatedCustomers = await Customer.updateMany(
    {
      _id: { $in: customersWithExpiredSubs },
      active: true,
    },
    { active: false },
  );

  res.json(
    successResponse(
      {
        subscriptionsDeactivated: expiredSubscriptions.modifiedCount,
        customersDeactivated: deactivatedCustomers.modifiedCount,
      },
      'Auto-deactivate job completed',
    ),
  );
});

router.get('/search', searchCustomersHandler);
router.patch('/admin/customers/:id/active', requireRole('admin'), toggleCustomerActiveHandler);
router.post('/admin/jobs/run-deactivate', requireRole('admin'), runDeactivateJobHandler);

export default router;
