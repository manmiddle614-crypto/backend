import express from 'express';
import Attendance from '../models/Attendance.js';
import { Customer } from '../models/Customer.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

// Middleware to check admin/staff role
const requireAdmin = (req, res, next) => {
  if (!['admin', 'staff'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: { message: 'Admin access required', code: 'FORBIDDEN' }
    });
  }
  next();
};

// GET today's attendance summary
router.get('/today', requireAuth, requireAdmin, async (req, res) => {
  try {
    const today = Attendance.getDateOnly();
    const messId = req.user.messId;

    // Get all attendance for today
    const attendances = await Attendance.find({
      messId,
      date: today
    }).lean();

    // Calculate counts
    const summary = {
      totalCustomers: attendances.length,
      comingCount: 0,
      notComingCount: 0,
      pendingCount: 0,
      mealWise: {
        breakfast: 0,
        lunch: 0,
        dinner: 0
      }
    };

    attendances.forEach(att => {
      if (att.status === 'YES') {
        summary.comingCount++;
        att.mealTypes?.forEach(meal => {
          if (summary.mealWise[meal] !== undefined) {
            summary.mealWise[meal]++;
          }
        });
      } else if (att.status === 'NO') {
        summary.notComingCount++;
      } else {
        summary.pendingCount++;
      }
    });

    res.json({
      success: true,
      data: summary
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

// GET customer list by status
router.get('/list', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { status, page = 1, limit = 50 } = req.query;
    const today = Attendance.getDateOnly();
    const messId = req.user.messId;

    const query = { messId, date: today };
    if (status) query.status = status.toUpperCase();

    const skip = (page - 1) * limit;

    const [attendances, total] = await Promise.all([
      Attendance.find(query)
        .populate('customerId', 'name phone roomNo')
        .sort({ status: 1, respondedAt: -1 })
        .skip(skip)
        .limit(parseInt(limit))
        .lean(),
      Attendance.countDocuments(query)
    ]);

    const customers = attendances.map(att => ({
      customerId: att.customerId._id,
      name: att.customerId.name,
      phone: att.customerId.phone,
      roomNo: att.customerId.roomNo,
      status: att.status,
      mealTypes: att.mealTypes || [],
      respondedAt: att.respondedAt
    }));

    res.json({
      success: true,
      data: {
        customers,
        pagination: {
          page: parseInt(page),
          limit: parseInt(limit),
          total,
          pages: Math.ceil(total / limit)
        }
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

// GET attendance stats for date range
router.get('/stats', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { startDate, endDate } = req.query;
    const messId = req.user.messId;

    const start = startDate ? new Date(startDate) : Attendance.getDateOnly();
    const end = endDate ? new Date(endDate) : start;

    const stats = await Attendance.aggregate([
      {
        $match: {
          messId,
          date: { $gte: start, $lte: end }
        }
      },
      {
        $group: {
          _id: { date: '$date', status: '$status' },
          count: { $sum: 1 }
        }
      },
      {
        $sort: { '_id.date': -1 }
      }
    ]);

    res.json({
      success: true,
      data: stats
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

export default router;
