import mongoose from 'mongoose';
import { qrTokenService } from './qrTokenService.js';
import { Customer } from '../models/Customer.js';
import { Subscription } from '../models/Subscription.js';
import { MealTransaction } from '../models/MealTransaction.js';
import { ApiError } from '../utils/errorHandler.js';

class ScanService {
  /**
   * Process QR scan with full validation
   */
  async processScan(qrToken, scannedByUserId, metadata) {
    const session = await mongoose.startSession();
    session.startTransaction();

    try {
      // 1. Verify JWT token
      const tokenData = qrTokenService.verifyToken(qrToken);
      
      // 2. Verify mess ownership
      if (tokenData.messId !== metadata.messId.toString()) {
        throw new ApiError('QR code belongs to different mess', 403, 'WRONG_MESS');
      }

      // 3. Verify scanner role (STAFF or ADMIN only)
      if (!['admin', 'staff'].includes(metadata.scannerRole)) {
        throw new ApiError('Only staff can scan QR codes', 403, 'UNAUTHORIZED_ROLE');
      }

      // 4. Find customer
      const customer = await Customer.findById(tokenData.customerId).session(session);
      if (!customer) {
        throw new ApiError('Customer not found', 404, 'CUSTOMER_NOT_FOUND');
      }

      if (!customer.active) {
        throw new ApiError('Customer account inactive', 400, 'CUSTOMER_INACTIVE');
      }

      // 5. Determine meal type FIRST
      const mealType = this.getCurrentMealType();

      // 6. Check duplicate scan (meal-type based, same day)
      const startOfDay = new Date();
      startOfDay.setHours(0, 0, 0, 0);
      const endOfDay = new Date();
      endOfDay.setHours(23, 59, 59, 999);

      const recentScan = await MealTransaction.findOne({
        customerId: customer._id,
        mealType,
        timestamp: { $gte: startOfDay, $lte: endOfDay },
        status: 'success'
      }).session(session);

      if (recentScan && !metadata.adminOverride) {
        throw new ApiError(
          `Already scanned ${mealType} today`,
          409,
          'DUPLICATE_SCAN'
        );
      }

      // 7. Find active subscription
      const subscription = await Subscription.findOne({
        customerId: customer._id,
        active: true,
        endDate: { $gte: new Date() }
      }).session(session);

      if (!subscription) {
        throw new ApiError('No active subscription', 400, 'NO_SUBSCRIPTION');
      }

      // 8. ATOMIC update - Decrement meals with condition (RACE CONDITION FIX)
      const updatedSubscription = await Subscription.findOneAndUpdate(
        { 
          _id: subscription._id,
          mealsRemaining: { $gt: 0 }, // ATOMIC CHECK
          active: true
        },
        { 
          $inc: { mealsRemaining: -1 },
          $set: { lastMealDate: new Date() }
        },
        { new: true, session }
      );

      if (!updatedSubscription) {
        throw new ApiError('No meals remaining', 400, 'NO_MEALS');
      }

      // 9. Create transaction record
      const transaction = await MealTransaction.create([{
        messId: metadata.messId,
        customerId: customer._id,
        subscriptionId: subscription._id,
        mealType,
        timestamp: new Date(),
        scannedByUserId,
        staffId: scannedByUserId,
        qrCodeId: customer.qrCodeId,
        mealsRemainingBefore: subscription.mealsRemaining + 1,
        mealsRemainingAfter: updatedSubscription.mealsRemaining,
        status: 'success',
        deviceInfo: {
          deviceId: metadata.deviceId,
          ipAddress: metadata.ipAddress
        },
        notes: metadata.manual ? 'Manual scan' : undefined
      }], { session });

      await session.commitTransaction();

      return {
        success: true,
        status: 'success',
        customer: {
          id: customer._id,
          name: customer.name,
          phone: customer.phone,
          roomNo: customer.roomNo
        },
        subscription: {
          mealsRemaining: updatedSubscription.mealsRemaining,
          planName: subscription.planId?.name || 'Unknown'
        },
        mealType,
        transaction: transaction[0]
      };

    } catch (error) {
      await session.abortTransaction();
      throw error;
    } finally {
      session.endSession();
    }
  }

  /**
   * Get current meal type based on time
   */
  getCurrentMealType() {
    const hour = new Date().getHours();
    if (hour >= 6 && hour < 11) return 'breakfast';
    if (hour >= 11 && hour < 16) return 'lunch';
    if (hour >= 16 && hour < 22) return 'dinner';
    return 'snack';
  }
}

export const scanService = new ScanService();
