import express from 'express';
import { Notification } from '../models/Notification.js';
import { createNotification, markAsRead, deleteNotification } from '../services/notificationService.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

// GET /api/notifications - Fetch user notifications
router.get('/', asyncHandler(async (req, res) => {
  const { page = 1, limit = 50, unreadOnly = false } = req.query;
  const userId = req.user.sub || req.user.id;
  
  const filter = {
    messId: req.messId,
    $or: [
      { userId: userId },
      { userId: null } // Broadcast notifications
    ]
  };

  if (unreadOnly === 'true') {
    filter.read = false;
  }

  const skip = (parseInt(page) - 1) * parseInt(limit);

  const [notifications, total, unreadCount] = await Promise.all([
    Notification.find(filter)
      .sort({ priority: -1, createdAt: -1 })
      .skip(skip)
      .limit(Math.min(parseInt(limit), 100))
      .lean(),
    Notification.countDocuments(filter),
    Notification.countDocuments({ ...filter, read: false })
  ]);

  res.json(successResponse({
    notifications,
    unreadCount,
    pagination: {
      page: parseInt(page),
      limit: parseInt(limit),
      total,
      pages: Math.ceil(total / parseInt(limit))
    }
  }));
}));

// PATCH /api/notifications/:id/read - Mark as read
router.patch('/:id/read', asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub || req.user.id;

  const notification = await Notification.findOne({
    _id: id,
    messId: req.messId,
    $or: [{ userId }, { userId: null }]
  });

  if (!notification) {
    throw new ApiError('Notification not found', 404, 'NOT_FOUND');
  }

  if (notification.strict) {
    throw new ApiError('This notification cannot be dismissed', 403, 'STRICT_NOTIFICATION');
  }

  notification.read = true;
  await notification.save();

  res.json(successResponse({ notification }, 'Notification marked as read'));
}));

// POST /api/admin/notifications - Admin create notification
router.post('/admin', requireRole(['admin', 'manager']), asyncHandler(async (req, res) => {
  const { title, message, type = 'admin', priority = 'HIGH', strict = false, expiresInHours } = req.body;

  if (!title || !message) {
    throw new ApiError('Title and message are required', 400, 'VALIDATION_ERROR');
  }

  const notification = await createNotification({
    messId: req.messId,
    userId: null, // Broadcast to all
    title,
    message,
    type,
    priority,
    strict,
    expiresInHours
  });

  res.status(201).json(successResponse({ notification }, 'Notification created successfully'));
}));

// DELETE /api/admin/notifications/:id - Admin delete notification
router.delete('/admin/:id', requireRole(['admin']), asyncHandler(async (req, res) => {
  const { id } = req.params;

  const notification = await deleteNotification(id, req.messId);

  if (!notification) {
    throw new ApiError('Notification not found', 404, 'NOT_FOUND');
  }

  res.json(successResponse({ id }, 'Notification deleted successfully'));
}));

export default router;
