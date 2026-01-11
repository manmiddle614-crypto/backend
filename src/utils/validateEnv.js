/**
 * Environment Variable Validation
 * FAIL FAST if any required secret is missing or weak
 */

const REQUIRED_VARS = [
  'MONGO_URI',
  'JWT_SECRET',
  'QR_JWT_SECRET',
  'RAZORPAY_KEY_ID',
  'RAZORPAY_KEY_SECRET',
  'RAZORPAY_WEBHOOK_SECRET',
  'NODE_ENV'
];

const WEAK_SECRETS = [
  'your_jwt_secret_key_change_in_production',
  'your_qr_jwt_secret_change_in_production_rotate_independently',
  'your_webhook_secret',
  'your-secret-key',
  'change_me',
  'secret',
  '123456'
];

export function validateEnv() {
  const errors = [];
  const warnings = [];

  // Check required variables
  for (const varName of REQUIRED_VARS) {
    if (!process.env[varName]) {
      errors.push(`❌ MISSING: ${varName} is required but not set`);
    }
  }

  // Check for weak secrets
  if (process.env.JWT_SECRET) {
    if (process.env.JWT_SECRET.length < 32) {
      errors.push(`❌ WEAK: JWT_SECRET must be at least 32 characters`);
    }
    if (WEAK_SECRETS.some(weak => process.env.JWT_SECRET.includes(weak))) {
      errors.push(`❌ WEAK: JWT_SECRET contains default/weak value`);
    }
  }

  if (process.env.QR_JWT_SECRET) {
    if (process.env.QR_JWT_SECRET.length < 32) {
      errors.push(`❌ WEAK: QR_JWT_SECRET must be at least 32 characters`);
    }
    if (WEAK_SECRETS.some(weak => process.env.QR_JWT_SECRET.includes(weak))) {
      errors.push(`❌ WEAK: QR_JWT_SECRET contains default/weak value`);
    }
  }

  // Ensure JWT_SECRET and QR_JWT_SECRET are different
  if (process.env.JWT_SECRET && process.env.QR_JWT_SECRET) {
    if (process.env.JWT_SECRET === process.env.QR_JWT_SECRET) {
      errors.push(`❌ SECURITY: JWT_SECRET and QR_JWT_SECRET must be different`);
    }
  }

  // Check Razorpay secrets
  if (process.env.RAZORPAY_WEBHOOK_SECRET) {
    if (WEAK_SECRETS.some(weak => process.env.RAZORPAY_WEBHOOK_SECRET.includes(weak))) {
      errors.push(`❌ WEAK: RAZORPAY_WEBHOOK_SECRET contains default value`);
    }
  }

  // Production-specific checks
  if (process.env.NODE_ENV === 'production') {
    if (process.env.RAZORPAY_KEY_ID?.startsWith('rzp_test_')) {
      errors.push(`❌ PRODUCTION: Using test Razorpay key in production`);
    }
    if (!process.env.FRONTEND_URL || process.env.FRONTEND_URL.includes('localhost')) {
      errors.push(`❌ PRODUCTION: FRONTEND_URL must be set to production domain`);
    }
    if (process.env.MONGO_URI?.includes('localhost')) {
      warnings.push(`⚠️  WARNING: Using localhost MongoDB in production`);
    }
  }

  // Report results
  if (errors.length > 0) {

    errors.forEach(err => console.error(err));

    process.exit(1);
  }

  if (warnings.length > 0) {

    warnings.forEach(warn => console.warn(warn));

  }

}
