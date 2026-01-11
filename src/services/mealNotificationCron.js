import cron from 'node-cron';
import MessSettings from '../models/MessSettings.js';
import NotificationLog from '../models/NotificationLog.js';
import { Customer } from '../models/Customer.js';

// Run every minute
export const startMealNotificationCron = (io) => {
  cron.schedule('* * * * *', async () => {
    try {
      const now = new Date();
      const currentTime = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
      const today = now.toISOString().split('T')[0];

      // Fetch all mess settings
      const allSettings = await MessSettings.find({}).lean();

      for (const settings of allSettings) {
        const { messId, notifications, messStatus } = settings;

        // Skip if mess is closed
        if (!messStatus.isOpen) continue;

        // Check each meal type
        for (const [mealType, config] of Object.entries(notifications)) {
          if (!config.enabled) continue;
          if (config.time !== currentTime) continue;

          // Check if already sent today
          const logKey = `${messId}_${today}_${mealType}`;
          const alreadySent = await NotificationLog.findOne({
            messId,
            date: today,
            type: mealType
          });

          if (alreadySent) continue;

          // Get all active customers
          const customers = await Customer.find({
            messId,
            active: true
          }).select('_id name').lean();

          if (customers.length === 0) continue;

          // Send notifications
          const messages = {
            breakfast: '🍳 Good morning! Breakfast is now available.',
            lunch: '🍽️ Lunch time! Please confirm your attendance.',
            dinner: '🍲 Dinner service has started.'
          };

          if (io) {
            customers.forEach(customer => {
              io.to(`customer_${customer._id}`).emit('meal_notification', {
                mealType,
                message: messages[mealType],
                time: currentTime,
                timestamp: new Date().toISOString()
              });
            });
          }

          // Log notification
          await NotificationLog.create({
            messId,
            date: today,
            type: mealType
          }).catch(() => {});

        }
      }
    } catch (error) {

    }
  });

};
