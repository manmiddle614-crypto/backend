import mongoose from 'mongoose';

const settingsSchema = new mongoose.Schema({
  messId: { type: mongoose.Schema.Types.ObjectId, ref: 'Mess', required: true, unique: true },
  // Meal timing windows
  mealWindows: {
    breakfast: {
      start: { type: String, default: '06:00' },
      end: { type: String, default: '10:00' }
    },
    lunch: {
      start: { type: String, default: '12:00' },
      end: { type: String, default: '15:00' }
    },
    dinner: {
      start: { type: String, default: '19:00' },
      end: { type: String, default: '22:00' }
    }
  },
  
  // Duplicate scan prevention
  doubleScanWindowSeconds: {
    type: Number,
    default: 30,
    min: 10,
    max: 300
  },
  
  // Alert thresholds
  alertThresholdMealsRemaining: {
    type: Number,
    default: 5,
    min: 0,
    max: 50
  },
  
  // PIN security settings
  pinSettings: {
    maxAttempts: { type: Number, default: 5, min: 3, max: 10 },
    lockoutMinutes: { type: Number, default: 30, min: 5, max: 1440 },
    saltRounds: { type: Number, default: 12, min: 10, max: 15 },
    expiryDays: { type: Number, default: 90, min: 30, max: 365 }
  },
  
  // JWT settings
  jwtSettings: {
    expiryHours: { type: Number, default: 168, min: 1, max: 720 }, // 7 days default
    refreshExpiryDays: { type: Number, default: 30, min: 7, max: 90 }
  },
  
  // QR code settings
  qrSettings: {
    expiryMinutes: { type: Number, default: 2, min: 1, max: 10 },
    hmacAlgorithm: { type: String, default: 'sha256' }
  },
  
  // Business settings
  businessInfo: {
    name: { type: String, default: 'SmartMess', trim: true },
    address: { type: String, trim: true },
    phone: { type: String, trim: true },
    email: { type: String, trim: true },
    website: { type: String, trim: true },
    logo: { type: String, trim: true }
  },
  
  // Notification settings
  notifications: {
    lowMealsAlert: { type: Boolean, default: true },
    paymentReminders: { type: Boolean, default: true },
    subscriptionExpiry: { type: Boolean, default: true },
    dailyReports: { type: Boolean, default: false },
    weeklyReports: { type: Boolean, default: true }
  },
  
  // Feature flags
  features: {
    offlineScanning: { type: Boolean, default: true },
    mealPreOrdering: { type: Boolean, default: false },
    loyaltyProgram: { type: Boolean, default: false },
    multipleLocations: { type: Boolean, default: false },
    guestMeals: { type: Boolean, default: false }
  },
  
  // Rate limiting
  rateLimits: {
    loginAttemptsPerHour: { type: Number, default: 10, min: 5, max: 100 },
    scanAttemptsPerMinute: { type: Number, default: 120, min: 10, max: 1000 },
    apiRequestsPerMinute: { type: Number, default: 100, min: 10, max: 1000 }
  },
  
  // Backup and maintenance
  maintenance: {
    backupFrequencyHours: { type: Number, default: 24, min: 1, max: 168 },
    logRetentionDays: { type: Number, default: 90, min: 7, max: 365 },
    sessionCleanupHours: { type: Number, default: 24, min: 1, max: 168 }
  },
  
  // Currency and locale
  locale: {
    currency: { type: String, default: 'INR' },
    timezone: { type: String, default: 'Asia/Kolkata' },
    dateFormat: { type: String, default: 'DD/MM/YYYY' },
    language: { type: String, default: 'en' }
  },
  
  // Version and metadata
  version: { type: String, default: '1.0.0' },
  lastUpdatedBy: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User'
  }
}, {
  timestamps: true
});

// Ensure only one settings document per mess
settingsSchema.index({ messId: 1 }, { unique: true });

// Virtual for current meal window
settingsSchema.virtual('currentMealWindow').get(function() {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5); // HH:MM format
  
  const { breakfast, lunch, dinner } = this.mealWindows;
  
  if (currentTime >= breakfast.start && currentTime <= breakfast.end) {
    return 'breakfast';
  } else if (currentTime >= lunch.start && currentTime <= lunch.end) {
    return 'lunch';
  } else if (currentTime >= dinner.start && currentTime <= dinner.end) {
    return 'dinner';
  }
  
  return null;
});

// Method to check if current time is within meal window
settingsSchema.methods.isWithinMealWindow = function(mealType) {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  
  const window = this.mealWindows[mealType];
  if (!window) return false;
  
  return currentTime >= window.start && currentTime <= window.end;
};

// Method to get next meal window
settingsSchema.methods.getNextMealWindow = function() {
  const now = new Date();
  const currentTime = now.toTimeString().slice(0, 5);
  
  const windows = [
    { type: 'breakfast', ...this.mealWindows.breakfast },
    { type: 'lunch', ...this.mealWindows.lunch },
    { type: 'dinner', ...this.mealWindows.dinner }
  ];
  
  // Find next window today
  for (const window of windows) {
    if (currentTime < window.start) {
      return {
        type: window.type,
        startsAt: window.start,
        isToday: true
      };
    }
  }
  
  // Next window is tomorrow's breakfast
  return {
    type: 'breakfast',
    startsAt: this.mealWindows.breakfast.start,
    isToday: false
  };
};

// Static method to get cached settings
settingsSchema.statics.getCached = async function() {
  // In production, implement Redis caching here
  return await this.findOne() || await this.create({});
};

// Method to update specific setting
settingsSchema.methods.updateSetting = function(path, value, updatedBy) {
  this.set(path, value);
  this.lastUpdatedBy = updatedBy;
  return this.save();
};

// Pre-save validation
settingsSchema.pre('save', function(next) {
  // Validate meal windows don't overlap
  const windows = this.mealWindows;
  const times = [
    { type: 'breakfast', start: windows.breakfast.start, end: windows.breakfast.end },
    { type: 'lunch', start: windows.lunch.start, end: windows.lunch.end },
    { type: 'dinner', start: windows.dinner.start, end: windows.dinner.end }
  ];
  
  for (let i = 0; i < times.length; i++) {
    for (let j = i + 1; j < times.length; j++) {
      const a = times[i];
      const b = times[j];
      
      if ((a.start <= b.start && a.end > b.start) || 
          (b.start <= a.start && b.end > a.start)) {
        return next(new Error(`Meal windows overlap: ${a.type} and ${b.type}`));
      }
    }
  }
  
  next();
});

// Ensure virtuals are included in JSON
settingsSchema.set('toJSON', { virtuals: true });

export const Settings = mongoose.model('Settings', settingsSchema);