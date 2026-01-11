import mongoose from 'mongoose';

const paymentSchema = new mongoose.Schema({
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    required: true,
    index: true
  },
  planKey: {
    type: String,
    enum: ['BASIC', 'STANDARD', 'PRO'],
    required: true
  },
  billingCycle: {
    type: String,
    enum: ['monthly', '6month', 'yearly'],
    required: true
  },
  amountExpected: {
    type: Number,
    required: true
  },
  amountPaid: {
    type: Number,
    default: 0
  },
  currency: {
    type: String,
    default: 'INR',
    required: true
  },
  razorpayOrderId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  razorpayPaymentId: {
    type: String,
    index: true
  },
  razorpaySignature: String,
  status: {
    type: String,
    enum: ['created', 'paid', 'failed'],
    default: 'created',
    required: true,
    index: true
  },
  idempotencyKey: {
    type: String,
    unique: true,
    sparse: true,
    index: true
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed
  }
}, {
  timestamps: true,
  // Make immutable after creation
  strict: 'throw'
});

// Prevent updates after payment is marked as paid
paymentSchema.pre('save', function(next) {
  if (!this.isNew && this.isModified('status') && this.status === 'paid') {
    const error = new Error('Cannot modify paid payment record');
    return next(error);
  }
  next();
});

// Index for quick lookups
paymentSchema.index({ messId: 1, status: 1, createdAt: -1 });
paymentSchema.index({ razorpayPaymentId: 1 }, { sparse: true });

export const Payment = mongoose.model('Payment', paymentSchema);
