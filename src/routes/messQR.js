import express from 'express';
import jwt from 'jsonwebtoken';
import QRCode from 'qrcode';
import MessQR from '../models/MessQR.js';
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

// POST /api/admin/mess-qr - Generate or get existing mess QR
router.post('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const messId = req.user.messId;

    // Check if QR already exists
    let messQR = await MessQR.findOne({ messId, active: true });

    if (!messQR) {
      // Generate new QR token
      const qrToken = jwt.sign(
        {
          type: 'MESS_QR',
          messId: messId.toString()
        },
        process.env.JWT_SECRET,
        { expiresIn: '10y' } // Long-lived token
      );

      messQR = await MessQR.create({
        messId,
        qrToken,
        active: true
      });
    }

    // Generate QR code image
    const qrImage = await QRCode.toDataURL(messQR.qrToken, {
      width: 400,
      margin: 2,
      color: {
        dark: '#000000',
        light: '#FFFFFF'
      }
    });

    res.json({
      success: true,
      data: {
        qrToken: messQR.qrToken,
        qrImage,
        messId: messQR.messId,
        createdAt: messQR.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

// GET /api/admin/mess-qr - Get existing mess QR
router.get('/', requireAuth, requireAdmin, async (req, res) => {
  try {
    const messId = req.user.messId;

    const messQR = await MessQR.findOne({ messId, active: true });

    if (!messQR) {
      return res.status(404).json({
        success: false,
        error: { message: 'Mess QR not found', code: 'NOT_FOUND' }
      });
    }

    const qrImage = await QRCode.toDataURL(messQR.qrToken, {
      width: 400,
      margin: 2
    });

    res.json({
      success: true,
      data: {
        qrToken: messQR.qrToken,
        qrImage,
        messId: messQR.messId,
        createdAt: messQR.createdAt
      }
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: { message: error.message, code: 'SERVER_ERROR' }
    });
  }
});

export default router;
