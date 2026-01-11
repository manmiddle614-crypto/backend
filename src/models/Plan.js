import mongoose from 'mongoose';

const planSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 100
  },
  description: {
    type: String,
    trim: true,
    maxlength: 500
  },
  mealCount: {
    type: Number,
    min: 0,
    default: 0
  },
  // NEW: Per-meal allocations (source of truth)
  mealAllocations: {
    breakfast: { type: Number, default: 0, min: 0 },
    lunch: { type: Number, default: 0, min: 0 },
    dinner: { type: Number, default: 0, min: 0 },
    snack: { type: Number, default: 0, min: 0 }
  },
  price: {
    type: Number,
    required: true,
    min: 0
  },
  durationDays: {
    type: Number,
    required: true,
    min: 1,
    max: 365
  },
  mealTypes: [{
    type: String,
    enum: ['breakfast', 'lunch', 'dinner', 'snacks']
  }],
  active: {
    type: Boolean,
    default: true
  },
  features: [{
    type: String,
    trim: true
  }],
  maxMealsPerDay: {
    type: Number,
    default: 3,
    min: 1,
    max: 10
  }
}, {
  timestamps: true
});

// Indexes
planSchema.index({ messId: 1, active: 1 });
planSchema.index({ messId: 1, price: 1 });
planSchema.index({ mealCount: 1 });

// Virtual for total meal count from allocations
planSchema.virtual('totalMeals').get(function() {
  if (!this.mealAllocations) return this.mealCount || 0;
  return Object.values(this.mealAllocations).reduce((sum, val) => sum + (val || 0), 0);
});

// Virtual for price per meal
planSchema.virtual('pricePerMeal').get(function() {
  const total = this.totalMeals || this.mealCount;
  return total > 0 ? (this.price / total).toFixed(2) : 0;
});

// Validation: At least one meal type must be > 0
planSchema.pre('save', function(next) {
  if (this.mealAllocations) {
    const total = Object.values(this.mealAllocations).reduce((sum, val) => sum + (val || 0), 0);
    if (total === 0 && !this.mealCount) {
      return next(new Error('At least one meal type must have allocation > 0'));
    }
    // Sync mealCount with allocations
    this.mealCount = total;
  }
  next();
});

// Ensure virtuals are included in JSON
planSchema.set('toJSON', { virtuals: true });

export const Plan = mongoose.model('Plan', planSchema);