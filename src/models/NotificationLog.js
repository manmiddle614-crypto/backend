import mongoose from 'mongoose';

const notificationLogSchema = new mongoose.Schema({
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    required: true,
    index: true
  },
  date: {
    type: String, // YYYY-MM-DD
    required: true
  },
  type: {
    type: String,
    enum: ['breakfast', 'lunch', 'dinner', 'closed', 'opened', 'manual'],
    required: true
  },
  sentAt: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

// Compound index for duplicate prevention
notificationLogSchema.index({ messId: 1, date: 1, type: 1 }, { unique: true });

// TTL index - auto-delete after 90 days
notificationLogSchema.index({ createdAt: 1 }, { expireAfterSeconds: 7776000 });

export default mongoose.model('NotificationLog', notificationLogSchema);
