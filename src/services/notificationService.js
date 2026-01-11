import { Notification } from '../models/Notification.js';

export async function createNotification({
  messId,
  userId = null,
  title,
  message,
  type,
  priority = 'LOW',
  strict = false,
  expiresInHours = null,
  actionUrl = null,
  metadata = null
}) {
  const expiresAt = expiresInHours
    ? new Date(Date.now() + expiresInHours * 60 * 60 * 1000)
    : null;

  return Notification.create({
    messId,
    userId,
    title,
    message,
    type,
    priority,
    strict,
    expiresAt,
    actionUrl,
    metadata
  });
}

export async function createBroadcastNotification({
  messId,
  title,
  message,
  type,
  priority = 'MEDIUM',
  strict = false,
  expiresInHours = null
}) {
  return createNotification({
    messId,
    userId: null,
    title,
    message,
    type,
    priority,
    strict,
    expiresInHours
  });
}

export async function checkDuplicateNotification(messId, type, title, withinHours = 24) {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000);
  return Notification.findOne({
    messId,
    type,
    title,
    createdAt: { $gte: since }
  }).lean();
}

export async function markAsRead(notificationId, userId) {
  const notification = await Notification.findById(notificationId);
  
  if (!notification) {
    throw new Error('Notification not found');
  }

  if (notification.strict) {
    throw new Error('This notification cannot be dismissed');
  }

  notification.read = true;
  await notification.save();
  return notification;
}

export async function deleteNotification(notificationId, messId) {
  return Notification.findOneAndDelete({ _id: notificationId, messId });
}
