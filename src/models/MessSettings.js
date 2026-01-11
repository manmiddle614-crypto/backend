import mongoose from 'mongoose';

const messSettingsSchema = new mongoose.Schema({
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    required: true,
    unique: true,
    index: true
  },
  notifications: {
    breakfast: {
      enabled: { type: Boolean, default: true },
      time: { type: String, default: '07:30' } // HH:mm
    },
    lunch: {
      enabled: { type: Boolean, default: true },
      time: { type: String, default: '12:30' }
    },
    dinner: {
      enabled: { type: Boolean, default: true },
      time: { type: String, default: '19:30' }
    }
  },
  messStatus: {
    isOpen: { type: Boolean, default: true },
    closedMessage: { type: String, default: '' }
  },
  timezone: {
    type: String,
    default: 'Asia/Kolkata'
  }
}, {
  timestamps: true
});

messSettingsSchema.index({ messId: 1 });

export default mongoose.model('MessSettings', messSettingsSchema);
