import express from 'express';
import MessSettings from '../models/MessSettings.js';
import NotificationLog from '../models/NotificationLog.js';
import { Customer } from '../models/Customer.js';
import { requireAuth } from '../middleware/auth.js';

const router = express.Router();

const requireAdmin = (req, res, next) => {
  if (!['admin', 'staff'].includes(req.user.role)) {
    return res.status(403).json({
      success: false,
      error: { message: 'Admin access required', code: 'FORBIDDEN' }
    });
  }
  next();
};

// GET current settings
router.get('/mess-settings', requireAuth, requireAdmin, async (req, res) => {
  try {
    let settings = await MessSettings.findOne({ messId: req.user.messId });

    // Create default if not exists
    if (!settings) {
      settings = await MessSettings.create({
        messId: req.user.messId,
        notifications: {
          breakfast: { enabled: true, time: '07:30' },
          lunch: { enabled: true, time: '12:30' },
          dinner: { enabled: true, time: '19:30' }
        },
        messStatus: { isOpen: true, closedMessage: '' },
        timezone: 'Asia/Kolkata'
      });
    }

    res.json({
      success: true,
      data: settings
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

// UPDATE notification times
router.put('/mess-settings/notifications', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { breakfast, lunch, dinner } = req.body;

    const updateData = {};
    if (breakfast) {
      updateData['notifications.breakfast'] = breakfast;
    }
    if (lunch) {
      updateData['notifications.lunch'] = lunch;
    }
    if (dinner) {
      updateData['notifications.dinner'] = dinner;
    }

    const settings = await MessSettings.findOneAndUpdate(
      { messId: req.user.messId },
      { $set: updateData },
      { new: true, upsert: true }
    );

    res.json({
      success: true,
      data: settings,
      message: 'Notification settings updated'
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

// OPEN / CLOSE mess
router.put('/mess-settings/status', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { isOpen, closedMessage } = req.body;

    const settings = await MessSettings.findOneAndUpdate(
      { messId: req.user.messId },
      {
        $set: {
          'messStatus.isOpen': isOpen,
          'messStatus.closedMessage': closedMessage || ''
        }
      },
      { new: true, upsert: true }
    );

    // Send instant notification to all customers
    const customers = await Customer.find({
      messId: req.user.messId,
      active: true
    }).select('_id name phone');

    const io = req.app.get('io');
    if (io && customers.length > 0) {
      const notificationType = isOpen ? 'opened' : 'closed';
      const message = isOpen
        ? '✅ Mess is now OPEN! You can scan meals.'
        : `🚫 Mess is CLOSED.\n${closedMessage || 'Will reopen soon.'}`;

      // Emit to all customers
      customers.forEach(customer => {
        io.to(`customer_${customer._id}`).emit('mess_status_changed', {
          isOpen,
          message,
          closedMessage
        });
      });

      // Log notification
      try {
        await NotificationLog.create({
          messId: req.user.messId,
          date: new Date().toISOString().split('T')[0],
          type: notificationType
        });
      } catch (logErr) {
        // Ignore duplicate log errors
      }
    }

    res.json({
      success: true,
      data: settings,
      message: `Mess ${isOpen ? 'opened' : 'closed'} successfully. ${customers.length} customers notified.`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

// MANUAL broadcast notification
router.post('/notify', requireAuth, requireAdmin, async (req, res) => {
  try {
    const { title, message, type = 'manual' } = req.body;

    if (!title || !message) {
      return res.status(400).json({
        success: false,
        error: { message: 'Title and message required', code: 'INVALID_INPUT' }
      });
    }

    // Get all active customers
    const customers = await Customer.find({
      messId: req.user.messId,
      active: true
    }).select('_id');

    const io = req.app.get('io');
    if (io && customers.length > 0) {
      customers.forEach(customer => {
        io.to(`customer_${customer._id}`).emit('manual_notification', {
          title,
          message,
          timestamp: new Date().toISOString()
        });
      });

      // Log notification
      await NotificationLog.create({
        messId: req.user.messId,
        date: new Date().toISOString().split('T')[0],
        type
      }).catch(() => {});
    }

    res.json({
      success: true,
      message: `Notification sent to ${customers.length} customers`
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

export default router;
