import mongoose from 'mongoose';

const planOverrideSchema = new mongoose.Schema(
  {
    messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
    overrideType: { type: String, enum: ['STAFF_LIMIT', 'CUSTOMER_LIMIT'], required: true },
    originalLimit: { type: Number, required: true },
    newLimit: { type: Number, required: true },
    expiresAt: { type: Date, default: null },
    reason: { type: String, required: true },
    createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'SuperAdmin', required: true },
    active: { type: Boolean, default: true }
  },
  { timestamps: true }
);

planOverrideSchema.index({ messId: 1, overrideType: 1, active: 1 });
planOverrideSchema.index({ expiresAt: 1 });

export const PlanOverride = mongoose.model('PlanOverride', planOverrideSchema);
