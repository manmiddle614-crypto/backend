import { MessSubscription } from '../models/MessSubscription.js';
import { Mess } from '../models/Mess.js';

/**
 * Check for expiring subscriptions and send warnings
 * Run daily
 */
export async function checkExpiringSubscriptions() {

  try {
    // Find subscriptions expiring in 2 days
    const expiringSoon = await MessSubscription.findExpiringSoon(2);

    for (const subscription of expiringSoon) {
      const mess = await Mess.findById(subscription.messId);
      if (!mess) continue;

      // TODO: Send email notification
      // await sendEmail({
      //   to: mess.ownerEmail,
      //   subject: 'Your subscription is expiring soon',
      //   template: 'subscription-expiring',
      //   data: {
      //     messName: mess.name,
      //     daysRemaining: subscription.daysRemaining,
      //     renewUrl: `${process.env.FRONTEND_URL}/subscription`
      //   }
      // });

      subscription.warningEmailSent = true;
      await subscription.save();
    }

  } catch (error) {

  }
}

/**
 * Expire subscriptions that have passed their end date
 * Run daily
 */
export async function expireSubscriptions() {

  try {
    const expired = await MessSubscription.findExpired();

    for (const subscription of expired) {
      const mess = await Mess.findById(subscription.messId);
      if (!mess) continue;

      await subscription.expireSubscription();

      // Update mess status
      await Mess.findByIdAndUpdate(subscription.messId, {
        subscriptionStatus: 'expired'
      });

      

      subscription.expiryEmailSent = true;
      await subscription.save();
    }

  } catch (error) {

  }
}

/**
 * Start subscription cron jobs
 */
export function startSubscriptionJobs() {
  // Run every day at 9 AM
  const DAILY_CHECK_INTERVAL = 24 * 60 * 60 * 1000; // 24 hours

  setInterval(async () => {
    await checkExpiringSubscriptions();
    await expireSubscriptions();
  }, DAILY_CHECK_INTERVAL);

  // Run immediately on startup
  setTimeout(async () => {
    await checkExpiringSubscriptions();
    await expireSubscriptions();
  }, 5000); // 5 seconds after startup

}
