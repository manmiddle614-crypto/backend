import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { Notification } from '../models/Notification.js';
import { determineMealType } from '../utils/mealTypeHelper.js';
import { getSettings } from '../utils/settingsCache.js';

export async function processScan({ 
  customerId, 
  staffId, 
  staffName, 
  mealType, 
  deviceId, 
  scanSource = 'QR_LIVE', 
  clientTime = new Date() 
}) {
  const customer = await Customer.findById(customerId);
  if (!customer) {
    return { success: false, status: 'INVALID', message: 'Customer not found' };
  }

  if (!customer.active) {
    return { success: false, status: 'INVALID', message: 'Customer inactive' };
  }

  const subscription = await Subscription.findOne({ 
    customerId: customer._id, 
    active: true 
  }).sort({ createdAt: -1 });

  if (!subscription) {
    await MealTransaction.create({
      customerId: customer._id,
      subscriptionId: null,
      staffId,
      staffName,
      scannedByUserId: staffId,
      mealType: mealType || 'lunch',
      scanSource,
      status: 'failed',
      failureReason: 'no_subscription',
      timestamp: clientTime,
      deviceInfo: { deviceId }
    });
    return { success: false, status: 'INVALID', message: 'No active subscription' };
  }

  // Determine meal type if not provided
  const settings = await getSettings();
  const resolvedMealType = mealType || determineMealType(settings);
  
  if (!resolvedMealType) {
    await MealTransaction.create({
      customerId: customer._id,
      subscriptionId: subscription._id,
      staffId,
      staffName,
      scannedByUserId: staffId,
      mealType: 'lunch',
      scanSource,
      status: 'failed',
      failureReason: 'invalid_meal_window',
      timestamp: clientTime,
      deviceInfo: { deviceId }
    });
    return { success: false, status: 'WINDOW_CLOSED', message: 'Outside meal window' };
  }

  // Duplicate check
  const windowSec = settings?.doubleScanWindowSeconds || 30;
  const windowStart = new Date(Date.now() - windowSec * 1000);
  const duplicate = await MealTransaction.findOne({
    customerId: customer._id,
    mealType: resolvedMealType,
    timestamp: { $gte: windowStart },
    status: 'success'
  });

  if (duplicate) {
    await MealTransaction.create({
      customerId: customer._id,
      subscriptionId: subscription._id,
      staffId,
      staffName,
      scannedByUserId: staffId,
      mealType: resolvedMealType,
      scanSource,
      status: 'duplicate',
      duplicateOfTransaction: duplicate._id,
      timestamp: clientTime,
      deviceInfo: { deviceId }
    });
    return { success: false, status: 'ALREADY_USED', message: 'Already scanned for this meal' };
  }

  // Check meals remaining
  if (subscription.mealsRemaining <= 0) {
    await MealTransaction.create({
      customerId: customer._id,
      subscriptionId: subscription._id,
      staffId,
      staffName,
      scannedByUserId: staffId,
      mealType: resolvedMealType,
      scanSource,
      status: 'failed',
      failureReason: 'no_meals_remaining',
      timestamp: clientTime,
      deviceInfo: { deviceId }
    });
    return { success: false, status: 'EXPIRED', message: 'No meals remaining' };
  }

  // Atomic deduction
  const mealsRemainingBefore = subscription.mealsRemaining;
  subscription.mealsRemaining = Math.max(0, subscription.mealsRemaining - 1);
  await subscription.save();

  // Create successful transaction
  const mealTx = await MealTransaction.create({
    customerId: customer._id,
    subscriptionId: subscription._id,
    staffId,
    staffName,
    scannedByUserId: staffId,
    mealType: resolvedMealType,
    scanSource,
    status: 'success',
    timestamp: clientTime,
    mealsRemainingBefore,
    mealsRemainingAfter: subscription.mealsRemaining,
    qrCodeId: customer.qrCodeId,
    deviceInfo: { deviceId }
  });

  // Check renewal threshold
  const consumedCount = (subscription.mealsTotal || customer.billingCycleMeals) - subscription.mealsRemaining;
  const threshold = customer.billingCycleMeals || 30;
  let notification = null;
  let autoRenewed = false;

  if (consumedCount >= threshold || subscription.mealsRemaining <= 0) {
    if (customer.autoRenew && customer.preferredPaymentMethod !== 'NONE' && hasPaymentInfo(customer)) {
      // Auto-renew: create ledger entry and extend subscription
      // TODO: Integrate real payment gateway here
      customer.ledger.push({
        amount: customer.billingAmount,
        method: customer.preferredPaymentMethod,
        note: 'Auto-renewal',
        staffId: null
      });
      customer.lastPaymentAt = new Date();
      await customer.save();

      // Extend subscription
      await createRenewalSubscription(customer, subscription);
      
      notification = await Notification.create({
        title: 'Auto-renewal completed',
        body: `Auto-renewal completed for ${customer.name} (${customer.phone})`,
        level: 'INFO',
        customerId: customer._id,
        data: { amount: customer.billingAmount, method: customer.preferredPaymentMethod }
      });
      autoRenewed = true;
    } else {
      // Create renewal notification
      notification = await Notification.create({
        title: 'Renewal required',
        body: `${customer.name} (${customer.phone}) needs subscription renewal`,
        level: 'WARN',
        customerId: customer._id,
        data: { mealsRemaining: subscription.mealsRemaining }
      });
      subscription.needsRenewal = true;
      await subscription.save();
    }
  }

  return {
    success: true,
    status: 'SUCCESS',
    transaction: mealTx,
    customer: {
      name: customer.name,
      phone: customer.phone,
      roomNo: customer.roomNo
    },
    subscription: {
      mealsRemaining: subscription.mealsRemaining,
      needsRenewal: subscription.needsRenewal
    },
    mealType: resolvedMealType,
    notificationId: notification?._id,
    autoRenewed
  };
}

function hasPaymentInfo(customer) {
  return customer.upiId || customer.preferredPaymentMethod === 'CASH';
}

async function createRenewalSubscription(customer, oldSubscription) {
  const newMeals = customer.billingCycleMeals || 30;
  const extendDays = 30;
  
  // Reset current subscription
  oldSubscription.mealsRemaining = newMeals;
  oldSubscription.mealsTotal = newMeals;
  oldSubscription.endDate = new Date(Date.now() + extendDays * 24 * 60 * 60 * 1000);
  oldSubscription.needsRenewal = false;
  await oldSubscription.save();
  
  return oldSubscription;
}
