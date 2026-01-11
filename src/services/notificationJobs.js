import cron from 'node-cron';
import { Mess } from '../models/Mess.js';
import { createBroadcastNotification, checkDuplicateNotification } from './notificationService.js';

// Breakfast reminder - 7:30 AM daily
export const breakfastReminderJob = cron.schedule('30 7 * * *', async () => {

  try {
    const messes = await Mess.find({ active: true }).lean();

    for (const mess of messes) {
      const duplicate = await checkDuplicateNotification(
        mess._id,
        'meal',
        'Breakfast Reminder',
        12
      );

      if (!duplicate) {
        await createBroadcastNotification({
          messId: mess._id,
          title: 'Breakfast Reminder',
          message: 'Breakfast will be served soon. Don\'t forget to mark your attendance!',
          type: 'meal',
          priority: 'MEDIUM',
          expiresInHours: 6
        });
      }
    }
  } catch (error) {

  }
}, {
  scheduled: false
});

// Lunch reminder - 12:00 PM daily
export const lunchReminderJob = cron.schedule('0 12 * * *', async () => {

  try {
    const messes = await Mess.find({ active: true }).lean();

    for (const mess of messes) {
      const duplicate = await checkDuplicateNotification(
        mess._id,
        'meal',
        'Lunch Reminder',
        12
      );

      if (!duplicate) {
        await createBroadcastNotification({
          messId: mess._id,
          title: 'Lunch Reminder',
          message: 'Lunch is ready! Please mark your attendance.',
          type: 'meal',
          priority: 'MEDIUM',
          expiresInHours: 6
        });
      }
    }
  } catch (error) {

  }
}, {
  scheduled: false
});

// Dinner reminder - 7:00 PM daily
export const dinnerReminderJob = cron.schedule('0 19 * * *', async () => {

  try {
    const messes = await Mess.find({ active: true }).lean();

    for (const mess of messes) {
      const duplicate = await checkDuplicateNotification(
        mess._id,
        'meal',
        'Dinner Reminder',
        12
      );

      if (!duplicate) {
        await createBroadcastNotification({
          messId: mess._id,
          title: 'Dinner Reminder',
          message: 'Dinner time! Don\'t miss your meal.',
          type: 'meal',
          priority: 'MEDIUM',
          expiresInHours: 6
        });
      }
    }
  } catch (error) {

  }
}, {
  scheduled: false
});

// Daily attendance reminder - 9:00 AM
export const attendanceReminderJob = cron.schedule('0 9 * * *', async () => {

  try {
    const messes = await Mess.find({ active: true }).lean();

    for (const mess of messes) {
      const duplicate = await checkDuplicateNotification(
        mess._id,
        'attendance',
        'Daily Attendance Reminder',
        24
      );

      if (!duplicate) {
        await createBroadcastNotification({
          messId: mess._id,
          title: 'Daily Attendance Reminder',
          message: 'Please mark your attendance for today\'s meals.',
          type: 'attendance',
          priority: 'LOW',
          expiresInHours: 24
        });
      }
    }
  } catch (error) {

  }
}, {
  scheduled: false
});

export function startNotificationJobs() {
  breakfastReminderJob.start();
  lunchReminderJob.start();
  dinnerReminderJob.start();
  attendanceReminderJob.start();

}

export function stopNotificationJobs() {
  breakfastReminderJob.stop();
  lunchReminderJob.stop();
  dinnerReminderJob.stop();
  attendanceReminderJob.stop();

}
