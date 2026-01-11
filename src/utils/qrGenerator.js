import crypto from 'crypto';
import QRCode from 'qrcode';

const QR_HMAC_SECRET = process.env.QR_HMAC_SECRET || process.env.JWT_SECRET || 'default-secret';

/**
 * Generate QR token with HMAC signature
 * Format: base64(payload).signature
 */
export function generateQrToken(qrCodeId, expiryMinutes = 2) {
  const payload = {
    qrCodeId,
    issuedAt: Date.now(),
    expiresAt: Date.now() + (expiryMinutes * 60 * 1000)
  };
  
  const payloadBase64 = Buffer.from(JSON.stringify(payload)).toString('base64');
  const signature = crypto
    .createHmac('sha256', QR_HMAC_SECRET)
    .update(payloadBase64)
    .digest('hex');
  
  return `${payloadBase64}.${signature}`;
}

/**
 * Verify QR token signature and extract payload
 */
export function verifyQrToken(token, isAdmin = false) {
  try {
    const [payloadBase64, signature] = token.split('.');
    
    if (!payloadBase64 || !signature) {
      throw new Error('Invalid token format');
    }
    
    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', QR_HMAC_SECRET)
      .update(payloadBase64)
      .digest('hex');
    
    // Timing-safe comparison
    if (!crypto.timingSafeEqual(Buffer.from(signature, 'hex'), Buffer.from(expectedSignature, 'hex'))) {
      throw new Error('Invalid signature');
    }
    
    // Parse payload
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
    
    // Check expiry, but not for admins
    if (!isAdmin && payload.expiresAt && Date.now() > payload.expiresAt) {
      throw new Error('Token expired');
    }
    
    return payload;
  } catch (error) {
    throw new Error(`QR verification failed: ${error.message}`);
  }
}

/**
 * Generate QR code image as data URL
 * @param {string} tokenOrQrCodeId - JWT token or legacy qrCodeId
 * @param {Object} options - QR generation options
 */
export async function generateQrCodeImage(tokenOrQrCodeId, options = {}) {
  // If it looks like a JWT (has dots), use it directly, otherwise generate token
  const token = tokenOrQrCodeId.includes('.') 
    ? tokenOrQrCodeId 
    : generateQrToken(tokenOrQrCodeId, options.expiryMinutes);
  
  const qrOptions = {
    errorCorrectionLevel: 'M',
    type: 'image/png',
    quality: 0.92,
    margin: 1,
    color: {
      dark: options.darkColor || '#000000',
      light: options.lightColor || '#FFFFFF'
    },
    width: options.width || 256,
    ...options.qrOptions
  };
  
  try {
    const dataUrl = await QRCode.toDataURL(token, qrOptions);
    return {
      dataUrl,
      token
    };
  } catch (error) {
    throw new Error(`QR generation failed: ${error.message}`);
  }
}

/**
 * Generate QR code as SVG string
 */
export async function generateQrCodeSvg(qrCodeId, options = {}) {
  const token = generateQrToken(qrCodeId, options.expiryMinutes);
  
  const qrOptions = {
    errorCorrectionLevel: 'M',
    type: 'svg',
    margin: 1,
    color: {
      dark: options.darkColor || '#000000',
      light: options.lightColor || '#FFFFFF'
    },
    width: options.width || 256,
    ...options.qrOptions
  };
  
  try {
    const svg = await QRCode.toString(token, qrOptions);
    return {
      svg,
      token,
      expiresAt: Date.now() + ((options.expiryMinutes || 2) * 60 * 1000)
    };
  } catch (error) {
    throw new Error(`QR SVG generation failed: ${error.message}`);
  }
}

/**
 * Generate printable QR card data
 */
export function generatePrintableCard(customer, tempPin = null) {
  const qrToken = generateQrToken(customer.qrCodeId, 60); // 1 hour for printing
  
  return {
    customer: {
      name: customer.name,
      phone: customer.phone,
      roomNo: customer.roomNo,
      qrCodeId: customer.qrCodeId
    },
    qrToken,
    tempPin: tempPin && process.env.NODE_ENV !== 'production' ? tempPin : null,
    generatedAt: new Date().toISOString(),
    instructions: [
      '1. Keep this card safe and secure',
      '2. Show QR code to scanner for meals',
      '3. Change PIN on first login',
      '4. Contact admin if card is lost'
    ]
  };
}

/**
 * Validate QR code format
 */
export function isValidQrFormat(token) {
  if (!token || typeof token !== 'string') return false;
  
  const parts = token.split('.');
  if (parts.length !== 2) return false;
  
  try {
    // Check if payload is valid base64
    const payload = Buffer.from(parts[0], 'base64').toString();
    JSON.parse(payload);
    
    // Check if signature is valid hex
    if (!/^[a-f0-9]+$/i.test(parts[1])) return false;
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Get QR token info without verification (for debugging)
 */
export function getQrTokenInfo(token) {
  try {
    const [payloadBase64] = token.split('.');
    const payload = JSON.parse(Buffer.from(payloadBase64, 'base64').toString());
    
    return {
      qrCodeId: payload.qrCodeId,
      issuedAt: new Date(payload.issuedAt),
      expiresAt: new Date(payload.expiresAt),
      isExpired: Date.now() > payload.expiresAt,
      ageSeconds: Math.floor((Date.now() - payload.issuedAt) / 1000)
    };
  } catch (error) {
    return null;
  }
}