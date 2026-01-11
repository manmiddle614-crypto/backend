import mongoose from 'mongoose';

const messSchema = new mongoose.Schema(
  {
    name: { 
      type: String, 
      required: true,
      trim: true
    },
    ownerId: {
      type: mongoose.Schema.Types.ObjectId,
      ref: 'User',
      default: null,
      index: true
    },
    ownerName: { 
      type: String, 
      required: true,
      trim: true
    },
    ownerEmail: { 
      type: String, 
      required: true, 
      unique: true,
      lowercase: true,
      trim: true,
      index: true
    },
    ownerPhone: { 
      type: String, 
      required: true,
      trim: true
    },
    subscriptionStatus: {
      type: String,
      enum: ['trial', 'active', 'expired', 'cancelled'],
      default: 'trial'
    },
    trialStartedAt: {
      type: Date,
      default: Date.now
    },
    trialEndsAt: {
      type: Date,
      required: true
    },
    subscriptionEndsAt: {
      type: Date,
      default: null
    },
    subscriptionTier: {
      type: String,
      enum: ['standard'],
      default: 'standard'
    },
    features: {
      maxCustomers: { type: Number, default: 999999 },
      maxStaff: { type: Number, default: 999999 },
      advancedReports: { type: Boolean, default: true }
    },
    active: {
      type: Boolean,
      default: true
    },
    // 🚨 MEAL TIMINGS (PER MESS CONFIGURATION)
    mealTimings: {
      breakfast: {
        start: { type: String, default: '06:00' },
        end: { type: String, default: '10:00' }
      },
      lunch: {
        start: { type: String, default: '12:00' },
        end: { type: String, default: '15:00' }
      },
      dinner: {
        start: { type: String, default: '19:00' },
        end: { type: String, default: '22:00' }
      }
    }
  },
  { 
    timestamps: true 
  }
);

// Index for quick lookup
messSchema.index({ ownerEmail: 1 });
messSchema.index({ subscriptionStatus: 1 });

// Virtual to check if trial is active
messSchema.virtual('isTrialActive').get(function() {
  return this.subscriptionStatus === 'trial' && new Date() < this.trialEndsAt;
});

// Virtual to check if subscription is valid
messSchema.virtual('hasValidSubscription').get(function() {
  if (this.subscriptionStatus === 'trial') {
    return new Date() < this.trialEndsAt;
  }
  if (this.subscriptionStatus === 'active') {
    return !this.subscriptionEndsAt || new Date() < this.subscriptionEndsAt;
  }
  return false;
});

export const Mess = mongoose.model('Mess', messSchema);
