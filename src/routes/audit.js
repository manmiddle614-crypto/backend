import express from "express";
import { AuditLog } from "../models/AuditLog.js";
import { successResponse } from "../utils/response.js";
import { ApiError } from "../utils/errorHandler.js";
import { requireRole } from "../middleware/auth.js";
import { asyncHandler } from "../utils/asyncHandler.js";

const router = express.Router();

const getAuditLogsHandler = asyncHandler(async (req, res) => {
  const { limit = 100, action, page = 1 } = req.query;

  const skip = (Number.parseInt(page, 10) - 1) * Number.parseInt(limit, 10);
  const filter = {};

  if (action) filter.action = action;

  const logs = await AuditLog.find(filter)
    .populate("actorId", "name email role")
    .skip(skip)
    .limit(Number.parseInt(limit, 10))
    .sort({ timestamp: -1 });

  const total = await AuditLog.countDocuments(filter);

  res.json(
    successResponse(
      {
        logs,
        pagination: {
          page: Number.parseInt(page, 10),
          limit: Number.parseInt(limit, 10),
          total,
          pages: Math.ceil(total / Number.parseInt(limit, 10)),
        },
      },
      "Audit logs retrieved",
    ),
  );
});

router.get("/admin/audit", requireRole("admin"), getAuditLogsHandler);

export default router;
