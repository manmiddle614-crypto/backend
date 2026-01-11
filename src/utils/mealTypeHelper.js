export function determineMealType(config) {
  const now = new Date()
  const hours = now.getHours()
  const minutes = now.getMinutes()
  const currentTime = `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`

  const windows = config.mealWindows || {}

  // Check each meal window (support both start/end and from/to)
  if (isTimeInWindow(currentTime, windows.breakfast?.start || windows.breakfast?.from, windows.breakfast?.end || windows.breakfast?.to)) {
    return "breakfast"
  }
  if (isTimeInWindow(currentTime, windows.lunch?.start || windows.lunch?.from, windows.lunch?.end || windows.lunch?.to)) {
    return "lunch"
  }
  if (isTimeInWindow(currentTime, windows.dinner?.start || windows.dinner?.from, windows.dinner?.end || windows.dinner?.to)) {
    return "dinner"
  }

  return null
}

// Backwards-compatible alias
export const getCurrentMealType = determineMealType

function isTimeInWindow(currentTime, windowStart, windowEnd) {
  if (!windowStart || !windowEnd) return false
  return currentTime >= windowStart && currentTime <= windowEnd
}
