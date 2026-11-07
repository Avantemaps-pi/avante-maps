import { NotificationProps, NotificationType, NotificationMetadata, NotificationPriority } from '@/types/notification';
import { generateNotificationMessage } from './notificationTemplates';
import { supabase } from '@/integrations/supabase/client';

// Helper function to get unread notification count from database
export const getUnreadNotificationsCount = async (): Promise<number> => {
  const { count, error } = await supabase
    .from('notifications')
    .select('*', { count: 'exact', head: true })
    .eq('read', false);
  
  if (error) {
    console.error('Error fetching unread count:', error);
    return 0;
  }
  
  return count || 0;
};

// Helper function to update a notification's read status
export const markNotificationAsRead = async (id: string): Promise<void> => {
  const { error } = await supabase
    .from('notifications')
    .update({ 
      read: true,
      read_at: new Date().toISOString()
    })
    .eq('id', id);
  
  if (error) {
    console.error('Error marking notification as read:', error);
    return;
  }

  // Track the read event
  try {
    await supabase.functions.invoke('track-notification', {
      body: {
        notification_id: id,
        event_type: 'read'
      }
    });
  } catch (trackError) {
    console.error('Error tracking notification read:', trackError);
  }
};

// Records that the notification's action was opened (clicked_at and click_url, by track-notification)
export const trackNotificationClick = async (id: string, clickUrl: string): Promise<void> => {
  try {
    await supabase.functions.invoke('track-notification', {
      body: {
        notification_id: id,
        event_type: 'clicked',
        click_url: clickUrl
      }
    });
  } catch (trackError) {
    console.error('Error tracking notification click:', trackError);
  }
};

// Helper function to mark all notifications as read
export const markAllNotificationsAsRead = async (): Promise<void> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return;

  const { error } = await supabase
    .from('notifications')
    .update({ 
      read: true,
      read_at: new Date().toISOString()
    })
    .eq('user_id', user.id)
    .eq('read', false);
  
  if (error) {
    console.error('Error marking all notifications as read:', error);
  }
};

// Helper function to mark multiple notifications as read
export const markMultipleNotificationsAsRead = async (ids: string[]): Promise<void> => {
  const { error } = await supabase
    .from('notifications')
    .update({ 
      read: true,
      read_at: new Date().toISOString()
    })
    .in('id', ids);
  
  if (error) {
    console.error('Error marking multiple notifications as read:', error);
  }
};

// Helper function to mark multiple notifications as unread
export const markMultipleNotificationsAsUnread = async (ids: string[]): Promise<void> => {
  const { error } = await supabase
    .from('notifications')
    .update({ read: false })
    .in('id', ids);
  
  if (error) {
    console.error('Error marking multiple notifications as unread:', error);
  }
};

// Helper function to get all notifications
export const getAllNotifications = async (): Promise<NotificationProps[]> => {
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return [];

  const { data, error } = await supabase
    .from('notifications')
    .select('id, type, content, read, metadata, created_at, priority, click_url')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false });
  
  if (error) {
    console.error('Error fetching notifications:', error);
    return [];
  }
  
  return (data || []).map(notification => ({
    id: notification.id,
    type: notification.type as NotificationType,
    content: notification.content,
    time: formatRelativeTime(new Date(notification.created_at)),
    read: notification.read,
    metadata: notification.metadata as NotificationMetadata,
    created_at: notification.created_at,
    priority: (notification.priority || 'medium') as NotificationPriority,
    click_url: notification.click_url
  }));
};

// Helper function to format relative time
const formatRelativeTime = (date: Date): string => {
  const now = new Date();
  const diffInSeconds = Math.floor((now.getTime() - date.getTime()) / 1000);
  
  if (diffInSeconds < 60) return 'Just now';
  if (diffInSeconds < 3600) return `${Math.floor(diffInSeconds / 60)}m ago`;
  if (diffInSeconds < 86400) return `${Math.floor(diffInSeconds / 3600)}h ago`;
  if (diffInSeconds < 604800) return `${Math.floor(diffInSeconds / 86400)}d ago`;
  return date.toLocaleDateString();
};

// Custom event for notification updates
export const notificationUpdateEvent = new CustomEvent('notificationUpdate');
