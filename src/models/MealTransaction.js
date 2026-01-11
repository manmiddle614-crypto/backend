import mongoose from 'mongoose';

const mealTransactionSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true
  },
  subscriptionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Subscription',
    required: true
  },
  scannedByUserId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  staffId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true
  },
  staffName: { type: String },
  mealType: {
    type: String,
    enum: ['breakfast', 'lunch', 'dinner'],
    required: true
  },
  status: {
    type: String,
    enum: ['success', 'blocked', 'failed', 'duplicate'],
    required: true
  },
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  },
  // QR scan details
  qrCodeId: {
    type: String,
    required: true
  },
  scanLocation: {
    type: String,
    trim: true
  },
  // Meal details
  mealsRemainingBefore: {
    type: Number,
    required: true
  },
  mealsRemainingAfter: {
    type: Number,
    required: true
  },
  // Failure reasons
  failureReason: {
    type: String,
    enum: [
      'no_subscription',
      'subscription_expired', 
      'no_meals_remaining',
      'duplicate_scan',
      'invalid_meal_window',
      'invalid_qr',
      'customer_inactive',
      'subscription_paused'
    ]
  },
  // Duplicate detection
  duplicateOfTransaction: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'MealTransaction'
  },
  // Offline sync
  clientTimestamp: Date,
  clientId: String,
  syncedAt: Date,
  // Additional metadata
  deviceInfo: {
    userAgent: String,
    ipAddress: String,
    deviceId: String
  },
  notes: {
    type: String,
    trim: true,
    maxlength: 200
  }
}, {
  timestamps: true
});

// Indexes for performance and queries
mealTransactionSchema.index({ messId: 1, customerId: 1 });
mealTransactionSchema.index({ messId: 1, subscriptionId: 1 });
mealTransactionSchema.index({ messId: 1, timestamp: -1 });
mealTransactionSchema.index({ messId: 1, mealType: 1, timestamp: -1 });
mealTransactionSchema.index({ messId: 1, status: 1 });
mealTransactionSchema.index({ scannedByUserId: 1, timestamp: -1 });
mealTransactionSchema.index({ staffId: 1, timestamp: -1 });
mealTransactionSchema.index({ qrCodeId: 1, timestamp: -1 });

// Compound indexes for common queries
mealTransactionSchema.index({ customerId: 1, timestamp: -1 });
mealTransactionSchema.index({ customerId: 1, mealType: 1, timestamp: -1 });
mealTransactionSchema.index({ 
  customerId: 1, 
  subscriptionId: 1, 
  mealType: 1, 
  timestamp: -1 
});

// Index for duplicate detection
mealTransactionSchema.index({ 
  customerId: 1, 
  mealType: 1, 
  timestamp: -1 
}, { 
  partialFilterExpression: { status: 'success' }
});

// Unique compound index for idempotency (prevents duplicate scans in same meal window)
// This is a sparse index that only applies to successful scans
mealTransactionSchema.index(
  { 
    customerId: 1, 
    mealType: 1,
    status: 1
  },
  { 
    unique: true,
    partialFilterExpression: { 
      status: 'success',
      timestamp: { $exists: true }
    },
    name: 'idempotency_key'
  }
);

// Virtual for formatted timestamp
mealTransactionSchema.virtual('formattedTime').get(function() {
  return this.timestamp.toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit'
  });
});

// Virtual for meal window
mealTransactionSchema.virtual('mealWindow').get(function() {
  const hour = this.timestamp.getHours();
  if (hour >= 6 && hour < 10) return 'breakfast';
  if (hour >= 12 && hour < 15) return 'lunch';
  if (hour >= 19 && hour < 22) return 'dinner';
  return 'other';
});

// Static method to find recent transactions for duplicate detection
mealTransactionSchema.statics.findRecentTransaction = function(customerId, mealType, windowSeconds = 30) {
  const windowStart = new Date(Date.now() - (windowSeconds * 1000));
  
  return this.findOne({
    customerId,
    mealType,
    status: 'success',
    timestamp: { $gte: windowStart }
  }).sort({ timestamp: -1 });
};

// Static method for daily meal stats
mealTransactionSchema.statics.getDailyStats = function(messId, date = new Date()) {
  const startOfDay = new Date(date);
  startOfDay.setHours(0, 0, 0, 0);
  
  const endOfDay = new Date(date);
  endOfDay.setHours(23, 59, 59, 999);
  
  return this.aggregate([
    {
      $match: {
        messId, // 🔒 TENANT ISOLATION
        timestamp: { $gte: startOfDay, $lte: endOfDay },
        status: 'success'
      }
    },
    {
      $group: {
        _id: '$mealType',
        count: { $sum: 1 },
        uniqueCustomers: { $addToSet: '$customerId' }
      }
    },
    {
      $project: {
        mealType: '$_id',
        count: 1,
        uniqueCustomers: { $size: '$uniqueCustomers' }
      }
    }
  ]);
};

// Method to check if transaction is a duplicate
mealTransactionSchema.methods.isDuplicate = async function(windowSeconds = 30) {
  const recent = await this.constructor.findRecentTransaction(
    this.customerId, 
    this.mealType, 
    windowSeconds
  );
  
  return recent && recent._id.toString() !== this._id.toString();
};

// Ensure virtuals are included in JSON
mealTransactionSchema.set('toJSON', { virtuals: true });

export const MealTransaction = mongoose.model('MealTransaction', mealTransactionSchema);