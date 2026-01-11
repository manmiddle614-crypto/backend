export function configPlugin() {
  const config = {
    port: process.env.PORT || 3000,
    mongoUri: process.env.MONGO_URI || "mongodb://localhost:27017/smart-mess",
    jwtSecret: process.env.JWT_SECRET,
    jwtExpiry: process.env.JWT_EXPIRY || "1h",
    bcryptRounds: Number.parseInt(process.env.BCRYPT_ROUNDS || 12, 10),
    nodeEnv: process.env.NODE_ENV || "development",
    corsOrigin: process.env.CORS_ORIGIN || "http://localhost:5173",
    mealWindows: {
      lunch: { from: "12:00", to: "14:00" },
      dinner: { from: "19:00", to: "21:00" },
    },
    doubleScanWindowSeconds: Number.parseInt(process.env.DOUBLE_SCAN_WINDOW || 60, 10),
    alertThresholdMealsRemaining: Number.parseInt(process.env.ALERT_THRESHOLD || 5, 10),
  };

  // Validate required env vars
  if (!config.jwtSecret) {
    throw new Error("JWT_SECRET environment variable is required");
  }
  if (!config.mongoUri) {
    throw new Error("MONGO_URI environment variable is required");
  }

  return config;
}
