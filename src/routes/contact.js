import express from 'express';
import rateLimit from 'express-rate-limit';
import { ContactMessage } from '../models/ContactMessage.js';
import { requireAuth } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errorHandler.js';

const router = express.Router();

const contactLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 3,
  message: { error: 'Too many contact requests. Please try again later.' }
});

// POST /api/contact - Public contact form
router.post('/', contactLimiter, asyncHandler(async (req, res) => {
  const { name, phone, email, topic, message } = req.body;

  if (!name || !phone || !topic || !message) {
    throw new ApiError('All fields except email are required', 400);
  }

  const ipAddress = req.ip || req.connection.remoteAddress;

  const contact = await ContactMessage.create({
    name: name.trim(),
    phone: phone.trim(),
    email: email?.trim(),
    topic,
    message: message.trim(),
    ipAddress
  });

  res.status(201).json({
    success: true,
    message: 'Your message has been received. We will get back to you soon.',
    data: { id: contact._id }
  });
}));

// GET /api/contact/admin - Get all contact messages (Admin only)
router.get('/admin', requireAuth, asyncHandler(async (req, res) => {
  const { status, topic, page = 1, limit = 20 } = req.query;
  const skip = (parseInt(page) - 1) * parseInt(limit);

  const filter = {};
  if (status && status !== 'all') filter.status = status;
  if (topic && topic !== 'all') filter.topic = topic;

  const messages = await ContactMessage.find(filter)
    .sort({ createdAt: -1 })
    .limit(parseInt(limit))
    .skip(skip)
    .populate('resolvedBy', 'name')
    .lean();

  const total = await ContactMessage.countDocuments(filter);

  res.json({
    success: true,
    data: {
      messages,
      pagination: {
        page: parseInt(page),
        limit: parseInt(limit),
        total,
        pages: Math.ceil(total / parseInt(limit))
      }
    }
  });
}));

// PATCH /api/contact/admin/:id - Mark as resolved
router.patch('/admin/:id', requireAuth, asyncHandler(async (req, res) => {
  const { id } = req.params;
  const userId = req.user.sub || req.user.id;

  const message = await ContactMessage.findByIdAndUpdate(
    id,
    { 
      status: 'resolved',
      resolvedAt: new Date(),
      resolvedBy: userId
    },
    { new: true }
  );

  if (!message) {
    throw new ApiError('Message not found', 404);
  }

  res.json({
    success: true,
    data: message
  });
}));

export default router;
