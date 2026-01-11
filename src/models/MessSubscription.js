import mongoose from 'mongoose';

const messSubscriptionSchema = new mongoose.Schema({
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    required: true,
    unique: true,
    index: true
  },
  planName: {
    type: String,
    enum: ['BASIC', 'STANDARD', 'PRO', 'TRIAL'],
    default: 'STANDARD',
    required: true,
    uppercase: true
  },
  price: {
    type: Number,
    required: true,
    default: 999
  },
  billingCycle: {
    type: String,
    enum: ['monthly', '6month', 'yearly'],
    default: 'monthly',
    required: true
  },
  status: {
    type: String,
    enum: ['trial', 'active', 'grace', 'past_due', 'expired', 'cancelled'],
    default: 'trial',
    required: true,
    index: true
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
  trialEndsAt: {
    type: Date,
    required: true
  },
  // Payment Gateway
  paymentGateway: {
    type: String,
    enum: ['razorpay', 'manual'],
    default: 'razorpay'
  },
  razorpayOrderId: String,
  razorpayPaymentId: String,
  razorpaySignature: String,
  paymentReference: String,
  // Billing History
  lastPaymentDate: Date,
  nextBillingDate: Date,
  // Grace Period
  gracePeriodEndsAt: Date,
  // Cancellation
  cancelledAt: Date,
  cancellationReason: String,
  // Auto-renewal
  autoRenew: {
    type: Boolean,
    default: true
  },
  // Notifications
  warningEmailSent: {
    type: Boolean,
    default: false
  },
  expiryEmailSent: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes
messSubscriptionSchema.index({ status: 1, endDate: 1 });
messSubscriptionSchema.index({ status: 1, trialEndsAt: 1 });
messSubscriptionSchema.index({ nextBillingDate: 1 });

// Virtuals
messSubscriptionSchema.virtual('isActive').get(function() {
  return ['trial', 'active'].includes(this.status) && new Date() < this.endDate;
});

messSubscriptionSchema.virtual('daysRemaining').get(function() {
  const now = new Date();
  const end = this.status === 'trial' ? this.trialEndsAt : this.endDate;
  const diff = end - now;
  return Math.max(0, Math.ceil(diff / (1000 * 60 * 60 * 24)));
});

messSubscriptionSchema.virtual('isInGracePeriod').get(function() {
  if (!this.gracePeriodEndsAt) return false;
  return new Date() < this.gracePeriodEndsAt;
});

messSubscriptionSchema.virtual('needsWarning').get(function() {
  if (this.warningEmailSent) return false;
  if (this.status === 'trial') {
    return this.daysRemaining <= 2;
  }
  if (this.status === 'active') {
    return this.daysRemaining <= 3;
  }
  return false;
});

// Methods
messSubscriptionSchema.methods.activateSubscription = function(paymentDetails) {
  this.status = 'active';
  this.lastPaymentDate = new Date();
  this.nextBillingDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  this.endDate = this.nextBillingDate;
  
  if (paymentDetails) {
    this.razorpayPaymentId = paymentDetails.razorpayPaymentId;
    this.razorpaySignature = paymentDetails.razorpaySignature;
    this.paymentReference = paymentDetails.razorpayPaymentId;
  }
  
  return this.save();
};

messSubscriptionSchema.methods.expireSubscription = function() {
  this.status = 'expired';
  this.gracePeriodEndsAt = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000); // 7 days grace
  return this.save();
};

messSubscriptionSchema.methods.cancelSubscription = function(reason) {
  this.status = 'cancelled';
  this.cancelledAt = new Date();
  this.cancellationReason = reason;
  this.autoRenew = false;
  return this.save();
};

messSubscriptionSchema.methods.markPastDue = function() {
  this.status = 'past_due';
  return this.save();
};

// Static methods
messSubscriptionSchema.statics.findExpiringSoon = function(days = 2) {
  const futureDate = new Date(Date.now() + days * 24 * 60 * 60 * 1000);
  return this.find({
    status: { $in: ['trial', 'active'] },
    $or: [
      { trialEndsAt: { $lte: futureDate, $gte: new Date() } },
      { endDate: { $lte: futureDate, $gte: new Date() } }
    ],
    warningEmailSent: false
  });
};

messSubscriptionSchema.statics.findExpired = function() {
  return this.find({
    status: { $in: ['trial', 'active'] },
    $or: [
      { trialEndsAt: { $lt: new Date() } },
      { endDate: { $lt: new Date() } }
    ]
  });
};

messSubscriptionSchema.set('toJSON', { virtuals: true });

export const MessSubscription = mongoose.model('MessSubscription', messSubscriptionSchema);
