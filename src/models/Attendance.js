import mongoose from 'mongoose';

const attendanceSchema = new mongoose.Schema({
  messId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Mess',
    required: true,
    index: true
  },
  customerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Customer',
    required: true,
    index: true
  },
  date: {
    type: Date,
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['YES', 'NO', 'PENDING'],
    default: 'PENDING',
    required: true
  },
  mealTypes: [{
    type: String,
    enum: ['breakfast', 'lunch', 'dinner']
  }],
  respondedAt: {
    type: Date
  }
}, {
  timestamps: true
});

// Compound indexes for performance
attendanceSchema.index({ messId: 1, date: 1 });
attendanceSchema.index({ customerId: 1, date: 1 }, { unique: true });
attendanceSchema.index({ messId: 1, date: 1, status: 1 });

// TTL index - auto-delete after 60 days
attendanceSchema.index({ createdAt: 1 }, { expireAfterSeconds: 5184000 });

// Helper method to get date without time
attendanceSchema.statics.getDateOnly = function(date = new Date()) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
};

export default mongoose.model('Attendance', attendanceSchema);
