import mongoose from "mongoose"

const auditLogSchema = new mongoose.Schema(
  {
    messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
    action: { type: String, required: true },
    userId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    targetId: { type: mongoose.Schema.Types.ObjectId },
    targetType: { type: String },
    actorId: { type: mongoose.Schema.Types.ObjectId, ref: "User" },
    actorType: { type: String, enum: ["user", "system"], default: "user" },
    details: { type: mongoose.Schema.Types.Mixed },
    timestamp: { type: Date, default: Date.now },
    ipAddress: { type: String },
  },
  { timestamps: false },
)

auditLogSchema.index({ messId: 1, timestamp: -1 })
auditLogSchema.index({ messId: 1, action: 1, timestamp: -1 })

export const AuditLog = mongoose.model("AuditLog", auditLogSchema)
