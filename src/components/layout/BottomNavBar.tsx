import React, { useState, useEffect, useRef } from 'react';
import { Link, useLocation } from '@/lib/router-compat';
import { Map, LayoutGrid, Bookmark, MessageSquare, Settings } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useIsMobile } from '@/hooks/use-mobile';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';
import { useUnreadMessagesCount, formatUnreadCount } from '@/hooks/useUnreadMessagesCount';

const navItems = [
  { to: '/recommendations', icon: LayoutGrid, label: 'Discover' },
  { to: '/bookmarks', icon: Bookmark, label: 'Saved' },
  { to: '/', icon: Map, label: 'Map' },
  { to: '/communicon', icon: MessageSquare, label: 'CommuniCon' },
  { to: '/settings', icon: Settings, label: 'Settings' },
];

interface BottomNavBarProps {
  /** A tab was tapped (also when it's the current page, e.g. Map while the list view is open) */
  onItemClick?: ((to: string) => void) | undefined;
}

const BottomNavBar: React.FC<BottomNavBarProps> = ({ onItemClick }) => {
  const isMobile = useIsMobile();
  const location = useLocation();
  const [visible, setVisible] = useState(true);
  const keyboardOpen = useKeyboardOpen();
  const unreadMessages = useUnreadMessagesCount();
  const lastScrollY = useRef(0);

  useEffect(() => {
    const handleScroll = () => {
      const currentScrollY = window.scrollY;
      if (currentScrollY > lastScrollY.current && currentScrollY > 50) {
        setVisible(false);
      } else {
        setVisible(true);
      }
      lastScrollY.current = currentScrollY;
    };

    window.addEventListener('scroll', handleScroll, { passive: true });
    return () => window.removeEventListener('scroll', handleScroll);
  }, []);

  if (!isMobile) return null;

  // Off-screen while scrolled away or while the on-screen keyboard is open
  const hidden = !visible || keyboardOpen;

  return (
    <nav
      className={cn(
        "fixed bottom-0 left-0 right-0 z-50 border-t border-border bg-surface-float shadow-sheet transition-transform duration-300",
        hidden ? "translate-y-[calc(100%+env(safe-area-inset-bottom))]" : "translate-y-0"
      )}
      style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
      aria-hidden={hidden || undefined}
      inert={hidden}
    >
      <div className="flex items-center justify-around h-16">
        {navItems.map(({ to, icon: Icon, label }) => {
          const isActive = location.pathname === to;
          const unread = to === '/communicon' ? unreadMessages : 0;
          return (
            <Link
              key={to}
              to={to}
              aria-label={unread > 0 ? `${label}, ${unread} unread` : label}
              onClick={() => onItemClick?.(to)}
              className={cn(
                'flex flex-col items-center justify-center gap-1 flex-1 h-full text-xs transition-colors',
                isActive
                  ? 'text-primary font-semibold'
                  : 'text-muted-foreground font-medium hover:text-foreground'
              )}
            >
              <span
                className={cn(
                  'relative flex h-7 w-14 items-center justify-center rounded-full',
                  isActive && 'bg-accent'
                )}
              >
                <Icon className="h-5 w-5" strokeWidth={isActive ? 2.5 : 2} />
                {unread > 0 && (
                  <span
                    data-unread-badge
                    aria-hidden="true"
                    className="absolute -top-0.5 left-[calc(50%+3px)] flex h-4 min-w-4 items-center justify-center rounded-full bg-primary px-1 text-[11px] font-semibold leading-none text-primary-foreground ring-2 ring-surface-float"
                  >
                    {formatUnreadCount(unread)}
                  </span>
                )}
              </span>
              <span className="leading-none">{label}</span>
            </Link>
          );
        })}
      </div>
    </nav>
  );
};

export default BottomNavBar;
