
import React, { useState, useEffect } from 'react';
import { Link } from '@/lib/router-compat';
import AppLayout from '@/components/layout/AppLayout';
import ProfileSettings from '@/components/settings/ProfileSettings';
import AppPreferences from '@/components/settings/AppPreferences';
import DangerZone from '@/components/settings/DangerZone';
import { useIsMobile } from '@/hooks/use-mobile';
import { useAuth } from '@/context/auth';
import { useSessionTimeout } from '@/hooks/useSessionTimeout';
import {
  User,
  Settings as SettingsIcon,
  AlertTriangle,
  Scale,
  ChevronRight,
  Shield,
  FileText,
  Cookie,
  Mail,
} from 'lucide-react';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { getSessionUserId } from '@/lib/sessionUserId';
import {
  Accordion,
  AccordionContent,
  AccordionItem,
  AccordionTrigger,
} from "@/components/ui/accordion";

const Settings = () => {
  const isMobile = useIsMobile();
  const {
    user,
    refreshUserData,
    isLoading
  } = useAuth();
  useSessionTimeout();

  // Deterministic SSR defaults; real values hydrate from localStorage on mount
  // (see the client-only hydration effect below).
  const [colorScheme, setColorScheme] = useState<'system' | 'light' | 'dark'>('system');
  const [isDarkMode, setIsDarkMode] = useState(false);
  const [isAccountDeleted, setIsAccountDeleted] = useState(false);
  const [deletionDate, setDeletionDate] = useState<string | null>(null);
  const [activeSection, setActiveSection] = useState<string>("profile");
  // Deterministic SSR default: opt-in (true). Real value is hydrated from
  // localStorage after mount to keep server and first client render identical.
  const [useLocation, setUseLocation] = useState<boolean>(true);

  // Hydrate from localStorage on mount (client-only)
  useEffect(() => {
    if (typeof window === 'undefined') return;
    try {
      const stored = window.localStorage?.getItem('use_location_focus');
      if (stored === '0') setUseLocation(false);
      // Keys left over from the removed "Use device GPS" setting
      window.localStorage?.removeItem('use_device_gps');
      window.localStorage?.removeItem('location_gps_autoenabled');
      const savedScheme = window.localStorage?.getItem('colorScheme');
      if (savedScheme === 'light' || savedScheme === 'dark' || savedScheme === 'system') {
        setColorScheme(savedScheme);
        if (savedScheme === 'dark') setIsDarkMode(true);
        else if (savedScheme === 'light') setIsDarkMode(false);
      }
    } catch {
      // ignore — storage unavailable (private mode, disabled, etc.)
    }
  }, []);

  const handleUseLocationChange = (value: boolean) => {
    setUseLocation((prev) => {
      // Re-arm the one-time geolocation prompt when toggling from off → on
      // so the user is asked exactly once after re-enabling the setting.
      if (!prev && value) {
        try { window.localStorage?.removeItem('geolocation_prompted'); } catch { /* ignore */ }
      }
      return value;
    });
    if (typeof window === 'undefined') return;
    try {
      window.localStorage?.setItem('use_location_focus', value ? '1' : '0');
      window.dispatchEvent(new Event('use_location_focus_changed'));
      if (!value) {
        // Clear cached IP focus so disabling takes immediate effect on next login
        window.sessionStorage?.removeItem('ip_location_focused');
        // Forget the GPS grant too, so turning it back on asks again
        window.localStorage?.removeItem('geolocation_granted');
      }
    } catch {
      // ignore storage errors (private mode, quota, etc.)
    }
  };

  // Sync the toggle across tabs/windows via the storage event
  useEffect(() => {
    if (typeof window === 'undefined') return;
    let ls: Storage | null = null;
    try {
      ls = window.localStorage ?? null;
    } catch {
      ls = null;
    }
    if (!ls) return;

    const handleStorage = (e: StorageEvent) => {
      if (!e || e.key !== 'use_location_focus') return;
      // storageArea may be missing in some environments — only compare when present
      if (e.storageArea && e.storageArea !== ls) return;
      // newValue is null when the key is cleared; treat that as the default (true)
      const next = e.newValue == null ? true : e.newValue !== '0';
      setUseLocation((prev) => (prev === next ? prev : next));
      if (!next) {
        try {
          window.sessionStorage?.removeItem('ip_location_focused');
        } catch {
          // ignore
        }
      }
    };
    window.addEventListener('storage', handleStorage);
    return () => window.removeEventListener('storage', handleStorage);
  }, []);

  // Check if account has a scheduled deletion
  useEffect(() => {
    const checkDeletionStatus = async () => {
      if (!user?.uid) return;
      // RLS checks id = auth.uid(); user.uid can be the Pi ID or stale.
      const userId = await getSessionUserId();
      if (!userId) return;
      const { data, error } = await supabase
        .from('users')
        .select('scheduled_deletion_at')
        .eq('id', userId)
        .single();

      if (!error && data?.scheduled_deletion_at) {
        setIsAccountDeleted(true);
        setDeletionDate(data.scheduled_deletion_at);
      } else {
        setIsAccountDeleted(false);
        setDeletionDate(null);
      }
    };
    checkDeletionStatus();
  }, [user?.uid]);

  // Only refresh user data on first render if stale
  useEffect(() => {
    const lastUserRefresh = localStorage.getItem('last_user_refresh');
    const refreshThreshold = 30 * 60 * 1000;
    const shouldRefresh = !lastUserRefresh || Date.now() - parseInt(lastUserRefresh, 10) > refreshThreshold;

    if (user && shouldRefresh && !isLoading) {
      refreshUserData(true);
      localStorage.setItem('last_user_refresh', Date.now().toString());
    }
  }, []);

  useEffect(() => {
    if (isDarkMode) {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [isDarkMode]);

  useEffect(() => {
    if (colorScheme === 'system') {
      const mediaQuery = window.matchMedia('(prefers-color-scheme: dark)');
      const handleChange = (e: MediaQueryListEvent) => {
        setIsDarkMode(e.matches);
      };
      mediaQuery.addEventListener('change', handleChange);
      return () => {
        mediaQuery.removeEventListener('change', handleChange);
      };
    }
    return undefined;
  }, [colorScheme]);

  const handleColorSchemeChange = (scheme: 'system' | 'light' | 'dark') => {
    setColorScheme(scheme);
    localStorage.setItem('colorScheme', scheme);
    if (scheme === 'dark') {
      setIsDarkMode(true);
    } else if (scheme === 'light') {
      setIsDarkMode(false);
    } else {
      const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
      setIsDarkMode(prefersDark);
    }
  };

  const handleDeleteAccount = async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        toast.error('You must be logged in to delete your account.');
        return;
      }

      const { data, error } = await supabase.functions.invoke('delete-account', {
        body: { action: 'schedule' },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;

      setIsAccountDeleted(true);
      setDeletionDate(data.scheduled_deletion_at);
      // Clean up old localStorage flag
      localStorage.removeItem('accountDeleted');
      toast.error('Account scheduled for deletion', {
        description: 'Your account will be permanently deleted after 15 days. You can reinstate it before then.',
      });
    } catch (err) {
      console.error('Error scheduling deletion:', err);
      toast.error('Failed to schedule account deletion. Please try again.');
    }
  };

  const handleReinstateAccount = async () => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const token = sessionData?.session?.access_token;
      if (!token) {
        toast.error('You must be logged in to reinstate your account.');
        return;
      }

      const { error } = await supabase.functions.invoke('delete-account', {
        body: { action: 'reinstate' },
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (error) throw error;

      setIsAccountDeleted(false);
      setDeletionDate(null);
      localStorage.removeItem('accountDeleted');
      toast.success('Account has been reinstated', {
        description: 'Your account has been successfully reactivated.',
      });
    } catch (err) {
      console.error('Error reinstating account:', err);
      toast.error('Failed to reinstate account. Please try again.');
    }
  };

  return (
    <AppLayout title="" fullWidth={true} className="overflow-x-hidden">
      <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 py-4 sm:py-6 overflow-hidden">
        <div>
          <p className="text-sm sm:text-base text-muted-foreground mt-1 sm:mt-2">Manage your account preferences.</p>
        </div>

        <Accordion 
          type="single" 
          value={activeSection} 
          onValueChange={setActiveSection}
          collapsible 
          className="mt-4 sm:mt-6 space-y-4 overflow-hidden"
        >
          <AccordionItem value="profile" className="border rounded-lg overflow-hidden">
            <AccordionTrigger className="px-4 sm:px-6 py-3 hover:no-underline hover:bg-muted/50">
              <div className="flex items-start gap-3 text-left">
                <User className="h-5 w-5 mt-0.5 flex-shrink-0 text-primary" />
                <div className="flex flex-col items-start">
                  <span className="font-semibold text-base sm:text-lg">Profile</span>
                  <span className="text-xs sm:text-sm text-muted-foreground">Your personal information</span>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 sm:px-6 pt-2 pb-4">
              <ProfileSettings 
                isMobile={isMobile} 
                user={user} 
                isLoading={isLoading} 
              />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="preferences" className="border rounded-lg overflow-hidden">
            <AccordionTrigger className="px-4 sm:px-6 py-3 hover:no-underline hover:bg-muted/50">
              <div className="flex items-start gap-3 text-left">
                <SettingsIcon className="h-5 w-5 mt-0.5 flex-shrink-0 text-primary" />
                <div className="flex flex-col items-start">
                  <span className="font-semibold text-base sm:text-lg">Appearance</span>
                  <span className="text-xs sm:text-sm text-muted-foreground">Theme and display settings</span>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 sm:px-6 pt-2 pb-4">
              <AppPreferences 
                colorScheme={colorScheme} 
                onColorSchemeChange={handleColorSchemeChange} 
                useLocation={useLocation}
                onUseLocationChange={handleUseLocationChange}
              />
            </AccordionContent>
          </AccordionItem>

          <AccordionItem value="legal" className="border rounded-lg overflow-hidden">
            <AccordionTrigger className="px-4 sm:px-6 py-3 hover:no-underline hover:bg-muted/50">
              <div className="flex items-start gap-3 text-left">
                <Scale className="h-5 w-5 mt-0.5 flex-shrink-0 text-primary" />
                <div className="flex flex-col items-start">
                  <span className="font-semibold text-base sm:text-lg">Legal and help</span>
                  <span className="text-xs sm:text-sm text-muted-foreground">Policies, and how to reach us</span>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 sm:px-6 pt-2 pb-4">
              <div className="space-y-1">
                <Link
                  to="/terms"
                  className="flex items-center gap-3 px-3 py-3 rounded-md hover:bg-muted transition-colors text-sm"
                >
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">Terms of Service</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
                <Link
                  to="/privacy"
                  className="flex items-center gap-3 px-3 py-3 rounded-md hover:bg-muted transition-colors text-sm"
                >
                  <Shield className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">Privacy Policy</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
                <Link
                  to="/cookies"
                  className="flex items-center gap-3 px-3 py-3 rounded-md hover:bg-muted transition-colors text-sm"
                >
                  <Cookie className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">Cookie Policy</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
                <Link
                  to="/contact"
                  className="flex items-center gap-3 px-3 py-3 rounded-md hover:bg-muted transition-colors text-sm"
                >
                  <Mail className="h-4 w-4 text-muted-foreground" />
                  <span className="flex-1">Contact us</span>
                  <ChevronRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </div>
            </AccordionContent>
          </AccordionItem>

          <div className="mt-6 pt-6 border-t border-border/60">
            <p className="text-xs text-muted-foreground mb-3">Irreversible actions</p>
          </div>

          <AccordionItem value="danger" className="border rounded-lg overflow-hidden border-destructive/20">
            <AccordionTrigger className="px-4 sm:px-6 py-3 hover:no-underline hover:bg-muted/50">
              <div className="flex items-start gap-3 text-left">
                <AlertTriangle className="h-5 w-5 mt-0.5 flex-shrink-0 text-destructive" />
                <div className="flex flex-col items-start">
                  <span className="font-semibold text-base sm:text-lg text-destructive">Danger Zone</span>
                  <span className="text-xs sm:text-sm text-muted-foreground">Account deletion and recovery</span>
                </div>
              </div>
            </AccordionTrigger>
            <AccordionContent className="px-4 sm:px-6 pt-2 pb-4">
              <DangerZone 
                onDeleteAccount={handleDeleteAccount} 
                onReinstateAccount={handleReinstateAccount} 
                isAccountDeleted={isAccountDeleted}
                deletionDate={deletionDate}
              />
            </AccordionContent>
          </AccordionItem>

        </Accordion>
      </div>
    </AppLayout>
  );
};

export default Settings;
