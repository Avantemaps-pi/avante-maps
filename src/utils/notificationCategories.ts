import { NotificationProps, NotificationType } from '@/types/notification';
import { isActivityNotification } from './notificationKinds';

export type NotificationCategory = 'all' | 'account' | 'activity';

export const categoryConfig: Record<NotificationCategory, {
  label: string;
  types: NotificationType[];
}> = {
  all: {
    label: 'All',
    types: ['message', 'review', 'business', 'follower', 'like', 'verification', 'certification', 'payment', 'system']
  },
  account: {
    label: 'Account',
    types: ['business', 'verification', 'certification', 'payment', 'system']
  },
  activity: {
    label: 'Activity',
    types: ['follower', 'like', 'message', 'review']
  }
};

export const getNotificationsByCategory = (
  notifications: NotificationProps[],
  category: NotificationCategory
): NotificationProps[] => {
  // Always filter out bookmark notifications
  const filteredNotifications = notifications.filter(n => n.type !== 'bookmark');
  
  if (category === 'all') return filteredNotifications;

  // By kind: Activity is messages and reviews, Account is everything about the user's businesses,
  // plan and payments
  return filteredNotifications.filter(notification =>
    category === 'activity' ? isActivityNotification(notification) : !isActivityNotification(notification)
  );
};

export const getCategoryUnreadCount = (
  notifications: NotificationProps[],
  category: NotificationCategory
): number => {
  const categoryNotifications = getNotificationsByCategory(notifications, category);
  return categoryNotifications.filter(n => !n.read).length;
};

export const getAllCategoryCounts = (notifications: NotificationProps[]) => {
  // Filter out bookmarks from all counts
  const filteredNotifications = notifications.filter(n => n.type !== 'bookmark');
  
  return {
    all: filteredNotifications.filter(n => !n.read).length,
    account: getCategoryUnreadCount(notifications, 'account'),
    activity: getCategoryUnreadCount(notifications, 'activity')
  };
};
