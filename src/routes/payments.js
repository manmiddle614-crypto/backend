import express from "express";
import { Payment } from "../models/Payment.js";
import { Subscription } from "../models/Subscription.js";
import { ApiError } from "../utils/errorHandler.js";
import { successResponse } from "../utils/response.js";
import { requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

const recordPaymentHandler = asyncHandler(async (req, res) => {
  const { subscriptionId, amount, method, txnRef } = req.body;

  if (!subscriptionId || !amount || !method) {
    throw new ApiError("Missing required fields", 400, "VALIDATION_ERROR");
  }

  const subscription = await Subscription.findById(subscriptionId)
    .select('customerId paidAmount planId')
    .lean();
  if (!subscription) {
    throw new ApiError("Subscription not found", 404, "NOT_FOUND");
  }

  const payment = new Payment({
    subscriptionId,
    customerId: subscription.customerId,
    amount,
    method,
    txnRef,
    status: "success",
  });

  await payment.save();

  // Update subscription paid amount and status
  const totalPaid = subscription.paidAmount + amount;
  const planPrice = (await subscription.populate("planId")).planId.price;
  let paymentStatus = "pending";

  if (totalPaid >= planPrice) {
    paymentStatus = "paid";
  } else if (totalPaid > 0) {
    paymentStatus = "partial";
  }

  await Subscription.findByIdAndUpdate(subscriptionId, {
    paidAmount: totalPaid,
    paymentStatus,
  });

  res.status(201).json(successResponse(payment, "Payment recorded"));
});

const listPaymentsHandler = asyncHandler(async (req, res) => {
  const { customerId, subscriptionId, page = 1, limit = 20 } = req.query;

  const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
  const filter = {};

  if (customerId) filter.customerId = customerId;
  if (subscriptionId) filter.subscriptionId = subscriptionId;

  const payments = await Payment.find(filter)
    .select('customerId subscriptionId amount method txnRef status date createdAt')
    .populate("customerId", "name phone")
    .skip(skip)
    .limit(Number.parseInt(limit, 10))
    .sort({ date: -1 })
    .lean();

  const total = await Payment.countDocuments(filter);

  res.json(
    successResponse(
      {
        payments,
        pagination: {
          page: Number.parseInt(page, 10),
          limit: Number.parseInt(limit, 10),
          total,
          pages: Math.ceil(total / Number.parseInt(limit, 10)),
        },
      },
      "Payments retrieved",
    ),
  );
});

const paymentWebhookHandler = asyncHandler(async (req, res) => {
  const { event, data } = req.body;

  res.json({ success: true });
});

router.post("/admin/payments", requireRole("admin"), recordPaymentHandler);
router.get("/admin/payments", requireRole("admin"), listPaymentsHandler);
router.post("/payment/webhook", paymentWebhookHandler);

export default router;
