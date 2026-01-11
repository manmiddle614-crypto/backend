import mongoose from 'mongoose';

const otpSchema = new mongoose.Schema({
  email: {
    type: String,
    required: true,
    lowercase: true,
    trim: true,
    index: true
  },
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    index: true
  },
  otp: {
    type: String,
    required: true
  },
  purpose: {
    type: String,
    enum: ['password_reset', 'email_verification'],
    default: 'password_reset'
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },
  verified: {
    type: Boolean,
    default: false
  },
  attempts: {
    type: Number,
    default: 0
  },
  ipAddress: String
}, {
  timestamps: true
});

// Index for automatic deletion of expired OTPs
otpSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Index for finding active OTPs
otpSchema.index({ email: 1, messId: 1, verified: 0, expiresAt: 1 });

// Method to check if OTP is valid
otpSchema.methods.isValid = function() {
  return !this.verified && this.expiresAt > new Date() && this.attempts < 5;
};

// Method to verify OTP
otpSchema.methods.verify = function(inputOtp) {
  this.attempts += 1;
  
  if (!this.isValid()) {
    return false;
  }
  
  if (this.otp === inputOtp) {
    this.verified = true;
    return true;
  }
  
  return false;
};

export const OTP = mongoose.model('OTP', otpSchema);
