import jwt from 'jsonwebtoken';
import { ApiError } from '../utils/errorHandler.js';

class QRTokenService {
  getSecret() {
    const secret = process.env.QR_JWT_SECRET || process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('QR_JWT_SECRET or JWT_SECRET must be defined in environment variables');
    }
    return secret;
  }

  /**
   * Generate QR token (JWT)
   */
  generateToken(payload, expiryDays = 365) {
    return jwt.sign(
      {
        customerId: payload.customerId,
        messId: payload.messId,
        qrCodeId: payload.qrCodeId,
        type: 'qr_scan'
      },
      this.getSecret(),
      { expiresIn: `${expiryDays}d` }
    );
  }

  /**
   * Verify and decode QR token
   * Returns: { customerId, messId, qrCodeId }
   * Throws: ApiError if invalid
   */
  verifyToken(token) {
    try {
      const decoded = jwt.verify(token, this.getSecret());
      
      // Validate token type
      if (decoded.type !== 'qr_scan') {
        throw new ApiError('Invalid QR token type', 400, 'INVALID_QR_TOKEN');
      }

      // Validate required fields
      if (!decoded.customerId || !decoded.messId) {
        throw new ApiError('Invalid QR token payload', 400, 'INVALID_QR_TOKEN');
      }

      return {
        customerId: decoded.customerId,
        messId: decoded.messId,
        qrCodeId: decoded.qrCodeId
      };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new ApiError('QR code expired', 400, 'QR_EXPIRED');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new ApiError('Invalid QR code', 400, 'INVALID_QR_TOKEN');
      }
      throw error;
    }
  }

  /**
   * Get token information without verifying
   */
  getTokenInfo(token) {
    try {
      const decoded = jwt.decode(token);
      if (!decoded || !decoded.exp) {
        return { expiresAt: null, daysUntilExpiry: null };
      }
      
      const expiresAt = new Date(decoded.exp * 1000);
      const now = new Date();
      const daysUntilExpiry = Math.ceil((expiresAt - now) / (1000 * 60 * 60 * 24));
      
      return {
        expiresAt: expiresAt.toISOString(),
        daysUntilExpiry: Math.max(0, daysUntilExpiry)
      };
    } catch (error) {
      return { expiresAt: null, daysUntilExpiry: null };
    }
  }
}

export const qrTokenService = new QRTokenService();
