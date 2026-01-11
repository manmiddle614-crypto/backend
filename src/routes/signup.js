import express from 'express';
import jwt from 'jsonwebtoken';
import mongoose from 'mongoose';
import { Mess } from '../models/Mess.js';
import { User } from '../models/User.js';
import { MessSubscription } from '../models/MessSubscription.js';
import { AuditLog } from '../models/AuditLog.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';
import { asyncHandler } from '../utils/asyncHandler.js';

const router = express.Router();

/**
 * POST /auth/signup
 * Create new mess with admin user and start 14-day trial
 */
router.post('/signup', asyncHandler(async (req, res) => {
  const { messName, ownerName, phone, email, password } = req.body;

  // Validation
  if (!messName || !ownerName || !phone || !email || !password) {
    throw new ApiError('All fields are required', 400, 'VALIDATION_ERROR');
  }

  if (password.length < 8) {
    throw new ApiError('Password must be at least 8 characters', 400, 'WEAK_PASSWORD');
  }

  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new ApiError('Invalid email format', 400, 'INVALID_EMAIL');
  }

  if (!/^\d{10}$/.test(phone)) {
    throw new ApiError('Phone must be 10 digits', 400, 'INVALID_PHONE');
  }

  const normalizedEmail = email.toLowerCase().trim();
  const normalizedPhone = phone.trim();

  // TRIAL ABUSE PREVENTION: Check email AND phone
  const existingMess = await Mess.findOne({ 
    $or: [
      { ownerEmail: normalizedEmail },
      { ownerPhone: normalizedPhone }
    ]
  });
  if (existingMess) {
    throw new ApiError(
      'Email or phone already registered. One trial per user.',
      409,
      'TRIAL_ALREADY_USED'
    );
  }

  const existingUser = await User.findOne({ 
    $or: [
      { email: normalizedEmail },
      { phone: normalizedPhone }
    ]
  });
  if (existingUser) {
    throw new ApiError(
      'Email or phone already in use',
      409,
      'ACCOUNT_EXISTS'
    );
  }

  // Start transaction for atomic operation
  const session = await mongoose.startSession();
  session.startTransaction();

  try {
    // Calculate trial end date (14 days from now)
    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    // Create Mess
    const [mess] = await Mess.create([{
      name: messName,
      ownerName,
      ownerEmail: normalizedEmail,
      ownerPhone: phone,
      subscriptionStatus: 'trial',
      trialStartedAt: new Date(),
      trialEndsAt,
      subscriptionTier: 'standard',
      features: {
        maxCustomers: 999999,
        maxStaff: 999999,
        advancedReports: true
      },
      active: true
    }], { session });

    // Hash password explicitly (don't rely on pre-save hook)
    const bcrypt = await import('bcryptjs');
    const hashedPassword = await bcrypt.default.hash(password, 12);

    // Create Admin User
    const [adminUser] = await User.create([{
      messId: mess._id,
      name: ownerName,
      email: normalizedEmail,
      phone,
      passwordHash: hashedPassword,
      role: 'admin',
      active: true,
      permissions: User.getRolePermissions('admin')
    }], { session });

    // Update mess with ownerId
    mess.ownerId = adminUser._id;
    await mess.save({ session });

    // Create MessSubscription with 14-day trial
    const [messSubscription] = await MessSubscription.create([{
      messId: mess._id,
      planName: 'standard',
      price: 999,
      billingCycle: 'monthly',
      status: 'trial',
      startDate: new Date(),
      endDate: trialEndsAt,
      trialEndsAt,
      paymentGateway: 'razorpay',
      autoRenew: true
    }], { session });

    // Create audit log
    await AuditLog.create([{
      messId: mess._id,
      action: 'mess_signup',
      userId: adminUser._id,
      targetId: mess._id,
      targetType: 'Mess',
      details: {
        messName,
        ownerName,
        ownerEmail: normalizedEmail,
        trialEndsAt
      },
      ipAddress: req.ip
    }], { session });

    // Commit transaction
    await session.commitTransaction();

    // Generate JWT token
    const token = jwt.sign(
      { 
        sub: adminUser._id, 
        role: 'admin',
        messId: mess._id
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' } // 🔒 BLOCKER 4: Reduced from 7d to 24h
    );

    // Return response
    res.status(201).json(successResponse({
      token,
      user: {
        id: adminUser._id,
        name: adminUser.name,
        email: adminUser.email,
        role: adminUser.role
      },
      mess: {
        id: mess._id,
        name: mess.name,
        subscriptionStatus: mess.subscriptionStatus,
        trialEndsAt: mess.trialEndsAt,
        daysRemaining: Math.ceil((mess.trialEndsAt - new Date()) / (1000 * 60 * 60 * 24))
      }
    }, 'Signup successful. Welcome to MessManager!'));

  } catch (error) {
    // Rollback transaction on error
    await session.abortTransaction();

    throw error;
  } finally {
    session.endSession();
  }
}));

export default router;
