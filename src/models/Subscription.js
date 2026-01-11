import mongoose from 'mongoose';

const subscriptionSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  planId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Plan',
    required: true
  },
  mealsTotal: {
    type: Number,
    min: 0,
    default: 0
  },
  mealsRemaining: {
    type: Number,
    min: 0,
    default: 0
  },
  // NEW: Per-meal balances (runtime state)
  mealBalances: {
    breakfast: { type: Number, default: 0, min: 0 },
    lunch: { type: Number, default: 0, min: 0 },
    dinner: { type: Number, default: 0, min: 0 },
    snack: { type: Number, default: 0, min: 0 }
  },
  startDate: {
    type: Date,
    required: true,
    default: Date.now
  },
  endDate: {
    type: Date,
    required: true
  },
  paidAmount: {
    type: Number,
    required: true,
    min: 0
  },
  paymentStatus: {
    type: String,
    enum: ['pending', 'paid', 'partial', 'refunded'],
    default: 'pending'
  },
  active: {
    type: Boolean,
    default: true
  },
  autoRenew: {
    type: Boolean,
    default: false
  },
  needsRenewal: {
    type: Boolean,
    default: false
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 500
  },
  // Track meal usage patterns
  mealHistory: [{
    date: { type: Date, default: Date.now },
    breakfast: { type: Number, default: 0 },
    lunch: { type: Number, default: 0 },
    dinner: { type: Number, default: 0 }
  }],
  // Pause/resume functionality
  pausedAt: Date,
  pausedDays: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Indexes for performance
subscriptionSchema.index({ messId: 1, customerId: 1 });
subscriptionSchema.index({ messId: 1, planId: 1 });
subscriptionSchema.index({ messId: 1, active: 1 });
subscriptionSchema.index({ messId: 1, status: 1 });
subscriptionSchema.index({ messId: 1, createdAt: -1 });
subscriptionSchema.index({ endDate: 1 });
subscriptionSchema.index({ paymentStatus: 1 });
subscriptionSchema.index({ messId: 1, customerId: 1, active: 1 });
// Meal balance indexes for performance
subscriptionSchema.index({ messId: 1, 'mealBalances.breakfast': 1 });
subscriptionSchema.index({ messId: 1, 'mealBalances.lunch': 1 });
subscriptionSchema.index({ messId: 1, 'mealBalances.dinner': 1 });

// Virtual for total meals remaining from balances
subscriptionSchema.virtual('totalMealsRemaining').get(function() {
  if (!this.mealBalances) return this.mealsRemaining || 0;
  return Object.values(this.mealBalances).reduce((sum, val) => sum + (val || 0), 0);
});

// Virtual for subscription status
subscriptionSchema.virtual('status').get(function() {
  const now = new Date();
  if (!this.active) return 'inactive';
  if (this.endDate < now) return 'expired';
  const remaining = this.totalMealsRemaining || this.mealsRemaining;
  if (remaining <= 0) return 'exhausted';
  if (this.pausedAt) return 'paused';
  return 'active';
});

// Virtual for days remaining
subscriptionSchema.virtual('daysRemaining').get(function() {
  const now = new Date();
  const diffTime = this.endDate - now;
  return Math.max(0, Math.ceil(diffTime / (1000 * 60 * 60 * 24)));
});

// Virtual for usage percentage
subscriptionSchema.virtual('usagePercentage').get(function() {
  const total = this.mealsTotal || 0;
  if (total <= 0) return 0;
  const remaining = this.totalMealsRemaining || this.mealsRemaining || 0;
  const used = total - remaining;
  return Math.round((used / total) * 100);
});

// Method to check if subscription is valid for meal
subscriptionSchema.methods.isValidForMeal = function(mealType) {
  const now = new Date();
  const hasBalance = this.mealBalances && this.mealBalances[mealType] > 0;
  const hasLegacy = !this.mealBalances && this.mealsRemaining > 0;
  
  return this.active && 
         (hasBalance || hasLegacy) &&
         this.endDate >= now && 
         this.paymentStatus === 'paid' &&
         !this.pausedAt;
};

// Method to deduct meal atomically (per meal type)
subscriptionSchema.methods.deductMeal = async function(mealType) {
  // New system: deduct from mealBalances
  if (this.mealBalances && mealType) {
    const result = await this.constructor.findOneAndUpdate(
      { 
        _id: this._id, 
        [`mealBalances.${mealType}`]: { $gt: 0 },
        active: true
      },
      { 
        $inc: { [`mealBalances.${mealType}`]: -1 }
      },
      { new: true }
    );
    return result;
  }
  
  // Legacy system: deduct from mealsRemaining
  const result = await this.constructor.findOneAndUpdate(
    { 
      _id: this._id, 
      mealsRemaining: { $gt: 0 },
      active: true
    },
    { 
      $inc: { mealsRemaining: -1 }
    },
    { new: true }
  );
  return result;
};

// Pre-save middleware to set end date
subscriptionSchema.pre('save', function(next) {
  if (this.isNew && !this.endDate) {
    const plan = this.populated('planId') || this.planId;
    if (plan && plan.durationDays) {
      this.endDate = new Date(this.startDate.getTime() + (plan.durationDays * 24 * 60 * 60 * 1000));
    }
  }
  next();
});

// Ensure virtuals are included in JSON
subscriptionSchema.set('toJSON', { virtuals: true });

export const Subscription = mongoose.model('Subscription', subscriptionSchema);