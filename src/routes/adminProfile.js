import express from 'express';
import { User } from '../models/User.js';
import { Mess } from '../models/Mess.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// GET /api/admin/profile
router.get('/profile', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const adminId = req.user.sub || req.user.id;
  const messId = req.messId;

  const [admin, mess, subscription] = await Promise.all([
    User.findOne({ _id: adminId, messId }).select('name email phone role').lean(),
    Mess.findOne({ _id: messId }).select('name ownerName ownerPhone ownerEmail address').lean(),
    MessSubscription.findOne({ messId }).select('planName status startDate endDate trialEndsAt').lean()
  ]);

  if (!admin) {
    throw new ApiError('Admin not found', 404, 'ADMIN_NOT_FOUND');
  }

  if (!mess) {
    throw new ApiError('Mess not found', 404, 'MESS_NOT_FOUND');
  }

  const now = new Date();
  const expiresAt = subscription?.trialEndsAt || subscription?.endDate;
  const daysRemaining = expiresAt ? Math.max(0, Math.ceil((new Date(expiresAt) - now) / (1000 * 60 * 60 * 24))) : 0;

  res.json(successResponse({
    admin: {
      id: admin._id,
      name: admin.name,
      email: admin.email,
      phone: admin.phone,
      role: admin.role
    },
    mess: {
      id: mess._id,
      name: mess.name,
      address: mess.address || ''
    },
    subscription: {
      plan: subscription?.planName || 'standard',
      status: subscription?.status || 'trial',
      expiresAt: expiresAt || null,
      daysRemaining
    }
  }));
}));

// PUT /api/admin/profile
router.put('/profile', requireAuth, requireRole(['admin']), asyncHandler(async (req, res) => {
  const adminId = req.user.sub || req.user.id;
  const messId = req.messId;
  const { name, phone, messName, messAddress } = req.body;

  // Validation
  if (name && name.trim().length < 3) {
    throw new ApiError('Name must be at least 3 characters', 400, 'INVALID_NAME');
  }

  if (phone && !/^\d{10}$/.test(phone)) {
    throw new ApiError('Phone must be 10 digits', 400, 'INVALID_PHONE');
  }

  if (messName && messName.trim().length < 3) {
    throw new ApiError('Mess name must be at least 3 characters', 400, 'INVALID_MESS_NAME');
  }

  // Update admin
  const adminUpdates = {};
  if (name) adminUpdates.name = name.trim();
  if (phone) adminUpdates.phone = phone.trim();

  const [updatedAdmin, updatedMess] = await Promise.all([
    Object.keys(adminUpdates).length > 0
      ? User.findOneAndUpdate(
          { _id: adminId, messId },
          { $set: adminUpdates },
          { new: true, runValidators: true }
        ).select('name email phone role').lean()
      : User.findOne({ _id: adminId, messId }).select('name email phone role').lean(),
    
    (messName || messAddress !== undefined)
      ? Mess.findOneAndUpdate(
          { _id: messId },
          { $set: { 
            ...(messName && { name: messName.trim() }),
            ...(messAddress !== undefined && { address: messAddress.trim() })
          }},
          { new: true, runValidators: true }
        ).select('name address').lean()
      : Mess.findOne({ _id: messId }).select('name address').lean()
  ]);

  // Audit log
  await AuditLog.create({
    messId,
    action: 'profile_updated',
    userId: adminId,
    targetId: adminId,
    targetType: 'User',
    details: { adminUpdates, messUpdates: { messName, messAddress } },
    ipAddress: req.ip
  });

  res.json(successResponse({
    admin: {
      id: updatedAdmin._id,
      name: updatedAdmin.name,
      email: updatedAdmin.email,
      phone: updatedAdmin.phone,
      role: updatedAdmin.role
    },
    mess: {
      id: updatedMess._id,
      name: updatedMess.name,
      address: updatedMess.address || ''
    }
  }, 'Profile updated successfully'));
}));

export default router;
