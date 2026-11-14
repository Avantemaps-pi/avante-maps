
import React from 'react';
import { Link } from '@/lib/router-compat';
import { cn } from '@/lib/utils';
import { Sidebar, SidebarContent, SidebarHeader } from '@/components/ui/sidebar';
import NavItem from './NavItem';
import { useAuth } from '@/context/auth';
import { Button } from '@/components/ui/button';
import { LogIn, LogOut } from 'lucide-react';
interface DesktopSidebarProps {
  className?: string | undefined;
  navItems: Array<{
    to: string;
    icon: React.ElementType;
    label: string;
    badge?: number | null;
  }>;
  currentPath: string;
  onLinkClick: () => void;
}
const DesktopSidebar = ({
  className,
  navItems,
  currentPath,
  onLinkClick
}: DesktopSidebarProps) => {
  const {
    isAuthenticated,
    login,
    logout,
    isLoggingOut,
    isLoading
  } = useAuth();

  const handleLogin = () => {
    login();
    onLinkClick();
  };

  const handleLogout = async () => {
    await logout();
    onLinkClick();
  };
  return <Sidebar className={cn("hidden md:flex", className)}>
      <SidebarHeader>
        <Link to="/" className="flex items-center gap-2 px-2 py-1">
          <div className="h-8 w-8 rounded-lg bg-primary flex items-center justify-center">
            <span className="text-primary-foreground font-bold text-sm">A</span>
          </div>
          <div className="flex flex-col">
            <span className="font-semibold text-sm leading-tight">Avante Maps</span>
            <span className="text-xs text-muted-foreground leading-tight">Pi Network Directory</span>
          </div>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <div className="flex-1 overflow-y-auto no-scrollbar p-4 space-y-6">
          {!isAuthenticated && (
            <div className="mb-2">
              <Button onClick={handleLogin} disabled={isLoading} className="w-full bg-primary hover:bg-primary/90 text-primary-foreground">
                <LogIn className="h-4 w-4 mr-2" />
                {isLoading ? "Authenticating..." : "Login with Pi Network"}
              </Button>
            </div>
          )}

          <nav>
            <ul className="space-y-1">
              {navItems.map(item => <NavItem key={item.to} to={item.to} icon={item.icon} label={item.label} isActive={currentPath === item.to} onClick={onLinkClick} badge={item.badge} />)}
            </ul>
          </nav>

          {isAuthenticated && (
            <div className="mt-4 pt-4 border-t border-sidebar-border">
              <Button onClick={handleLogout} disabled={isLoading || isLoggingOut} variant="outline" className="w-full">
                <LogOut className="h-4 w-4 mr-2" />
                {isLoggingOut ? 'Logging out…' : 'Logout'}
              </Button>
            </div>
          )}
        </div>
      </SidebarContent>
    </Sidebar>;
};
export default DesktopSidebar;
