import React, { useState, useEffect } from 'react';
import { useLocation } from '@/lib/router-compat';
import { useSidebar } from '@/components/ui/sidebar';
import { useIsMobile } from '@/hooks/use-mobile';
import DesktopSidebar from './sidebar/DesktopSidebar';
import MobileSidebar from './sidebar/MobileSidebar';
import { navItems } from './sidebar/sidebarConfig';
import { getUnreadNotificationsCount } from '@/utils/notificationUtils';
import { useAuth } from '@/context/auth';
import { useUnreadMessagesCount } from '@/hooks/useUnreadMessagesCount';

interface AppSidebarProps {
  className?: string;
}

const AppSidebar = ({ className }: AppSidebarProps = {}) => {
  const location = useLocation();
  const { openMobile, setOpenMobile } = useSidebar();
  const isMobile = useIsMobile();
  const { isAdmin } = useAuth();
  const [notificationCount, setNotificationCount] = useState(0);
  const unreadMessages = useUnreadMessagesCount();
  
  useEffect(() => {
    const updateNotifications = async () => {
      const count = await getUnreadNotificationsCount();
      setNotificationCount(count);
    };
    
    updateNotifications();
    
    window.addEventListener('notificationUpdate', updateNotifications);
    
    return () => {
      window.removeEventListener('notificationUpdate', updateNotifications);
    };
  }, []);
  
  const handleLinkClick = () => {
    setOpenMobile(false);
  };

  // Filter admin-only items and update the notification and unread message badges
  const filteredNavItems = navItems
    .filter(item => !item.adminOnly || isAdmin)
    .map(item => 
      item.to === '/notifications' 
        ? { ...item, badge: notificationCount }
        : item.to === '/communicon'
          ? { ...item, badge: unreadMessages }
          : item
    );

  return (
    <>
      {!isMobile ? (
        <DesktopSidebar
          className={className}
          navItems={filteredNavItems}
          currentPath={location.pathname}
          onLinkClick={handleLinkClick}
        />
      ) : (
        <MobileSidebar
          isOpen={openMobile}
          navItems={filteredNavItems}
          currentPath={location.pathname}
          onClose={() => setOpenMobile(false)}
          onLinkClick={handleLinkClick}
        />
      )}
    </>
  );
};

export default AppSidebar;
