
import React from 'react';
import { Link, useNavigate } from '@/lib/router-compat';
import { Button } from '@/components/ui/button';
import { X, UserRound, LogIn, LogOut } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import NavItem from './NavItem';
import { useAuth } from '@/context/auth';
import { cn } from '@/lib/utils';
import { getInitials } from '@/lib/getInitials';

interface MobileSidebarProps {
  isOpen: boolean;
  navItems: Array<{
    to: string;
    icon: React.ElementType;
    label: string;
    badge?: number | null;
    desktopOnly?: boolean;
  }>;
  currentPath: string;
  onClose: () => void;
  onLinkClick: () => void;
}

const MobileSidebar = ({
  isOpen,
  navItems,
  currentPath,
  onClose,
  onLinkClick
}: MobileSidebarProps) => {
  const navigate = useNavigate();
  const {
    user,
    isAuthenticated,
    login,
    logout,
    isLoading
  } = useAuth();

  const username = user?.username || 'Guest';
  
  const formatPlanType = (tier?: string) => {
    if (!tier) return 'Individual';
    return tier.charAt(0).toUpperCase() + tier.slice(1).replace('-', ' ');
  };
  
  const planType = formatPlanType(user?.subscriptionTier);

  const handleLogin = () => {
    login();
    onClose();
  };
  
  const handleLogout = () => {
    logout();
    onClose();
  };

  const handlePlanClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate('/pricing');
    onClose();
  };

  const handleIndividualPlanClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigate('/pricing');
    onClose();
  };

  const footerLinks = [
    { to: '/privacy', label: 'Privacy' },
    { to: '/terms', label: 'Terms' },
    { to: '/contact', label: 'Contact' },
  ];

  const handleProfileClick = () => {
    navigate('/settings');
    onClose();
  };

  return (
    <>
      {isOpen && (
        <div 
          className="fixed inset-0 bg-black/50 z-40 backdrop-blur-xs" 
          onClick={onClose} 
          aria-hidden="true" 
        />
      )}
      
      <div className={`fixed inset-y-0 left-0 w-4/5 max-w-[300px] bg-background z-[60] transform transition-transform duration-300 ease-in-out shadow-xl ${isOpen ? 'translate-x-0' : '-translate-x-full'}`}>
        <div className="flex flex-col h-full">
          <div className="p-4 flex items-center justify-between border-b border-sidebar-border">
            <div className="flex items-center gap-3 cursor-pointer" onClick={handleProfileClick}>
              <Avatar className="h-9 w-9 cursor-pointer hover:opacity-80 transition-opacity">
                {(user as any)?.avatarUrl ? <AvatarImage src={(user as any).avatarUrl} /> : null}
                <AvatarFallback className="text-xs">
                  {isAuthenticated ? getInitials(username) : <UserRound className="h-5 w-5" />}
                </AvatarFallback>
              </Avatar>
              <div className="flex flex-col">
                <span className="font-medium text-sm cursor-pointer hover:text-primary transition-colors">{username}</span>
                <span className="text-xs text-muted-foreground">
                  <span 
                    className={cn(
                      "cursor-pointer hover:text-primary transition-colors",
                      (user?.subscriptionTier === 'organization' || user?.subscriptionTier === 'small-business') && "text-primary font-medium"
                    )}
                    onClick={handleIndividualPlanClick}
                  >
                    {planType}
                  </span> <span 
                    className="text-xs text-muted-foreground cursor-pointer hover:text-primary transition-colors"
                    onClick={handlePlanClick}
                  >
                    Plan
                  </span>
                </span>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={onClose} aria-label="Close sidebar">
              <X className="h-5 w-5" />
            </Button>
          </div>
          
          <div className="flex-1 overflow-y-auto py-4 flex flex-col">
            {!isAuthenticated && (
              <div className="px-2 mb-4">
                <Button onClick={handleLogin} disabled={isLoading} className="w-full flex items-center bg-primary hover:bg-primary/90 text-primary-foreground">
                  <LogIn className="h-4 w-4 mr-2" />
                  {isLoading ? "Authenticating..." : "Login with Pi Network"}
                </Button>
              </div>
            )}
            
            <nav>
              <ul className="space-y-1 px-2">
                {navItems.filter(item => !item.desktopOnly).map(item => <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} isActive={currentPath === item.to} onClick={onLinkClick} {...(item.badge !== undefined ? { badge: item.badge } : {})} />)}
              </ul>
            </nav>

            {isAuthenticated && (
              <div className="mt-auto px-2 pt-4">
                <Button onClick={handleLogout} disabled={isLoading} variant="outline" className="w-full">
                  <LogOut className="h-4 w-4 mr-2" />
                  Logout
                </Button>
              </div>
            )}
          </div>

          {/* Same border, height and safe area as the bottom nav, so its top border lines up with the nav's */}
          <footer
            className="border-t border-border"
            style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}
          >
            <div className="h-16 px-4 flex flex-col justify-center text-xs text-muted-foreground">
              <div className="flex items-center gap-1.5">
                {footerLinks.map((item, index) => (
                  <React.Fragment key={item.to}>
                    {index > 0 && <span aria-hidden="true">·</span>}
                    <Link
                      to={item.to}
                      onClick={onLinkClick}
                      className="inline-flex items-center min-h-6 rounded-sm hover:text-primary focus-visible:text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring transition-colors"
                    >
                      {item.label}
                    </Link>
                  </React.Fragment>
                ))}
              </div>
              <p>© {new Date().getFullYear()} Avante Maps Pty Ltd</p>
            </div>
          </footer>
        </div>
      </div>
    </>
  );
};

export default MobileSidebar;
