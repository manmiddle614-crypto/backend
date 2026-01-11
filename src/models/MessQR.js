import mongoose from 'mongoose';

const messQRSchema = new mongoose.Schema({
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    required: true,
    unique: true,
    index: true
  },
  qrToken: {
    type: String,
    required: true
  },
  active: {
    type: Boolean,
    default: true
  }
}, {
  timestamps: true
});

messQRSchema.index({ messId: 1, active: 1 });

export default mongoose.model('MessQR', messQRSchema);
