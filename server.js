import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import rateLimit from 'express-rate-limit';
import { validateEnv } from './src/utils/validateEnv.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

// Validate environment variables (FAIL FAST)
validateEnv();

// Validate JWT secret in ALL environments
if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) {
  logger.error('JWT_SECRET is weak or missing (must be 32+ characters)');
  process.exit(1);
}

// Validate critical secrets in production
if (process.env.NODE_ENV === 'production') {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    logger.error('RAZORPAY_KEY_SECRET is missing');
    process.exit(1);
  }
}

// Routes
import authRoutes from './src/routes/auth.js';
import authPinRoutes from './src/routes/authPin.js';
import forgotPasswordRoutes from './src/routes/forgotPassword.js';
import signupRoutes from './src/routes/signup.js';
import customerRoutes from './src/routes/customers.js';
import staffRoutes from './src/routes/staff.js';
import scanCoreRoutes from './src/routes/scanCore.js';
import scanRoutes from './src/routes/scan.js';
import scanBatchRoutes from './src/routes/scanBatch.js';
import deepLinkScanRoutes from './src/routes/deepLinkScan.js';
import settingsRoutes from './src/routes/settings.js';
import customerProfileRoutes from './src/routes/customerProfile.js';
import customerDashboardRoutes from './src/routes/customerDashboard.js';
import customerReportsRoutes from './src/routes/customerReports.js';
import adminCustomersRoutes from './src/routes/adminCustomers.js';
import searchRoutes from './src/routes/search.js';
import userRoutes from './src/routes/user.js';
import subscriptionsRoutes from './src/routes/subscriptions.js';
import messSubscriptionRoutes from './src/routes/messSubscription.js';
import billingRoutes from './src/routes/billing.js';
import plansRoutes from './src/routes/plans.js';
import paymentsRoutes from './src/routes/payments.js';
import paymentsCollectRoutes from './src/routes/paymentsCollect.js';
import renewalsRoutes from './src/routes/renewals.js';
import notificationsRoutes from './src/routes/notifications.js';
import onboardingRoutes from './src/routes/onboarding.js';
import attendanceRoutes from './src/routes/attendance.js';
import adminAttendanceRoutes from './src/routes/adminAttendance.js';
import auditRoutes from './src/routes/audit.js';
import usageRoutes from './src/routes/usage.js';
import superAdminRoutes from './src/routes/superAdmin.js';
import contactRoutes from './src/routes/contact.js';
import adminReportsRoutes from './src/routes/adminReports.js';
import reportsRoutes from './src/routes/reports.js';
import adminProfileRoutes from './src/routes/adminProfile.js';
import messQRRoutes from './src/routes/messQR.js';
import customerScanRoutes from './src/routes/customerScan.js';
import messSettingsRoutes from './src/routes/messSettings.js';
import analyticsRoutes from './src/routes/analytics.js';

// Middleware
import { errorHandler } from './src/utils/errorHandler.js';
import { subscriptionGuard } from './src/middleware/subscriptionGuard.js';
import { tenantIsolation } from './src/middleware/tenantIsolation.js';
import { enforcePlanLimits } from './src/middleware/planLimitEnforcement.js';
import { authLimiter, pinLoginLimiter, scanLimiter, webhookLimiter, analyticsLimiter } from './src/middleware/rateLimits.js';
import { startAttendanceCron } from './src/services/attendanceCron.js';
import { setupSocketIO } from './src/services/socket.js';
import { startMealNotificationCron } from './src/services/mealNotificationCron.js';
import { startNotificationJobs } from './src/services/notificationJobs.js';
import http from 'http';

const app = express();
const PORT = process.env.PORT || 3000;

// Trust proxy for ngrok/reverse proxy
app.set('trust proxy', 1);

// 🔒 BLOCKER 1: ENFORCE HTTPS IN PRODUCTION
if (process.env.NODE_ENV === 'production') {
  app.use((req, res, next) => {
    if (!req.secure && req.get('x-forwarded-proto') !== 'https') {
      logger.warn('HTTP request blocked in production', { url: req.url, ip: req.ip });
      return res.status(403).json({
        success: false,
        error: {
          code: 'HTTPS_REQUIRED',
          message: 'HTTPS is required. Please use https://'
        }
      });
    }
    next();
  });
  
  // Enable HSTS (HTTP Strict Transport Security)
  app.use((req, res, next) => {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains; preload');
    next();
  });
}

// Security
app.use(helmet());


if (process.env.NODE_ENV === 'production' && !process.env.FRONTEND_URL) {
  logger.error('FRONTEND_URL not set in production');
  process.exit(1);
}

const allowedOrigins = process.env.NODE_ENV === 'production'
  ? [
      process.env.FRONTEND_URL,
      'https://messtracker.online',
      'https://www.messtracker.online',
      'https://localhost',        // ✅ Capacitor Android
      'capacitor://localhost',    // ✅ Capacitor iOS
      'ionic://localhost',        // ✅ Ionic
      'http://localhost',         // ✅ Capacitor Android HTTP
      'file://'                   // ✅ Capacitor file protocol
    ]
  : [
      'http://localhost:5173',
      'https://localhost:5173',
      'http://10.102.213.203:3000',
      'http://10.58.44.203:5173',
      'capacitor://localhost',
      'ionic://localhost'
    ];


logger.info('CORS allowed origins:', allowedOrigins);

app.use(cors({
  origin: true,  // Allow all origins for mobile app
  credentials: true,
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization']
}));

app.get('/', (req, res) => {
  res.send('Backend is running');
});


// Global rate limiting (fallback)
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests' }
});
app.use('/api/', globalLimiter);

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Static file serving with caching and compression
if (process.env.NODE_ENV === 'production') {
  app.use('/uploads', express.static('uploads', {
    maxAge: '1y',
    etag: true,
    lastModified: true,
    setHeaders: (res, path) => {
      if (path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.png') || path.endsWith('.webp')) {
        res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      }
    }
  }));
}

// Health check with database connectivity
app.get('/health', async (req, res) => {
  try {
    // Check MongoDB connection
    const dbState = mongoose.connection.readyState;
    const dbStatus = dbState === 1 ? 'connected' : 'disconnected';
    
    if (dbState !== 1) {
      return res.status(503).json({
        status: 'unhealthy',
        database: dbStatus,
        timestamp: new Date().toISOString()
      });
    }

    // Ping database
    await mongoose.connection.db.admin().ping();

    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (error) {
    res.status(503).json({
      status: 'unhealthy',
      error: error.message,
      timestamp: new Date().toISOString()
    });
  }
});

// Routes - Auth & Signup (BEFORE tenant isolation - no messId yet)
import { requireAuth } from './src/middleware/auth.js';
app.use('/api/auth', authLimiter, authRoutes);
app.use('/api/auth', authLimiter, forgotPasswordRoutes);
app.use('/auth', authLimiter, authRoutes);
app.use('/auth', authLimiter, signupRoutes);
app.use('/api/auth-pin', pinLoginLimiter, authPinRoutes); // Includes /change-pin
app.use('/api/billing', billingRoutes); // Webhook has no auth

// Routes that need auth but NOT tenant isolation (messId in JWT)
app.use('/api/mess-subscription', requireAuth, messSubscriptionRoutes);
app.use('/api/user', requireAuth, userRoutes);

// Routes that need auth but NOT tenant isolation (special cases)
app.use('/api/customer/profile', requireAuth, customerProfileRoutes);
app.use('/api/customer/dashboard', requireAuth, customerDashboardRoutes);
app.use('/api/customer/reports', requireAuth, customerReportsRoutes);
app.use('/api/customer/attendance', requireAuth, attendanceRoutes);
app.use('/api/customer', requireAuth, customerScanRoutes);
app.use('/api/admin/attendance', requireAuth, adminAttendanceRoutes);
app.use('/api/admin/mess-qr', requireAuth, messQRRoutes);
app.use('/api/admin', requireAuth, messSettingsRoutes);

// Apply tenant isolation and subscription guard globally to other routes
app.use('/api', tenantIsolation);
app.use('/api', subscriptionGuard);
app.use('/api', enforcePlanLimits); // 🔒 BLOCKER 3: Enforce plan limits

// Analytics (needs tenant isolation)
app.use('/api/analytics', requireAuth, analyticsRoutes);

// Protected routes (auth + subscription required)
app.use('/api/customers', requireAuth, customerRoutes);
app.use('/api/admin/staff', requireAuth, staffRoutes);
app.use('/api/scan-core', requireAuth, scanLimiter, scanCoreRoutes);
app.use('/api/scan', requireAuth, scanLimiter, scanRoutes);
app.use('/api/scan-batch', requireAuth, scanLimiter, scanBatchRoutes);
app.use('/api/deep-link-scan', requireAuth, deepLinkScanRoutes);
app.use('/api/settings', requireAuth, settingsRoutes);
app.use('/api/admin/customers', requireAuth, adminCustomersRoutes);
app.use('/api/search', requireAuth, searchRoutes);
app.use('/api/subscriptions', requireAuth, subscriptionsRoutes);
app.use('/api/plans', requireAuth, plansRoutes);
app.use('/api/payments', requireAuth, paymentsRoutes);
app.use('/api/payments-collect', requireAuth, paymentsCollectRoutes);
app.use('/api/renewals', requireAuth, renewalsRoutes);
app.use('/api/notifications', requireAuth, notificationsRoutes);
app.use('/api/onboarding', requireAuth, onboardingRoutes);
app.use('/api/audit', requireAuth, auditRoutes);
app.use('/api/usage', requireAuth, usageRoutes);
app.use('/super-admin', superAdminRoutes);
app.use('/api/contact', contactRoutes);
app.use('/api/admin/reports', analyticsLimiter, adminReportsRoutes);
app.use('/api/reports', requireAuth, analyticsLimiter, reportsRoutes);
app.use('/api/admin', requireAuth, adminProfileRoutes);

// Error handling
app.use(errorHandler);

// Database connection
let server;
const httpServer = http.createServer(app);
const io = setupSocketIO(httpServer);
app.set('io', io);

mongoose.connect(process.env.MONGO_URI || process.env.MONGODB_URI || 'mongodb://localhost:27017/smartmess')
  .then(() => {
    logger.info('Connected to MongoDB');
    
    // Start attendance cron job
    startAttendanceCron();
    
    // Start meal notification cron
    startMealNotificationCron(io);
    
    // Start notification jobs
    startNotificationJobs();
    
    server = httpServer.listen(PORT, '0.0.0.0', () => {
      logger.info(`Server running on port ${PORT}`);
      logger.info(`Environment: ${process.env.NODE_ENV}`);
    });
  })
  .catch((err) => {
    logger.error({ err }, 'MongoDB connection error');
    process.exit(1);
  });

// Graceful shutdown
const gracefulShutdown = async (signal) => {
  logger.info(`${signal} received. Starting graceful shutdown...`);
  
  if (server) {
    server.close(async () => {
      logger.info('HTTP server closed');
      
      try {
        await mongoose.connection.close();
        logger.info('MongoDB connection closed');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });

    setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 30000);
  } else {
    process.exit(0);
  }
};

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT', () => gracefulShutdown('SIGINT'));

export default app;
