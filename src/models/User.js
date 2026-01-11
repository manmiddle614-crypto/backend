import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const userSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  phone: {
    type: String,
    trim: true,
    match: [/^[6-9]\d{9}$/, 'Please enter a valid Indian phone number']
  },
  passwordHash: {
    type: String,
    required: true,
    minlength: 6
  },
  role: {
    type: String,
    enum: ['admin', 'staff', 'manager'],
    default: 'staff'
  },
  permissions: [{
    type: String,
    enum: [
      'customers.read', 'customers.write', 'customers.delete',
      'plans.read', 'plans.write', 'plans.delete',
      'subscriptions.read', 'subscriptions.write', 'subscriptions.delete',
      'payments.read', 'payments.write', 'payments.delete',
      'reports.read', 'reports.export',
      'settings.read', 'settings.write',
      'users.read', 'users.write', 'users.delete',
      'scan.perform', 'scan.batch',
      'audit.read'
    ]
  }],
  active: {
    type: Boolean,
    default: true
  },
  // Login tracking
  lastLoginAt: Date,
  loginCount: {
    type: Number,
    default: 0
  },
  failedLoginAttempts: {
    type: Number,
    default: 0
  },
  lockedUntil: Date,
  // Profile information
  avatar: String,
  department: String,
  employeeId: {
    type: String,
    unique: true,
    sparse: true
  },
  // Security
  passwordChangedAt: Date,
  mustChangePassword: {
    type: Boolean,
    default: false
  },
  twoFactorEnabled: {
    type: Boolean,
    default: false
  },
  // Password reset
  resetPasswordToken: String,
  resetPasswordExpires: Date,
  // Session management
  refreshTokens: [{
    token: String,
    createdAt: { type: Date, default: Date.now },
    expiresAt: Date,
    deviceInfo: String
  }],
  // Preferences
  preferences: {
    theme: { type: String, enum: ['light', 'dark', 'auto'], default: 'light' },
    language: { type: String, default: 'en' },
    notifications: {
      email: { type: Boolean, default: true },
      push: { type: Boolean, default: true }
    }
  }
}, {
  timestamps: true
});

// Indexes
userSchema.index({ messId: 1, email: 1 }, { unique: true });
userSchema.index({ messId: 1, role: 1 });
userSchema.index({ messId: 1, active: 1 });
userSchema.index({ employeeId: 1 }, { unique: true, sparse: true });

// Virtual for full name (if needed)
userSchema.virtual('displayName').get(function() {
  return this.name || this.email.split('@')[0];
});

// Virtual for account status
userSchema.virtual('accountStatus').get(function() {
  if (!this.active) return 'inactive';
  if (this.lockedUntil && this.lockedUntil > new Date()) return 'locked';
  if (this.mustChangePassword) return 'password_change_required';
  return 'active';
});

// Pre-save middleware to hash password
userSchema.pre('save', async function(next) {
  // Only hash password if it's modified AND not already hashed
  if (!this.isModified('passwordHash')) return next();
  
  // Skip hashing if password is already a bcrypt hash (starts with $2a$ or $2b$)
  if (this.passwordHash && this.passwordHash.startsWith('$2')) {
    return next();
  }
  
  try {
    // Hash password with cost of 12
    const salt = await bcrypt.genSalt(12);
    this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
    
    // Set password changed timestamp
    if (!this.isNew) {
      this.passwordChangedAt = new Date();
    }
    
    next();
  } catch (error) {
    next(error);
  }
});

// Method to check password
userSchema.methods.comparePassword = async function(candidatePassword) {
  return bcrypt.compare(candidatePassword, this.passwordHash);
};

// Method to check if account is locked
userSchema.methods.isLocked = function() {
  return !!(this.lockedUntil && this.lockedUntil > Date.now());
};

// Method to increment login attempts
userSchema.methods.incLoginAttempts = function() {
  // If we have a previous lock that has expired, restart at 1
  if (this.lockedUntil && this.lockedUntil < Date.now()) {
    return this.updateOne({
      $unset: { lockedUntil: 1 },
      $set: { failedLoginAttempts: 1 }
    });
  }
  
  const updates = { $inc: { failedLoginAttempts: 1 } };
  
  // Lock account after 5 failed attempts for 30 minutes
  if (this.failedLoginAttempts + 1 >= 5 && !this.isLocked()) {
    updates.$set = { lockedUntil: Date.now() + 30 * 60 * 1000 }; // 30 minutes
  }
  
  return this.updateOne(updates);
};

// Method to reset login attempts
userSchema.methods.resetLoginAttempts = function() {
  return this.updateOne({
    $unset: { failedLoginAttempts: 1, lockedUntil: 1 },
    $set: { lastLoginAt: new Date() },
    $inc: { loginCount: 1 }
  });
};

// Method to check permissions
userSchema.methods.hasPermission = function(permission) {
  if (this.role === 'admin') return true; // Admin has all permissions
  return this.permissions.includes(permission);
};

// Method to add refresh token
userSchema.methods.addRefreshToken = function(token, expiresAt, deviceInfo) {
  this.refreshTokens.push({
    token,
    expiresAt,
    deviceInfo
  });
  
  // Keep only last 5 tokens
  if (this.refreshTokens.length > 5) {
    this.refreshTokens = this.refreshTokens.slice(-5);
  }
  
  return this.save();
};

// Method to remove refresh token
userSchema.methods.removeRefreshToken = function(token) {
  this.refreshTokens = this.refreshTokens.filter(rt => rt.token !== token);
  return this.save();
};

// Static method to find by email
userSchema.statics.findByEmail = function(email) {
  return this.findOne({ email: email.toLowerCase(), active: true });
};

// Static method to get role permissions
userSchema.statics.getRolePermissions = function(role) {
  const permissions = {
    admin: [
      'customers.read', 'customers.write', 'customers.delete',
      'plans.read', 'plans.write', 'plans.delete',
      'subscriptions.read', 'subscriptions.write', 'subscriptions.delete',
      'payments.read', 'payments.write', 'payments.delete',
      'reports.read', 'reports.export',
      'settings.read', 'settings.write',
      'users.read', 'users.write', 'users.delete',
      'scan.perform', 'scan.batch',
      'audit.read'
    ],
    manager: [
      'customers.read', 'customers.write',
      'plans.read', 'plans.write',
      'subscriptions.read', 'subscriptions.write',
      'payments.read', 'payments.write',
      'reports.read', 'reports.export',
      'settings.read',
      'users.read',
      'scan.perform', 'scan.batch',
      'audit.read'
    ],
    staff: [
      'customers.read',
      'subscriptions.read',
      'scan.perform', 'scan.batch'
    ]
  };
  
  return permissions[role] || [];
};

// Ensure virtuals are included in JSON
userSchema.set('toJSON', { 
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.passwordHash;
    delete ret.refreshTokens;
    return ret;
  }
});

export const User = mongoose.model('User', userSchema);