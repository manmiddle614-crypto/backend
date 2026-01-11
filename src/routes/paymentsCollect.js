import express from 'express';
import { Customer } from '../models/Customer.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { asyncHandler } from '../utils/asyncHandler.js';
import { successResponse } from '../utils/response.js';
import { ApiError } from '../utils/errorHandler.js';
import { AuditLog } from '../models/AuditLog.js';

const router = express.Router();

// POST /payments - Staff collects payment
router.post('/', requireAuth, requireRole(['admin', 'staff']), asyncHandler(async (req, res) => {
  const { customerId, amount, method, note } = req.body;
  
  if (!customerId || !amount || !method) {
    throw new ApiError('Customer ID, amount, and method required', 400);
  }
  
  if (amount <= 0) {
    throw new ApiError('Amount must be greater than 0', 400);
  }
  
  if (!['CASH', 'UPI', 'CARD', 'WALLET'].includes(method)) {
    throw new ApiError('Invalid payment method', 400);
  }
  
  const customer = await Customer.findById(customerId);
  if (!customer) {
    throw new ApiError('Customer not found', 404);
  }
  
  // Add ledger entry
  customer.ledger.push({
    amount,
    method,
    note: note || 'Payment collected',
    staffId: req.user.id,
    createdAt: new Date()
  });
  
  customer.lastPaymentAt = new Date();
  customer.balance = Math.max(0, customer.balance - amount);
  await customer.save();
  
  // Audit log
  await AuditLog.create({
    messId: req.messId,
    action: 'payment_collected',
    userId: req.user.id,
    targetId: customer._id,
    targetType: 'Customer',
    details: { amount, method, note },
    ipAddress: req.ip
  });
  
  res.json(successResponse({ 
    message: 'Payment recorded successfully',
    customer: {
      name: customer.name,
      balance: customer.balance,
      lastPaymentAt: customer.lastPaymentAt
    }
  }));
}));

// GET /payments/customer/:id - Get customer payment history
router.get('/customer/:id', requireAuth, requireRole(['admin', 'staff']), asyncHandler(async (req, res) => {
  const { id } = req.params;
  
  const customer = await Customer.findById(id).select('name phone ledger balance lastPaymentAt');
  if (!customer) {
    throw new ApiError('Customer not found', 404);
  }
  
  res.json(successResponse({ 
    customer: {
      name: customer.name,
      phone: customer.phone,
      balance: customer.balance,
      lastPaymentAt: customer.lastPaymentAt,
      ledger: customer.ledger.sort((a, b) => b.createdAt - a.createdAt)
    }
  }));
}));

export default router;
