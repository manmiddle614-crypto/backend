import express from 'express';
import Attendance from '../models/Attendance.js';
import { Customer } from '../models/Customer.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { successResponse } from '../utils/response.js';
import { ApiError } from '../utils/errorHandler.js';

const router = express.Router();

// GET today's attendance for customer
router.get('/today', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'customer') {
    throw new ApiError('Customer access only', 403, 'FORBIDDEN');
  }

  const customerId = req.user.sub || req.user.id;
  
  // Get messId from customer record
  const customer = await Customer.findById(customerId).select('messId').lean();
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  const messId = customer.messId;
  const today = Attendance.getDateOnly();
  
  let attendance = await Attendance.findOne({
    messId,
    customerId,
    date: today
  }).lean();

  // Auto-create if missing
  if (!attendance) {
    attendance = await Attendance.create({
      messId,
      customerId,
      date: today,
      status: 'PENDING'
    });
  }

  res.json(successResponse({
    date: attendance.date,
    status: attendance.status,
    mealTypes: attendance.mealTypes || [],
    respondedAt: attendance.respondedAt
  }));
}));

// POST respond to attendance
router.post('/respond', requireAuth, asyncHandler(async (req, res) => {
  if (req.user.role !== 'customer') {
    throw new ApiError('Customer access only', 403, 'FORBIDDEN');
  }

  const { status, mealTypes } = req.body;

  if (!['YES', 'NO'].includes(status)) {
    throw new ApiError('Invalid status', 400, 'INVALID_INPUT');
  }

  const customerId = req.user.sub || req.user.id;
  
  // Get messId from customer record
  const customer = await Customer.findById(customerId).select('messId').lean();
  if (!customer) {
    throw new ApiError('Customer not found', 404, 'NOT_FOUND');
  }

  const messId = customer.messId;
  const today = Attendance.getDateOnly();
  
  const attendance = await Attendance.findOneAndUpdate(
    {
      messId,
      customerId,
      date: today
    },
    {
      $set: {
        status,
        mealTypes: status === 'YES' ? (mealTypes || ['breakfast', 'lunch', 'dinner']) : [],
        respondedAt: new Date()
      },
      $setOnInsert: {
        messId,
        customerId,
        date: today
      }
    },
    { 
      new: true,
      upsert: true
    }
  );

  res.json(successResponse({
    status: attendance.status,
    mealTypes: attendance.mealTypes,
    respondedAt: attendance.respondedAt
  }, `Attendance marked as ${status}`));
}));

export default router;