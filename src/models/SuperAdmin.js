import mongoose from 'mongoose';
import bcrypt from 'bcryptjs';

const superAdminSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true },
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true },
  role: { type: String, default: 'SUPER_ADMIN', immutable: true },
  active: { type: Boolean, default: true },
  lastLoginAt: Date,
  loginCount: { type: Number, default: 0 }
}, { timestamps: true });

superAdminSchema.index({ email: 1 });

superAdminSchema.pre('save', async function(next) {
  if (!this.isModified('passwordHash')) return next();
  const salt = await bcrypt.genSalt(12);
  this.passwordHash = await bcrypt.hash(this.passwordHash, salt);
  next();
});

superAdminSchema.methods.comparePassword = async function(password) {
  return bcrypt.compare(password, this.passwordHash);
};

export const SuperAdmin = mongoose.model('SuperAdmin', superAdminSchema);
