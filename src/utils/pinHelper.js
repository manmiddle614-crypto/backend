import bcrypt from 'bcryptjs';
import crypto from 'crypto';

const PIN_SALT_ROUNDS = parseInt(process.env.PIN_SALT_ROUNDS) || 12;

/**
 * Normalize phone number - remove country code and keep only 10 digits
 */
export function normalizePhone(phone) {
  if (!phone) return null;
  let p = phone.replace(/\D/g, '');
  // Remove country code if present (91 for India)
  if (p.startsWith('91') && p.length > 10) {
    p = p.substring(2);
  }
  // Keep only last 10 digits
  if (p.length > 10) {
    p = p.substring(p.length - 10);
  }
  return p;
}


export function generatePinFromName(name) {
  if (!name || typeof name !== 'string') {
    return generatePin(); // Fallback to random PIN
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0) {
    return generatePin(); // Fallback to random PIN
  }
  // Get first word only
  const firstName = trimmedName.split(/\s+/)[0];
  // First letter uppercase, rest lowercase
  return firstName.charAt(0).toUpperCase() + firstName.slice(1).toLowerCase();
}

/**
 * Generate random PIN (fallback)
 */
export function generatePin(length = 4) {
  const min = Math.pow(10, length - 1);
  return (Math.floor(Math.random() * 9 * min) + min).toString();
}

/**
 * Hash PIN
 */
export async function hashPin(pin) {
  return bcrypt.hash(pin, PIN_SALT_ROUNDS);
}

/**
 * Verify PIN
 */
export async function verifyPin(pin, hash) {
  return bcrypt.compare(pin, hash);
}

/**
 * Validate PIN format
 */
export function validatePin(pin) {
  return /^\d{4,6}$/.test(pin);
}

/**
 * Generate device token
 */
export function generateDeviceToken() {
  return crypto.randomBytes(32).toString('hex');
}

/**
 * Hash device token
 */
export async function hashDeviceToken(token) {
  return bcrypt.hash(token, PIN_SALT_ROUNDS);
}