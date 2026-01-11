import mongoose from 'mongoose';

const contactMessageSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  phone: { type: String, required: true, trim: true },
  email: { type: String, trim: true },
  topic: { 
    type: String, 
    enum: ['support', 'billing', 'feedback', 'other'],
    required: true 
  },
  message: { type: String, required: true, trim: true, maxlength: 1000 },
  status: { 
    type: String, 
    enum: ['new', 'resolved'],
    default: 'new'
  },
  ipAddress: { type: String },
  resolvedAt: { type: Date },
  resolvedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }
}, { timestamps: true });

contactMessageSchema.index({ status: 1, createdAt: -1 });
contactMessageSchema.index({ topic: 1 });

export const ContactMessage = mongoose.model('ContactMessage', contactMessageSchema);
