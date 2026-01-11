import Razorpay from 'razorpay';
import crypto from 'crypto';
import dotenv from 'dotenv';

dotenv.config();

let razorpay = null;

const getRazorpayInstance = () => {
  if (!razorpay) {
    if (!process.env.RAZORPAY_KEY_ID || !process.env.RAZORPAY_KEY_SECRET) {

      return null;
    }
    razorpay = new Razorpay({
      key_id: process.env.RAZORPAY_KEY_ID,
      key_secret: process.env.RAZORPAY_KEY_SECRET
    });
  }
  return razorpay;
};

export const createOrder = async (amount, currency = 'INR', receipt, notes = {}) => {
  const instance = getRazorpayInstance();
  if (!instance) {
    throw new Error('Razorpay is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }
  return await instance.orders.create({
    amount: amount * 100, // Convert to paise
    currency,
    receipt,
    notes
  });
};

export const verifyPaymentSignature = (orderId, paymentId, signature) => {
  if (!process.env.RAZORPAY_KEY_SECRET) {
    throw new Error('Razorpay secret is not configured.');
  }
  const text = `${orderId}|${paymentId}`;
  const generated = crypto
    .createHmac('sha256', process.env.RAZORPAY_KEY_SECRET)
    .update(text)
    .digest('hex');
  return generated === signature;
};

export const fetchPayment = async (paymentId) => {
  const instance = getRazorpayInstance();
  if (!instance) {
    throw new Error('Razorpay is not configured. Please set RAZORPAY_KEY_ID and RAZORPAY_KEY_SECRET.');
  }
  return await instance.payments.fetch(paymentId);
};

export default getRazorpayInstance;
