import express from 'express';
import rateLimit from 'express-rate-limit';
import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import { User } from '../models/User.js';
import { OTP } from '../models/OTP.js';
import { emailService } from '../services/emailService.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { ApiError } from '../utils/errorHandler.js';
import { successResponse } from '../utils/response.js';

const router = express.Router();

// Rate limiter for OTP requests (3 requests per 15 minutes per IP)
const otpLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  message: 'Too many OTP requests. Please try again after 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

// Rate limiter for OTP verification (10 attempts per 15 minutes per IP)
const verifyLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many verification attempts. Please try again after 15 minutes.',
  standardHeaders: true,
  legacyHeaders: false,
});

/**
 * POST /api/auth/forgot-password
 * Request OTP for password reset
 */
router.post('/forgot-password', otpLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ApiError('Email is required', 400, 'VALIDATION_ERROR');
  }

  // Check if email service is configured
  if (!emailService.isConfigured()) {
    throw new ApiError(
      'Email service not configured. Please contact administrator.',
      503,
      'SERVICE_UNAVAILABLE'
    );
  }

  // Find user by email (case-insensitive)
  const user = await User.findOne({ 
    email: email.toLowerCase().trim(),
    active: true 
  }).select('email name messId');

  // Always return success to prevent email enumeration
  if (!user) {
    return res.json(
      successResponse(
        { message: 'If the email exists, an OTP has been sent.' },
        'OTP request processed'
      )
    );
  }

  // Invalidate any existing unverified OTPs for this email + messId
  await OTP.updateMany(
    { email: user.email, messId: user.messId, verified: false },
    { $set: { expiresAt: new Date() } }
  );

  // Generate 6-digit OTP
  const otp = crypto.randomInt(100000, 999999).toString();

  // Create OTP record (expires in 10 minutes)
  const otpRecord = await OTP.create({
    email: user.email,
    messId: user.messId,
    otp,
    purpose: 'password_reset',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ipAddress: req.ip
  });

  // Send OTP via email
  try {
    await emailService.sendOTP(user.email, otp, 'password_reset');
  } catch (error) {
    // Delete OTP record if email fails
    await OTP.findByIdAndDelete(otpRecord._id);
    throw new ApiError('Failed to send OTP email. Please try again.', 500, 'EMAIL_SEND_FAILED');
  }

  res.json(
    successResponse(
      { 
        message: 'OTP sent to your email address',
        expiresIn: 600 // 10 minutes in seconds
      },
      'OTP sent successfully'
    )
  );
}));

/**
 * POST /api/auth/verify-otp
 * Verify OTP code
 */
router.post('/verify-otp', verifyLimiter, asyncHandler(async (req, res) => {
  const { email, otp } = req.body;

  if (!email || !otp) {
    throw new ApiError('Email and OTP are required', 400, 'VALIDATION_ERROR');
  }

  // Find the most recent valid OTP for this email
  const otpRecord = await OTP.findOne({
    email: email.toLowerCase().trim(),
    verified: false,
    expiresAt: { $gt: new Date() }
  }).sort({ createdAt: -1 });

  if (!otpRecord) {
    throw new ApiError('OTP expired or not found. Please request a new one.', 400, 'OTP_EXPIRED');
  }

  // Check if too many attempts
  if (otpRecord.attempts >= 5) {
    throw new ApiError('Too many failed attempts. Please request a new OTP.', 429, 'TOO_MANY_ATTEMPTS');
  }

  // Verify OTP
  const isValid = otpRecord.verify(otp.trim());
  await otpRecord.save();

  if (!isValid) {
    const remainingAttempts = 5 - otpRecord.attempts;
    throw new ApiError(
      `Invalid OTP. ${remainingAttempts} attempt(s) remaining.`,
      400,
      'INVALID_OTP'
    );
  }

  // Generate a temporary reset token (valid for 15 minutes)
  const resetToken = crypto.randomBytes(32).toString('hex');
  const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

  // Store reset token in user record
  await User.findOneAndUpdate(
    { email: otpRecord.email },
    {
      $set: {
        resetPasswordToken: resetTokenHash,
        resetPasswordExpires: new Date(Date.now() + 15 * 60 * 1000)
      }
    }
  );

  res.json(
    successResponse(
      {
        message: 'OTP verified successfully',
        resetToken,
        expiresIn: 900 // 15 minutes in seconds
      },
      'OTP verified'
    )
  );
}));

/**
 * POST /api/auth/reset-password
 * Reset password with verified token
 */
router.post('/reset-password', asyncHandler(async (req, res) => {
  const { email, resetToken, newPassword } = req.body;

  if (!email || !resetToken || !newPassword) {
    throw new ApiError('Email, reset token, and new password are required', 400, 'VALIDATION_ERROR');
  }

  // Validate password strength
  if (newPassword.length < 8) {
    throw new ApiError('Password must be at least 8 characters long', 400, 'WEAK_PASSWORD');
  }

  // Hash the provided reset token
  const resetTokenHash = crypto.createHash('sha256').update(resetToken).digest('hex');

  // Find user with valid reset token
  const user = await User.findOne({
    email: email.toLowerCase().trim(),
    resetPasswordToken: resetTokenHash,
    resetPasswordExpires: { $gt: new Date() },
    active: true
  });

  if (!user) {
    throw new ApiError('Invalid or expired reset token', 400, 'INVALID_RESET_TOKEN');
  }

  // Update password (pre-save hook will hash it)
  user.passwordHash = newPassword;
  user.resetPasswordToken = undefined;
  user.resetPasswordExpires = undefined;
  user.passwordChangedAt = new Date();
  user.failedLoginAttempts = 0;
  user.lockedUntil = undefined;
  
  await user.save();

  // Invalidate all OTPs for this email
  await OTP.updateMany(
    { email: user.email },
    { $set: { expiresAt: new Date() } }
  );

  // Send success email
  emailService.sendPasswordResetSuccess(user.email, user.name).catch(() => {});

  res.json(
    successResponse(
      { message: 'Password reset successfully. You can now login with your new password.' },
      'Password reset successful'
    )
  );
}));

/**
 * POST /api/auth/resend-otp
 * Resend OTP (with rate limiting)
 */
router.post('/resend-otp', otpLimiter, asyncHandler(async (req, res) => {
  const { email } = req.body;

  if (!email) {
    throw new ApiError('Email is required', 400, 'VALIDATION_ERROR');
  }

  // Check if email service is configured
  if (!emailService.isConfigured()) {
    throw new ApiError(
      'Email service not configured. Please contact administrator.',
      503,
      'SERVICE_UNAVAILABLE'
    );
  }

  // Find user
  const user = await User.findOne({ 
    email: email.toLowerCase().trim(),
    active: true 
  }).select('email name messId');

  if (!user) {
    return res.json(
      successResponse(
        { message: 'If the email exists, an OTP has been sent.' },
        'OTP request processed'
      )
    );
  }

  // Check if there's a recent OTP (prevent spam)
  const recentOtp = await OTP.findOne({
    email: user.email,
    messId: user.messId,
    createdAt: { $gt: new Date(Date.now() - 60 * 1000) } // Within last 1 minute
  });

  if (recentOtp) {
    throw new ApiError('Please wait 1 minute before requesting a new OTP', 429, 'TOO_SOON');
  }

  // Invalidate existing OTPs
  await OTP.updateMany(
    { email: user.email, messId: user.messId, verified: false },
    { $set: { expiresAt: new Date() } }
  );

  // Generate new OTP
  const otp = crypto.randomInt(100000, 999999).toString();

  // Create OTP record
  const otpRecord = await OTP.create({
    email: user.email,
    messId: user.messId,
    otp,
    purpose: 'password_reset',
    expiresAt: new Date(Date.now() + 10 * 60 * 1000),
    ipAddress: req.ip
  });

  // Send OTP
  try {
    await emailService.sendOTP(user.email, otp, 'password_reset');
  } catch (error) {
    await OTP.findByIdAndDelete(otpRecord._id);
    throw new ApiError('Failed to send OTP email. Please try again.', 500, 'EMAIL_SEND_FAILED');
  }

  res.json(
    successResponse(
      { 
        message: 'New OTP sent to your email address',
        expiresIn: 600
      },
      'OTP resent successfully'
    )
  );
}));

export default router;
