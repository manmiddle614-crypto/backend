import { Settings } from '../models/Settings.js';

let cache = null;
let loadedAt = 0;
const TTL = 60_000; // 60 seconds

/**
 * Get settings with in-memory caching (TTL-based)
 */
export async function getSettings() {
  if (cache && (Date.now() - loadedAt) < TTL) {
    return cache;
  }

  try {
    const s = await Settings.findOne({}).lean();
    cache = s || getDefaultSettings();
    loadedAt = Date.now();
    return cache;
  } catch (err) {
    return cache || getDefaultSettings();
  }
}

/**
 * Clear cache (call after admin updates settings)
 */
export function clearSettingsCache() {
  cache = null;
  loadedAt = 0;
}

/**
 * Default settings fallback
 */
function getDefaultSettings() {
  return {
    mealWindows: {
      breakfast: { start: '06:30', end: '10:00' },
      lunch: { start: '12:00', end: '15:00' },
      dinner: { start: '19:00', end: '22:00' },
    },
    doubleScanWindowSeconds: 30,
    alertThresholdMealsRemaining: 5,
    timezone: 'UTC',
  };
}
