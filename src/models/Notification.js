import mongoose from 'mongoose';

const notificationSchema = new mongoose.Schema({
  messId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'Mess',
    required: true, 
    index: true 
  },
  userId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User',
    default: null,
    index: true
  },
  type: { 
    type: String, 
    required: true,
    enum: ['attendance', 'meal', 'system', 'admin', 'subscription', 'payment', 'emergency'],
    index: true
  },
  title: { type: String, required: true },
  message: { type: String, required: true },
  priority: { 
    type: String, 
    enum: ['LOW', 'MEDIUM', 'HIGH', 'CRITICAL'], 
    default: 'LOW',
    index: true
  },
  strict: { 
    type: Boolean, 
    default: false,
    index: true
  },
  read: { 
    type: Boolean, 
    default: false,
    index: true
  },
  actionUrl: { type: String },
  metadata: { type: mongoose.Schema.Types.Mixed },
  expiresAt: { type: Date, index: true },
  createdAt: { type: Date, default: Date.now, index: true }
}, { timestamps: true });

// Compound indexes for efficient queries
notificationSchema.index({ messId: 1, userId: 1, read: 1 });
notificationSchema.index({ messId: 1, strict: 1, read: 1 });
notificationSchema.index({ messId: 1, createdAt: -1 });

// TTL index for auto-cleanup
notificationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

export const Notification = mongoose.model('Notification', notificationSchema);
