import React, { useState, useEffect, useRef } from 'react';
import AppLayout from '@/components/layout/AppLayout';
import { toast } from 'sonner';
import PullToRefresh from 'react-simple-pull-to-refresh';
import { supabase } from '@/integrations/supabase/client';
import { 
  getAllNotifications, 
  markNotificationAsRead, 
  markMultipleNotificationsAsRead,
  markMultipleNotificationsAsUnread,
  notificationUpdateEvent,
  trackNotificationClick
} from '@/utils/notificationUtils';
import { NotificationProps } from '@/types/notification';
import NotificationItem from '@/components/notifications/NotificationItem';
import EmptyNotifications from '@/components/notifications/EmptyNotifications';
import NotificationCategoryTabs from '@/components/notifications/NotificationCategoryTabs';
import BulkActionsBar from '@/components/notifications/BulkActionsBar';
import { NotificationCategory, getNotificationsByCategory } from '@/utils/notificationCategories';
import { RefreshCw } from 'lucide-react';

// Today (by the device's date) or earlier; a row just received has no created_at yet: today
const isToday = (createdAt?: string) => {
  if (!createdAt) return true;
  return new Date(createdAt).toDateString() === new Date().toDateString();
};

const Notifications = () => {
  const [notifications, setNotifications] = useState<NotificationProps[]>([]);
  const [activeCategory, setActiveCategory] = useState<NotificationCategory>('all');
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [newNotificationIds, setNewNotificationIds] = useState<Set<string>>(new Set());
  const channelRef = useRef<ReturnType<typeof supabase.channel> | null>(null);

  // Load initial notifications
  useEffect(() => {
    loadNotifications();
  }, []);

  // Set up real-time subscription
  useEffect(() => {
    const setupRealtime = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;

      const channel = supabase
        .channel('notifications-realtime')
        .on(
          'postgres_changes',
          {
            event: 'INSERT',
            schema: 'public',
            table: 'notifications',
            filter: `user_id=eq.${user.id}`
          },
          (payload) => {
            // Trigger haptic feedback for new notification
            if ('vibrate' in navigator) {
              navigator.vibrate([50, 100, 50]);
            }

            const newNotification: NotificationProps = {
              id: payload.new['id'],
              type: payload.new['type'],
              content: payload.new['content'],
              time: 'Just now',
              read: payload.new['read'],
              metadata: payload.new['metadata'],
              priority: payload.new['priority'] || 'medium',
              created_at: payload.new['created_at'],
              click_url: payload.new['click_url'] ?? null
            };

            // Add to new notification IDs for animation
            setNewNotificationIds(prev => new Set([...prev, newNotification.id]));
            
            // Remove from animation set after 2 seconds
            setTimeout(() => {
              setNewNotificationIds(prev => {
                const newSet = new Set(prev);
                newSet.delete(newNotification.id);
                return newSet;
              });
            }, 2000);

            setNotifications(prev => [newNotification, ...prev]);
            window.dispatchEvent(notificationUpdateEvent);
            toast.success('New notification received', { id: 'notif:new', duration: 4000 });
          }
        )
        .subscribe();

      channelRef.current = channel;
    };

    setupRealtime();

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current);
      }
    };
  }, []);

  const loadNotifications = async () => {
    const data = await getAllNotifications();
    setNotifications(data);
  };
  
  const markAsRead = async (id: string) => {
    await markNotificationAsRead(id);
    await loadNotifications();
    window.dispatchEvent(notificationUpdateEvent);
  };
  
  const openNotification = (id: string) => {
    void trackNotificationClick(id);
  };

  // The current tab's unread rows only
  const markAllAsRead = async () => {
    const ids = getNotificationsByCategory(notifications, activeCategory)
      .filter(notification => !notification.read)
      .map(notification => notification.id);
    if (ids.length === 0) return;
    await markMultipleNotificationsAsRead(ids);
    await loadNotifications();
    toast.success('All notifications marked as read', { id: 'notif:mark-all-read', duration: 4000 });
    window.dispatchEvent(notificationUpdateEvent);
  };

  const toggleSelectionMode = () => {
    setSelectionMode(!selectionMode);
    setSelectedIds(new Set());
  };

  const toggleSelection = (id: string) => {
    const newSelected = new Set(selectedIds);
    if (newSelected.has(id)) {
      newSelected.delete(id);
    } else {
      newSelected.add(id);
    }
    setSelectedIds(newSelected);
  };

  const handleBulkMarkAsRead = async () => {
    const idsArray = Array.from(selectedIds);
    await markMultipleNotificationsAsRead(idsArray);
    await loadNotifications();
    toast.success(`${idsArray.length} notifications marked as read`);
    setSelectedIds(new Set());
    setSelectionMode(false);
    window.dispatchEvent(notificationUpdateEvent);
  };

  const handleBulkMarkAsUnread = async () => {
    const idsArray = Array.from(selectedIds);
    await markMultipleNotificationsAsUnread(idsArray);
    await loadNotifications();
    toast.success(`${idsArray.length} notifications marked as unread`);
    setSelectedIds(new Set());
    setSelectionMode(false);
    window.dispatchEvent(notificationUpdateEvent);
  };

  const handleClearSelection = () => {
    setSelectedIds(new Set());
    setSelectionMode(false);
  };

  const handleRefresh = async () => {
    // Trigger haptic feedback
    if ('vibrate' in navigator) {
      navigator.vibrate(50);
    }

    await loadNotifications();
    window.dispatchEvent(notificationUpdateEvent);
    toast.success('Notifications refreshed', { id: 'notif:refreshed', duration: 4000 });
  };

  const filteredNotifications = getNotificationsByCategory(notifications, activeCategory);
  const unreadCount = filteredNotifications.filter(notification => !notification.read).length;
  // Newest first, then grouped
  const sorted = [...filteredNotifications].sort((a, b) =>
    (b.created_at ?? '\uffff').localeCompare(a.created_at ?? '\uffff')
  );
  const groups = [
    { label: 'Today', items: sorted.filter(notification => isToday(notification.created_at)) },
    { label: 'Earlier', items: sorted.filter(notification => !isToday(notification.created_at)) },
  ].filter(group => group.items.length > 0);

  const renderRow = (notification: NotificationProps) => (
    <div
      key={notification.id}
      className={newNotificationIds.has(notification.id) ? 'animate-fade-in' : ''}
    >
      <NotificationItem
        notification={notification}
        onReadNotification={markAsRead}
        onOpenNotification={openNotification}
        isSelected={selectedIds.has(notification.id)}
        onToggleSelection={toggleSelection}
        selectionMode={selectionMode}
      />
    </div>
  );

  return (
    <AppLayout title="Notifications">
      <div className="max-w-3xl mx-auto">
        {/* All · Account · Activity */}
        <div className="px-3 py-2 border-b border-border">
          <NotificationCategoryTabs
            activeCategory={activeCategory}
            onCategoryChange={setActiveCategory}
          />
        </div>

        {/* Notifications list with pull-to-refresh */}
        <PullToRefresh
          onRefresh={handleRefresh}
          pullingContent={
            <div className="flex justify-center py-4">
              <RefreshCw className="h-5 w-5 text-muted-foreground animate-spin" />
            </div>
          }
          refreshingContent={
            <div className="flex justify-center py-4">
              <RefreshCw className="h-5 w-5 text-primary animate-spin" />
            </div>
          }
          pullDownThreshold={80}
          maxPullDownDistance={100}
          resistance={2}
        >
          <div>
            {groups.length > 0 ? (
              groups.map((group, index) => (
                <section key={group.label} aria-label={group.label}>
                  <div className={`flex items-center justify-between px-4 ${index === 0 ? 'pt-1' : 'pt-3'}`}>
                    <h2 className="py-3 text-[13px] font-semibold text-muted-foreground">{group.label}</h2>
                    {index === 0 && unreadCount > 0 && (
                      <button
                        type="button"
                        onClick={markAllAsRead}
                        className="min-h-11 text-sm font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-sm"
                      >
                        Mark all as read
                      </button>
                    )}
                  </div>
                  {group.items.map(renderRow)}
                </section>
              ))
            ) : (
              <EmptyNotifications category={activeCategory} />
            )}
          </div>
        </PullToRefresh>

        {/* Bulk actions bar */}
        {selectionMode && selectedIds.size > 0 && (
          <BulkActionsBar
            selectedCount={selectedIds.size}
            onMarkAsRead={handleBulkMarkAsRead}
            onMarkAsUnread={handleBulkMarkAsUnread}
            onClearSelection={handleClearSelection}
          />
        )}
      </div>
    </AppLayout>
  );
};
export default Notifications;