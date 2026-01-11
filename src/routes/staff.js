import express from 'express';
import bcrypt from 'bcryptjs';
import mongoose from 'mongoose';
import { User } from '../models/User.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { getPlanLimits, isLimitReached } from '../utils/planConfig.js';

const router = express.Router();

/**
 * GET /admin/staff
 * List staff with search and pagination
 */
const listStaffHandler = asyncHandler(async (req, res) => {
  const { page = 1, limit = 20, search, role, active, sortBy = 'createdAt', sortOrder = 'desc' } = req.query;

  const skip = (parseInt(page) - 1) * parseInt(limit);
  const sort = { [sortBy]: sortOrder === 'desc' ? -1 : 1 };

  const filter = { messId: req.messId, role: { $in: ['admin', 'staff'] } };
  
  if (role) filter.role = role;
  if (active !== undefined) filter.active = active === 'true';
  if (search) {
    filter.$or = [
      { name: { $regex: search, $options: 'i' } },
      { email: { $regex: search, $options: 'i' } },
      { phone: { $regex: search, $options: 'i' } }
    ];
  }

  const staff = await User.find(filter)
    .select('-passwordHash')
    .sort(sort)
    .skip(skip)
    .limit(parseInt(limit));

  const total = await User.countDocuments(filter);

  res.json(successResponse({
    staff,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  }, 'Staff retrieved successfully'));
});

/**
 * POST /admin/staff
 * Create new staff member with plan limit enforcement
 */
const createStaffHandler = asyncHandler(async (req, res) => {
  const { name, email, phone, role = 'staff', password } = req.body;

  if (!name || !email || !password) {
    throw new ApiError('Name, email, and password are required', 400, 'VALIDATION_ERROR');
  }

  if (!['admin', 'staff'].includes(role)) {
    throw new ApiError('Invalid role', 400, 'INVALID_ROLE');
  }

  // Check if email already exists first
  const existing = await User.findOne({ email: email.trim().toLowerCase(), messId: req.messId });
  if (existing) {
    throw new ApiError('Email already exists', 409, 'EMAIL_EXISTS');
  }

  // Get subscription and limits
  const subscription = await MessSubscription.findOne({ messId: req.messId });
  if (!subscription) {
    throw new ApiError('No subscription found', 404, 'NO_SUBSCRIPTION');
  }

  const limits = getPlanLimits(subscription.planName);
  const currentStaffCount = await User.countDocuments({
    messId: req.messId,
    role: { $in: ['admin', 'staff'] },
    active: true
  });

  if (isLimitReached(currentStaffCount, limits.maxStaff)) {
    throw new ApiError(
      `Staff limit reached (${limits.maxStaff}). Upgrade plan to add more staff.`,
      403,
      'STAFF_LIMIT_REACHED'
    );
  }

  // Hash password and create staff
  const passwordHash = await bcrypt.hash(password, 10);
  
  const staff = await User.create({
    messId: req.messId,
    name: name.trim(),
    email: email.trim().toLowerCase(),
    phone: phone?.trim(),
    role,
    passwordHash,
    active: true
  });

  // Create audit log (non-blocking)
  AuditLog.create({
    messId: req.messId,
    action: 'staff_created',
    userId: req.user.sub || req.user.id,
    targetId: staff._id,
    targetType: 'User',
    details: {
      staffName: staff.name,
      email: staff.email,
      role: staff.role,
      currentCount: currentStaffCount + 1,
      limit: limits.maxStaff
    },
    ipAddress: req.ip
  }).catch(() => {}); // Silent fail for audit log

  const response = {
    staff: {
      id: staff._id,
      name: staff.name,
      email: staff.email,
      phone: staff.phone,
      role: staff.role,
      active: staff.active,
      createdAt: staff.createdAt
    },
    usage: {
      current: currentStaffCount + 1,
      limit: limits.maxStaff,
      remaining: limits.maxStaff === Infinity ? Infinity : limits.maxStaff - currentStaffCount - 1
    }
  };

  res.status(201).json(successResponse(response, 'Staff created successfully'));
});

/**
 * PUT /admin/staff/:id
 * Update staff member
 */
const updateStaffHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { name, email, phone, active } = req.body;

  const staff = await User.findOne({ _id: id, messId: req.messId });
  if (!staff || !['admin', 'staff'].includes(staff.role)) {
    throw new ApiError('Staff not found', 404, 'NOT_FOUND');
  }

  const updates = {};
  if (name !== undefined) updates.name = name.trim();
  if (email !== undefined) {
    const existing = await User.findOne({ email: email.trim().toLowerCase(), messId: req.messId, _id: { $ne: id } });
    if (existing) {
      throw new ApiError('Email already exists', 409, 'EMAIL_EXISTS');
    }
    updates.email = email.trim().toLowerCase();
  }
  if (phone !== undefined) updates.phone = phone?.trim();
  if (active !== undefined) updates.active = active;

  const updatedStaff = await User.findByIdAndUpdate(id, updates, { new: true }).select('-passwordHash');

  await AuditLog.create({
    messId: req.messId,
    action: 'staff_updated',
    userId: req.user.sub || req.user.id,
    targetId: staff._id,
    targetType: 'User',
    details: { updates },
    ipAddress: req.ip
  });

  res.json(successResponse({ staff: updatedStaff }, 'Staff updated successfully'));
});

/**
 * DELETE /admin/staff/:id
 * Soft delete staff member (set active=false)
 */
const deactivateStaffHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const staff = await User.findOne({ _id: id, messId: req.messId });
  if (!staff || !['admin', 'staff'].includes(staff.role)) {
    throw new ApiError('Staff not found', 404, 'NOT_FOUND');
  }

  staff.active = false;
  await staff.save();

  await AuditLog.create({
    messId: req.messId,
    action: 'staff_deactivated',
    userId: req.user.sub || req.user.id,
    targetId: staff._id,
    targetType: 'User',
    details: {
      staffName: staff.name,
      email: staff.email
    },
    ipAddress: req.ip
  });

  res.json(successResponse({ id }, 'Staff deactivated successfully'));
});

/**
 * DELETE /admin/staff/:id/permanent
 * Permanently delete staff member from database
 */
const permanentDeleteStaffHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;

  const staff = await User.findOne({ _id: id, messId: req.messId });
  if (!staff || !['admin', 'staff'].includes(staff.role)) {
    throw new ApiError('Staff not found', 404, 'NOT_FOUND');
  }

  // Store details before deletion
  const staffDetails = {
    name: staff.name,
    email: staff.email,
    role: staff.role
  };

  // Permanently delete
  await User.findByIdAndDelete(id);

  await AuditLog.create({
    messId: req.messId,
    action: 'staff_permanently_deleted',
    userId: req.user.sub || req.user.id,
    targetId: id,
    targetType: 'User',
    details: staffDetails,
    ipAddress: req.ip
  });

  res.json(successResponse({ id }, 'Staff permanently deleted'));
});

/**
 * POST /admin/staff/:id/set-role
 * Set staff role
 */
const setRoleHandler = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { role } = req.body;

  if (!['admin', 'staff'].includes(role)) {
    throw new ApiError('Invalid role', 400, 'INVALID_ROLE');
  }

  const staff = await User.findOne({ _id: id, messId: req.messId });
  if (!staff || !['admin', 'staff'].includes(staff.role)) {
    throw new ApiError('Staff not found', 404, 'NOT_FOUND');
  }

  const oldRole = staff.role;
  staff.role = role;
  await staff.save();

  await AuditLog.create({
    messId: req.messId,
    action: 'staff_role_changed',
    userId: req.user.sub || req.user.id,
    targetId: staff._id,
    targetType: 'User',
    details: {
      staffName: staff.name,
      oldRole,
      newRole: role
    },
    ipAddress: req.ip
  });

  res.json(successResponse({ staff: { id: staff._id, role: staff.role } }, 'Role updated successfully'));
});

// Routes
router.get('/', requireRole(['admin']), listStaffHandler);
router.post('/', requireRole(['admin']), createStaffHandler);
router.put('/:id', requireRole(['admin']), updateStaffHandler);
router.delete('/:id', requireRole(['admin']), deactivateStaffHandler);
router.delete('/:id/permanent', requireRole(['admin']), permanentDeleteStaffHandler);
router.post('/:id/set-role', requireRole(['admin']), setRoleHandler);
router.post('/:id/set-password', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  const { password } = req.body;

  if (!password || password.length < 6) {
    throw new ApiError('Password must be at least 6 characters', 400, 'INVALID_PASSWORD');
  }
  
  const staff = await User.findOne({ _id: id, messId: req.messId });
  if (!staff || !['admin', 'staff'].includes(staff.role)) {
    throw new ApiError('Staff not found', 404, 'NOT_FOUND');
  }

  // Update password directly using updateOne to bypass pre-save hook
  const passwordHash = await bcrypt.hash(password, 12);
  await User.updateOne({ _id: id }, { $set: { passwordHash, passwordChangedAt: new Date() } });

  await AuditLog.create({
    messId: req.messId,
    action: 'staff_password_changed',
    userId: req.user.sub || req.user.id,
    targetId: staff._id,
    targetType: 'User',
    details: { staffName: staff.name },
    ipAddress: req.ip
  });
  
  res.json(successResponse({ success: true }, 'Password updated successfully'));
}));

export default router;
