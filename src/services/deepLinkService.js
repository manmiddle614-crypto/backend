import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { ApiError } from '../utils/errorHandler.js';

class DeepLinkService {
  constructor() {
    this.secret = process.env.JWT_SECRET;
    this.appUrl = process.env.APP_URL || 'https://app.smartmess.com';
  }

  /**
   * Generate secure deep-link token (1-5 minute expiry)
   */
  generateDeepLink(customerId, messId, expiryMinutes = 3) {
    const nonce = crypto.randomBytes(16).toString('hex');
    
    const token = jwt.sign(
      {
        customerId,
        messId,
        nonce,
        type: 'deep_link_scan',
        iat: Math.floor(Date.now() / 1000)
      },
      this.secret,
      { expiresIn: `${expiryMinutes}m` }
    );

    return `${this.appUrl}/scan/verify?token=${encodeURIComponent(token)}`;
  }

  /**
   * Verify deep-link token
   */
  verifyDeepLink(token) {
    try {
      const decoded = jwt.verify(token, this.secret);
      
      if (decoded.type !== 'deep_link_scan') {
        throw new ApiError('Invalid token type', 400, 'INVALID_TOKEN_TYPE');
      }

      if (!decoded.customerId || !decoded.messId || !decoded.nonce) {
        throw new ApiError('Invalid token payload', 400, 'INVALID_TOKEN');
      }

      return {
        customerId: decoded.customerId,
        messId: decoded.messId,
        nonce: decoded.nonce,
        issuedAt: decoded.iat
      };
    } catch (error) {
      if (error.name === 'TokenExpiredError') {
        throw new ApiError('Link expired', 400, 'LINK_EXPIRED');
      }
      if (error.name === 'JsonWebTokenError') {
        throw new ApiError('Invalid link', 400, 'INVALID_LINK');
      }
      throw error;
    }
  }
}

export const deepLinkService = new DeepLinkService();
