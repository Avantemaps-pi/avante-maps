
import React, { ReactNode, useEffect, useRef } from 'react';
import { useLocation } from '@/lib/router-compat';
import PageHeader from '@/components/layout/PageHeader';

import { SidebarProvider } from '@/components/ui/sidebar';
import AppSidebar from './AppSidebar';
import BottomNavBar from './BottomNavBar';
import PendingContactCodeBanner from './PendingContactCodeBanner';
import { useIsMobile } from '@/hooks/use-mobile';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';

interface AppLayoutProps {
  children: ReactNode;
  title?: string;
  withHeader?: boolean;
  fullHeight?: boolean;
  fullWidth?: boolean;
  hideSidebar?: boolean;
  hideBottomNav?: boolean;
  onSearch?: (searchTerm: string) => void;
  showSearch?: boolean;
  className?: string;
  backButton?: boolean;
  onBackClick?: () => void;
  
}

const AppLayout: React.FC<AppLayoutProps> = ({ 
  children, 
  title,
  withHeader = true, 
  fullHeight = false,
  fullWidth = false,
  hideSidebar = false,
  hideBottomNav = false,
  onSearch,
  showSearch = false,
  className = '',
  backButton = false,
  onBackClick,
  
}) => {
  const isMobile = useIsMobile();
  const keyboardOpen = useKeyboardOpen();
  const location = useLocation();
  const mainRef = useRef<HTMLElement>(null);
  // fullHeight: exactly the visible screen (dvh; 100vh is taller on phones), and only the page's own lists scroll
  const contentClasses = `flex min-w-0 flex-col ${fullHeight ? 'h-dvh' : 'min-h-screen'} ${fullWidth ? 'w-full' : 'max-w-7xl mx-auto w-full'} ${className}`;

  // Move focus to the page title (or main region) on route change so screen
  // readers announce the new page and keyboard users land in the new content.
  useEffect(() => {
    const focusTarget =
      (document.getElementById('page-title') as HTMLElement | null) ?? mainRef.current;
    if (!focusTarget) return;
    const prevTabIndex = focusTarget.getAttribute('tabindex');
    if (prevTabIndex === null) focusTarget.setAttribute('tabindex', '-1');
    focusTarget.focus({ preventScroll: true });
    // Avoid leaving a persistent focus ring on headings
    const handleBlur = () => {
      if (prevTabIndex === null) focusTarget.removeAttribute('tabindex');
      focusTarget.removeEventListener('blur', handleBlur);
    };
    focusTarget.addEventListener('blur', handleBlur);
  }, [location.pathname]);

  // Room for the fixed bottom nav. A fullHeight page ends exactly at its top edge (h-16, its 1px
  // border and the safe area), with nothing while the keyboard hides it; scrolling pages keep
  // some extra space at the end. A scrolling page without the nav (a task page) ends above the
  // home bar; fullHeight pages without it pad their own bottom bar.
  const navClearance = !isMobile
    ? undefined
    : hideBottomNav
      ? (fullHeight ? undefined : 'max(1rem, env(safe-area-inset-bottom))')
      : fullHeight
      ? (keyboardOpen ? '0px' : 'calc(4rem + 1px + env(safe-area-inset-bottom))')
      : 'calc(6rem + env(safe-area-inset-bottom))';

  return (
    <SidebarProvider>
      {/* Scrolling pages clip rather than hide: overflow-x-hidden would make this a scroll container, and the sticky header would scroll away */}
      <div className={`flex ${fullHeight ? 'min-h-dvh overflow-x-hidden' : 'min-h-screen overflow-x-clip'} w-full min-w-0`}>
        {!hideSidebar && <AppSidebar />}
        
        <div className={contentClasses}>
          {withHeader && (
            <PageHeader 
              title={title} 
              hideSidebar={hideSidebar} 
              onSearch={onSearch}
              showSearch={showSearch}
              backButton={backButton}
              onBackClick={onBackClick}
            />
          )}
          <PendingContactCodeBanner />
          
          <main
            ref={mainRef}
            id="main-content"
            tabIndex={-1}
            aria-labelledby="page-title"
            className={`flex-1 w-full min-w-0 overflow-x-hidden ${fullHeight ? 'flex flex-col min-h-0 overflow-hidden' : 'overflow-y-auto'} animate-fade-in outline-hidden ${isMobile && !hideBottomNav && !fullHeight ? 'pb-24' : ''}`}
            style={navClearance ? { paddingBottom: navClearance } : undefined}
          >
            {children}
          </main>

          
          {!hideBottomNav && <BottomNavBar />}
        </div>
      </div>
    </SidebarProvider>
  );
};

export default AppLayout;
