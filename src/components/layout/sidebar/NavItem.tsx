
import React from 'react';
import { Link } from '@/lib/router-compat';
import { cn } from '@/lib/utils';
import { useAuth } from '@/context/auth';
import { prefetchRoute } from '@/lib/routePrefetch';

interface NavItemProps {
  to: string;
  icon: React.ElementType;
  label: string;
  isActive: boolean;
  onClick?: () => void;
  badge?: number | null | undefined;
  isLogout?: boolean;
  requiresAuth?: boolean;
}

const NavItem = ({ 
  to, 
  icon: Icon, 
  label, 
  isActive, 
  onClick, 
  badge, 
  isLogout,
  requiresAuth = false 
}: NavItemProps) => {
  const { logout, isAuthenticated } = useAuth();

  // If this is an auth-required item and user is not authenticated, don't render
  if (requiresAuth && !isAuthenticated) {
    return null;
  }
  
  const handleClick = (e: React.MouseEvent) => {
    if (isLogout) {
      e.preventDefault();
      // logout() goes to the landing page itself
      void logout();
    }
    
    if (onClick) {
      onClick();
    }
  };
  
  return (
    <li>
      <Link 
        to={to} 
        className={cn(
          "flex items-center gap-2.5 px-3 py-1.5 rounded-md text-sm transition-colors hover:bg-sidebar-accent/80 hover:text-sidebar-accent-foreground relative",
          isActive ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "text-sidebar-foreground"
        )}
        onClick={handleClick}
        onMouseEnter={() => !isLogout && prefetchRoute(to)}
        onFocus={() => !isLogout && prefetchRoute(to)}
        onTouchStart={() => !isLogout && prefetchRoute(to)}
      >
        <Icon className={cn("h-4 w-4", isActive ? "text-primary" : "text-muted-foreground")} />
        <span>{label}</span>
        {badge != null && badge > 0 && (
          <span className="absolute right-4 bg-primary text-primary-foreground rounded-full w-6 h-6 flex items-center justify-center text-xs">
            {badge}
          </span>
        )}
      </Link>
    </li>
  );
};

export default NavItem;
