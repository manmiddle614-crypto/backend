import crypto from 'crypto';

/**
 * Create a QR token: payload is base64-encoded JSON, signed with HMAC-SHA256
 * Format: base64(payload).hex(signature)
 */
export function createQrToken(payloadObj, secret) {
  const payloadStr = JSON.stringify(payloadObj);
  const payloadB64 = Buffer.from(payloadStr, 'utf8').toString('base64');
  const sig = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
  return `${payloadB64}.${sig}`;
}

export function verifyQrToken(token, secret) {
  try {
    if (!token || typeof token !== 'string') {
      return { valid: false, error: 'Invalid token type' };
    }

    const [payloadB64, signature] = token.split('.');
    if (!payloadB64 || !signature) {
      return { valid: false, error: 'Missing payload or signature' };
    }

    const expected = crypto.createHmac('sha256', secret).update(payloadB64).digest('hex');
    if (!crypto.timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signature, 'hex'))) {
      return { valid: false, error: 'Signature mismatch' };
    }

    const payload = JSON.parse(Buffer.from(payloadB64, 'base64').toString('utf8'));
    return { valid: true, payload };
  } catch (err) {
    return { valid: false, error: err.message };
  }
}
