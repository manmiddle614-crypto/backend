import mongoose from "mongoose"
import { v4 as uuidv4 } from "uuid"

const LedgerEntrySchema = new mongoose.Schema({
  amount: { type: Number, required: true },
  method: { 
    type: String, 
    enum: ['CASH', 'UPI', 'CARD', 'WALLET'], 
    required: true 
  },
  note: String,
  createdAt: { type: Date, default: Date.now },
  staffId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
}, { _id: false });

const customerSchema = new mongoose.Schema(
  {
    messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, index: true },
    name: { type: String, required: true },
    phone: { type: String, required: true },
    roomNo: { type: String, },
    qrCodeId: { type: String, required: true, default: () => uuidv4() },
    joinedAt: { type: Date, default: Date.now },
    active: { type: Boolean, default: true },
    pinHash: { type: String, default: null },
    pinChangedAt: { type: Date, default: null },
    pinFailedAttempts: { type: Number, default: 0 },
    pinLockedUntil: { type: Date, default: null },
    trustedDevices: [{
      tokenHash: String,
      name: String,
      createdAt: { type: Date, default: Date.now }
    }],
    // Existing customer tracking
    isExistingCustomer: { type: Boolean, default: false },
    previousMealsConsumed: { type: Number, default: 0 },
    messStartDate: { type: Date, default: null },
    // Payment & Balance
    balance: { type: Number, default: 0 },
    preferredPaymentMethod: { 
      type: String, 
      enum: ['CASH', 'UPI', 'CARD', 'WALLET', 'NONE'], 
      default: 'NONE' 
    },
    upiId: { type: String, default: null },
    lastPaymentAt: Date,
    autoRenew: { type: Boolean, default: false },
    billingAmount: { type: Number, default: 0 },
    billingCycleMeals: { type: Number, default: 30 },
    ledger: [LedgerEntrySchema],
  },
  { timestamps: true },
)

customerSchema.index({ messId: 1, phone: 1 }, { unique: true })
customerSchema.index({ messId: 1, qrCodeId: 1 }, { unique: true })
customerSchema.index({ messId: 1, active: 1 })
customerSchema.index({ messId: 1, createdAt: -1 })

export const Customer = mongoose.model("Customer", customerSchema)
