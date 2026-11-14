import React, { useState, useEffect, useRef, useCallback } from 'react';
import { toast } from 'sonner';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@/lib/router-compat';
import { supabase } from '@/integrations/supabase/client';
import { initializePiNetwork, getPiAuthResult } from '@/utils/piNetwork/core';
import { PiUser, AuthContextType, STORAGE_KEY } from './types';

// Sandbox-only mock-session flag. When present in localStorage, the auth provider
// will skip Supabase session checks and treat the cached PiUser as authenticated.
// Strictly intended for the Lovable sandbox/dev environment.
const SANDBOX_MOCK_KEY = 'avante_sandbox_mock_session';
const isSandboxHost = (): boolean => {
  if (typeof window === 'undefined') return false;
  const host = window.location.hostname;
  return (
    host.includes('lovableproject.com') ||
    host.includes('id-preview') ||
    host === 'localhost' ||
    host === '127.0.0.1'
  );
};
const hasSandboxMock = (): boolean => {
  try {
    return typeof localStorage !== 'undefined' && !!localStorage.getItem(SANDBOX_MOCK_KEY);
  } catch {
    return false;
  }
};

// Pages that work signed out: an automatic logout (session expired) leaves the user on them
const SIGNED_OUT_PAGES = [
  '/',
  '/privacy',
  '/terms',
  '/cookies',
  '/contact',
  '/about',
];
const worksSignedOut = (pathname: string): boolean => {
  const path = pathname.replace(/\/+$/, '') || '/';
  return SIGNED_OUT_PAGES.includes(path) || path.startsWith('/business/');
};

// Kept on the device but private to the user who was signed in
const USER_CACHE_KEYS = ['bookmark-ids', 'bookmark-places'];
import { checkAccess } from './authUtils';
import { performLogin, refreshUserData as refreshUserDataService, requestAuthPermissions } from './authService';
import { useNetworkStatus } from './networkStatusService';
import { SubscriptionTier } from '@/utils/piNetwork/types';
import { shouldBypassAuth, DEV_CONFIG } from '@/config/environment';
import AuthContext from './useAuth';
import { secureLog } from '@/utils/secureLogger';
import { whenAppHydrated } from '@/utils/hydrationSignal';
import { verifyPiAuthentication } from '@/utils/piNetwork/verification';

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<PiUser | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(false);
  const [authError, setAuthError] = useState<string | null>(null);
  const [isSdkInitialized, setIsSdkInitialized] = useState<boolean>(false);
  const [lastRefresh, setLastRefresh] = useState<number>(0);
  const [appReady, setAppReady] = useState<boolean>(true);
  const [isLoggingOut, setIsLoggingOut] = useState<boolean>(false);
  const queryClient = useQueryClient();
  const navigate = useNavigate();

  const pendingAuthRef = useRef<boolean>(false);
  const logoutRef = useRef<Promise<void> | null>(null);
  // Counts logouts, so work started before one (a background refresh) doesn't sign the old user back in
  const logoutCountRef = useRef<number>(0);
  const initAttempted = useRef<boolean>(false);
  const authTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const devModeToastShown = useRef<boolean>(false);
  const isMountedRef = useRef<boolean>(true);

  // safe setters
  const safeSetUser = useCallback((u: PiUser | null) => {
    if (isMountedRef.current) setUser(u);
  }, []);

  const safeSetIsLoading = useCallback((loading: boolean) => {
    if (isMountedRef.current) setIsLoading(loading);
  }, []);

  const safeSetAuthError = useCallback((error: string | null) => {
    if (isMountedRef.current) setAuthError(error);
  }, []);

  const safeSetIsSdkInitialized = useCallback((initialized: boolean) => {
    if (isMountedRef.current) setIsSdkInitialized(initialized);
  }, []);

  const safeSetAppReady = useCallback((ready: boolean) => {
    if (isMountedRef.current) setAppReady(ready);
  }, []);

  /**
   * Helper to check if an error is a refresh token corruption error
   */
  const isRefreshTokenError = useCallback((error: any): boolean => {
    const message = error?.message?.toLowerCase() || '';
    return (
      message.includes('illegal base64') ||
      message.includes('refresh_token') ||
      message.includes('invalid refresh token') ||
      message.includes('token is expired') ||
      message.includes('invalid jwt')
    );
  }, []);

  /**
   * Clear all auth-related storage to recover from corrupted sessions
   */
  const clearAllAuthStorage = useCallback(() => {
    localStorage.removeItem(STORAGE_KEY);
    const keysToRemove = Object.keys(localStorage).filter(key => 
      key.startsWith('sb-') || key.includes('supabase')
    );
    keysToRemove.forEach(key => localStorage.removeItem(key));
    
    // Clear session storage too
    const sessionKeysToRemove = Object.keys(sessionStorage).filter(key =>
      key.startsWith('sb-') || key.includes('supabase')
    );
    sessionKeysToRemove.forEach(key => sessionStorage.removeItem(key));
  }, []);

  // Lifecycle management and minimal startup cleanup
  useEffect(() => {
    isMountedRef.current = true;

    // Light startup check - just verify local session exists
    // Heavy error detection is now handled by SessionManager via useSupabaseSession
    const checkSession = async () => {
      try {
        if (hasSandboxMock()) return; // Sandbox mock: skip real session check
        const { data: { session }, error } = await supabase.auth.getSession();
        
        if (error) {
          const errorMsg = error.message?.toLowerCase() || '';
          // Only handle critical errors that prevent any session usage
          if (
            errorMsg.includes('illegal base64') ||
            errorMsg.includes('refresh_token') ||
            errorMsg.includes('invalid refresh token') ||
            errorMsg.includes('refresh token not found')
          ) {
            secureLog.warn('Startup: corrupted session detected, clearing...');
            clearAllAuthStorage();
            try { await supabase.auth.signOut(); } catch { /* ignore */ }
          }
          return;
        }

        // If no session exists but we have cached user, clear it
        if (!session) {
          const cachedUser = localStorage.getItem(STORAGE_KEY);
          if (cachedUser) {
            secureLog.info('Startup: no Supabase session but cached user exists, clearing cache');
            localStorage.removeItem(STORAGE_KEY);
          }
        }
      } catch (e) {
        secureLog.error('Startup session check failed:', e);
      }
    };

    checkSession();

    return () => {
      isMountedRef.current = false;
      if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
    };
  }, [clearAllAuthStorage]);

  // global error handlers (unchanged)
  useEffect(() => {
    let reloadTimeout: ReturnType<typeof setTimeout> | null = null;

    const handleError = (event: ErrorEvent) => {
      const message = event?.error?.message || event?.message || 'An unexpected error occurred.';
      console.error('🌍 Global error caught:', event.error || event.message);
      toast.error(`App error: ${message}`, { duration: 6000, description: 'Trying to recover...' });

      if (!reloadTimeout && !document.hidden) {
        reloadTimeout = setTimeout(() => {
          console.warn('🔁 Reloading app to recover...');
          window.location.reload();
        }, 5000);
      }
    };

    const handleRejection = (event: PromiseRejectionEvent) => {
      const reason = event?.reason?.message || event?.reason || 'An unknown issue occurred.';
      console.error('🚨 Unhandled promise rejection:', event.reason);
      toast.error(`Unexpected issue: ${reason}`, { duration: 6000, description: 'Attempting to recover...' });

      if (!reloadTimeout && !document.hidden) {
        reloadTimeout = setTimeout(() => {
          console.warn('🔁 Reloading app to recover...');
          window.location.reload();
        }, 5000);
      }
    };

    window.addEventListener('error', handleError);
    window.addEventListener('unhandledrejection', handleRejection);
    return () => {
      window.removeEventListener('error', handleError);
      window.removeEventListener('unhandledrejection', handleRejection);
      if (reloadTimeout) clearTimeout(reloadTimeout);
    };
  }, []);

  const REFRESH_COOLDOWN = 15 * 60 * 1000;
  const AUTH_TIMEOUT = 120 * 1000;

  // --- Token verification (fixed: return false when no token unless bypass) ---
  const isTokenValid = async (accessToken?: string): Promise<boolean> => {
    try {
      if (shouldBypassAuth()) return true;

      const token = accessToken || getPiAuthResult()?.accessToken;
      // if there is no token, treat as invalid (force re-auth)
      if (!token) return false;

      const result = await verifyPiAuthentication(token, user?.uid ?? '', user?.username ?? '');
      return !!result.verified;
    } catch (error) {
      console.error('Token validation error:', error);
      return false;
    }
  };

  // --- Cached session restoration & dev bypass handling (kept local-only for previews) ---
  // Deferred until the route subtree has hydrated (whenAppHydrated): restoring
  // the cached user earlier changes SSR-visible DOM (e.g. sidebar login/logout)
  // while part of the tree is still dehydrated → "Hydration failed" errors.
  useEffect(() => {
    const runBypass = () => {
      secureLog.info('Development mode: bypassing authentication');
      const mockUser = { ...DEV_CONFIG!.mockUser!, lastAuthenticated: Date.now() };
      safeSetUser(mockUser);
      secureLog.info('Preview bypass uses local mock auth only; verify-pi-auth still requires real Pi tokens.');

      import('./authUtils').then(({ updateUserData }) => {
        updateUserData(mockUser, safeSetUser).catch(err =>
          secureLog.warn('Failed to create dev user in database:', err)
        );
      });
    };

    const restoreSession = async () => {
      const cachedSession = localStorage.getItem(STORAGE_KEY);
      if (!cachedSession) return;

      // Sandbox mock: restore cached PiUser without requiring a real Supabase session
      if (hasSandboxMock()) {
        try {
          const userData = JSON.parse(cachedSession) as PiUser;
          secureLog.info('Restoring sandbox mock user from cache');
          safeSetUser(userData);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
          localStorage.removeItem(SANDBOX_MOCK_KEY);
        }
        return;
      }

      // If Supabase session is missing, don't restore the app user from cache.
      // This prevents "logged-in UI" + "stale/invalid Supabase tokens" loops.
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        secureLog.info('No Supabase session found; clearing cached user session');
        localStorage.removeItem(STORAGE_KEY);
        return;
      }


      try {
        const userData = JSON.parse(cachedSession) as PiUser;
        if (session.user.id !== userData.uid) {
          secureLog.warn(`Session uid mismatch during restore: ${session.user.id} !== ${userData.uid}`);
          localStorage.removeItem(STORAGE_KEY);
          return;
        }
        if (Date.now() - userData.lastAuthenticated < 24 * 60 * 60 * 1000) {
          secureLog.info('Restoring user from cached session');
          // Sliding 24h window: opening the app counts as activity, so only people away
          // for more than 24h have to sign in again.
          const refreshedUser: PiUser = { ...userData, lastAuthenticated: Date.now() };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(refreshedUser));
          safeSetUser(refreshedUser);
        } else {
          secureLog.info('Cached session expired');
          localStorage.removeItem(STORAGE_KEY);
        }
      } catch (error) {
        secureLog.error('Error parsing cached session:', error);
        localStorage.removeItem(STORAGE_KEY);
      }
    };

    // Wait for the route subtree to hydrate before mutating auth state
    // (whenAppHydrated fires immediately if hydration already completed,
    // and has a built-in safety timeout so restore can never be lost).
    const cancel = whenAppHydrated(() => {
      if (shouldBypassAuth() && DEV_CONFIG?.mockUser) {
        runBypass();
        return;
      }
      restoreSession().catch((err) => secureLog.warn('Failed to restore cached session:', err));
    });
    return cancel;
  }, [safeSetUser]);

  // Sliding 24h window: a Supabase token refresh for the same user also counts as activity.
  // Synchronous callback (no awaits inside onAuthStateChange).
  useEffect(() => {
    const { data: { subscription } } = supabase.auth.onAuthStateChange((event, session) => {
      if (event !== 'TOKEN_REFRESHED' || !session?.user?.id) return;
      try {
        const cached = localStorage.getItem(STORAGE_KEY);
        if (!cached) return;
        const userData = JSON.parse(cached) as PiUser;
        if (userData.uid !== session.user.id) return;
        const lastAuthenticated = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify({ ...userData, lastAuthenticated }));
        if (isMountedRef.current) {
          setUser((prev) => (prev && prev.uid === session.user.id ? { ...prev, lastAuthenticated } : prev));
        }
      } catch {
        // Unreadable cache: leave it to restoreSession.
      }
    });
    return () => subscription.unsubscribe();
  }, []);

  // --- Robust SDK initialization helper (retries + timeout) ---
  const ensureSdkInitialized = useCallback(async (maxAttempts = 3, delayMs = 700): Promise<boolean> => {
    if (isSdkInitialized) return true;
    // prevent parallel inits
    if (initAttempted.current && !isSdkInitialized) {
      // If initAttempted but isn't initialized yet, still try a few times:
      // fall through to attempts
    }
    initAttempted.current = true;

    let attempt = 0;
    while (attempt < maxAttempts) {
      attempt++;
      try {
        secureLog.info(`Attempting Pi SDK init (attempt ${attempt})...`);
        const result = await initializePiNetwork();
        safeSetIsSdkInitialized(!!result);
        if (result) {
          secureLog.info('Pi SDK initialized successfully');
          return true;
        }
        secureLog.warn('initializePiNetwork returned falsy result, retrying...');
      } catch (err) {
        secureLog.error('initializePiNetwork threw:', err);
      }
      // delay before next attempt
      await new Promise((res) => setTimeout(res, delayMs));
    }
    secureLog.error('Pi SDK failed to initialize after attempts');
    safeSetIsSdkInitialized(false);
    return false;
  }, [isSdkInitialized, safeSetIsSdkInitialized]);

  // initialize once on mount (best-effort)
  useEffect(() => {
    (async () => {
      await ensureSdkInitialized(3, 700);
    })();
  }, [ensureSdkInitialized]);

  // --- Login flow (fixed cleanup + ensure SDK ready) ---
  const login = useCallback(async (): Promise<void> => {
    if (shouldBypassAuth() && DEV_CONFIG?.mockUser) {
      const mockUser = { ...DEV_CONFIG.mockUser, lastAuthenticated: Date.now() };
      safeSetUser(mockUser);
      secureLog.info('Development mode: logged in with local mock user without calling verify-pi-auth.');
      if (!devModeToastShown.current) {
        toast.success('Development mode: Logged in as mock user');
        devModeToastShown.current = true;
      }
      return;
    }

    if (pendingAuthRef.current) {
      toast.info('Authentication in progress, please wait...');
      return;
    }

    pendingAuthRef.current = true;
    safeSetIsLoading(true);
    safeSetAppReady(false);

    if (authTimeoutRef.current) clearTimeout(authTimeoutRef.current);
    authTimeoutRef.current = setTimeout(() => {
      // CRITICAL: this watchdog must fully settle auth state. Leaving appReady
      // false here latches AuthenticatingOverlay on screen forever (the
      // "stuck on Preparing your map..." bug).
      toast.dismiss('auth-progress');
      safeSetIsLoading(false);
      safeSetAppReady(true);
      safeSetAuthError('Authentication timed out. Please retry.');
      toast.error('Authentication timeout. Check your connection.', { duration: 6000 });
      pendingAuthRef.current = false;
    }, AUTH_TIMEOUT);

    try {
      // ensure the SDK is initialized before proceeding
      const sdkReady = await ensureSdkInitialized(4, 600);
      if (!sdkReady) throw new Error('SDK initialization failed');

      const permissionsGranted = await requestAuthPermissions(isSdkInitialized, safeSetIsLoading, safeSetAuthError);
      if (!permissionsGranted) {
        // Clean up properly if the user declined or permissions step failed
        secureLog.warn('Permissions not granted or were declined by user');
        if (authTimeoutRef.current) {
          clearTimeout(authTimeoutRef.current);
          authTimeoutRef.current = null;
        }
        safeSetIsLoading(false);
        pendingAuthRef.current = false;
        safeSetAppReady(true);
        return;
      }

      await performLogin(
        isSdkInitialized,
        safeSetIsLoading,
        safeSetAuthError,
        (pending) => { pendingAuthRef.current = pending; },
        safeSetUser
      );

      setLastRefresh(Date.now());
      safeSetAppReady(true);
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : 'Authentication failed.';
      secureLog.error('Login failed:', error);
      safeSetAuthError(message);
      toast.dismiss('auth-progress');
      toast.error(message);
    } finally {
      if (authTimeoutRef.current) {
        clearTimeout(authTimeoutRef.current);
        authTimeoutRef.current = null;
      }
      // Every exit path must settle auth state — a non-ready app with no
      // pending login keeps the full-screen overlay mounted with no escape.
      safeSetIsLoading(false);
      safeSetAppReady(true);
      pendingAuthRef.current = false;
    }
  }, [ensureSdkInitialized, isSdkInitialized, safeSetIsLoading, safeSetAuthError, safeSetUser, safeSetAppReady]);

  const clearAuthError = useCallback(() => {
    safeSetAuthError(null);
  }, [safeSetAuthError]);

  /** User-initiated escape from a hung Pi handshake. */
  const cancelLogin = useCallback(() => {
    if (authTimeoutRef.current) {
      clearTimeout(authTimeoutRef.current);
      authTimeoutRef.current = null;
    }
    toast.dismiss('auth-progress');
    pendingAuthRef.current = false;
    safeSetIsLoading(false);
    safeSetAppReady(true);
    safeSetAuthError(null);
    secureLog.info('Login cancelled by user while waiting for Pi Browser approval');
  }, [safeSetAuthError, safeSetAppReady, safeSetIsLoading]);


  // offline handler
  const isOffline = useNetworkStatus(pendingAuthRef, login);

  // refresh user data
  // When silent=true, we don't show loading indicator (for background refreshes)
  const refreshUserData = useCallback(async (force = false, silent = false): Promise<void> => {
    const now = Date.now();
    if (!force && now - lastRefresh < REFRESH_COOLDOWN) return;
    const logoutsAtStart = logoutCountRef.current;
    const loggedOutSince = () => logoutCountRef.current !== logoutsAtStart;

    if (!isSdkInitialized) {
      const ok = await ensureSdkInitialized(3, 600);
      if (!ok) {
        secureLog.error('Failed to init SDK during refresh: aborting refresh');
        return;
      }
    }

    if (!user) {
      secureLog.info('No user to refresh');
      return;
    }

    // On reload/refresh, if we have a valid Supabase session, just refresh user data
    // without re-triggering Pi.authenticate(). The Pi access token is intentionally
    // NOT stored client-side, so we can't re-validate it — but the Supabase session
    // is the authoritative session indicator.
    const { data: { session } } = await supabase.auth.getSession();
    if (!session) {
      secureLog.warn('No active Supabase session during refresh — user needs to re-login');
      return;
    }

    // Only show loading for user-initiated refreshes, not background ones
    if (!silent) {
      safeSetIsLoading(true);
    }
    try {
      const setIfStillSignedIn = (u: PiUser) => {
        if (!loggedOutSince()) safeSetUser(u);
      };
      await refreshUserDataService(user, setIfStillSignedIn, silent ? () => {} : safeSetIsLoading, silent);
      if (loggedOutSince()) {
        // The refresh saved the old user again after the logout cleared it
        try {
          const saved = localStorage.getItem(STORAGE_KEY);
          if (saved && (JSON.parse(saved) as PiUser).uid === user.uid) localStorage.removeItem(STORAGE_KEY);
        } catch {
          localStorage.removeItem(STORAGE_KEY);
        }
        return;
      }
      secureLog.info('User data refreshed');
      setLastRefresh(now);
    } catch (error) {
      secureLog.error('Failed to refresh user data:', error);
    } finally {
      if (!silent) {
        safeSetIsLoading(false);
      }
    }
  }, [user, isSdkInitialized, lastRefresh, ensureSdkInitialized]);

  // silent refresh when appropriate (doesn't show loading indicator)
  useEffect(() => {
    if (user && !isOffline && isSdkInitialized) {
      const timer = setTimeout(() => refreshUserData(false, true), 1000); // silent=true
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [user, isOffline, isSdkInitialized, refreshUserData]);

  // logout - properly clear Supabase session and all storage, then go to the
  // signed-out start screen. An automatic logout leaves the user on a page that
  // works signed out. A second call while one runs gets the same promise.
  const logout = useCallback(
    (options: { automatic?: boolean } = {}): Promise<void> => {
      if (logoutRef.current) return logoutRef.current;

      const run = async () => {
        logoutCountRef.current += 1;
        if (isMountedRef.current) setIsLoggingOut(true);
        try {
          // Clear Supabase session first
          await supabase.auth.signOut();
          secureLog.info('Supabase session cleared');
        } catch (error) {
          secureLog.error('Error signing out from Supabase:', error);
        }

        // Clear local storage
        localStorage.removeItem(STORAGE_KEY);
        localStorage.removeItem(SANDBOX_MOCK_KEY);
        USER_CACHE_KEYS.forEach((key) => localStorage.removeItem(key));

        // Clear any Supabase auth storage keys
        const keysToRemove = Object.keys(localStorage).filter(
          (key) => key.startsWith('sb-') || key.includes('supabase'),
        );
        keysToRemove.forEach((key) => localStorage.removeItem(key));

        safeSetUser(null);
        // Nothing from this session (notifications, wallet, messages, bookmarks) is shown again or
        // reused if someone else signs in on this device
        queryClient.clear();

        if (!options.automatic || !worksSignedOut(window.location.pathname)) {
          navigate('/', { replace: true });
        }
        toast.info("You've been logged out", { id: 'logged-out' });
      };

      logoutRef.current = run().finally(() => {
        logoutRef.current = null;
        if (isMountedRef.current) setIsLoggingOut(false);
      });
      return logoutRef.current;
    },
    [safeSetUser, queryClient, navigate],
  );

  // Sandbox-only simulated session. No Supabase auth call is made — the app is
  // treated as authenticated locally so UI/flows that don't depend on RLS can
  // be exercised from the Lovable sandbox. RLS-protected requests will still
  // fail because there is no real auth.uid().
  const loginAsSandbox = useCallback((): void => {
    if (!isSandboxHost()) {
      toast.error('Sandbox login is disabled in production.');
      secureLog.warn('Blocked loginAsSandbox: not a sandbox host');
      return;
    }
    const base = DEV_CONFIG?.mockUser ?? {
      uid: '00000000-0000-0000-0000-000000000001',
      pi_uid: 'sandbox-mock-pi-uid',
      username: 'SandboxUser',
      walletAddress: 'sandbox-mock-wallet',
      roles: ['user'],
      accessToken: 'sandbox-mock-token',
      lastAuthenticated: Date.now(),
      subscriptionTier: SubscriptionTier.ORGANIZATION,
      businessCount: 0,
    };
    const mockUser: PiUser = { ...base, lastAuthenticated: Date.now() };
    try {
      localStorage.setItem(SANDBOX_MOCK_KEY, '1');
      localStorage.setItem(STORAGE_KEY, JSON.stringify(mockUser));
    } catch (e) {
      secureLog.warn('Failed to persist sandbox mock session', e);
    }
    safeSetUser(mockUser);
    secureLog.info('Sandbox mock session activated', { uid: mockUser.uid, username: mockUser.username });
    toast.success('Sandbox session active (mock user, no real auth).');
  }, [safeSetUser]);

  // access helpers
  const hasAccess = useCallback(
    (requiredTier: SubscriptionTier): boolean => user ? checkAccess(user.subscriptionTier, requiredTier) : false,
    [user]
  );

  const isAdmin = user?.roles?.includes('admin') ?? false;

  // runtime session monitor - check Supabase session validity periodically
  // Does NOT re-trigger Pi.authenticate(); just verifies the session is still active.
  // Skipped for sandbox mock sessions which have no Supabase session by design.
  useEffect(() => {
    if (!user) return;
    if (hasSandboxMock()) return;
    const interval = setInterval(async () => {
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        secureLog.warn('Supabase session expired, logging out');
        logout({ automatic: true });
        return;
      }
      if (session.user.id !== user.uid) {
        secureLog.warn(`Session uid mismatch in monitor: ${session.user.id} !== ${user.uid}`);
        logout({ automatic: true });
      }
    }, 10 * 60 * 1000);
    return () => clearInterval(interval);
  }, [user, logout]);


  // app-ready event
  useEffect(() => {
    const handleAppReady = () => safeSetAppReady(true);
    window.addEventListener('app-ready', handleAppReady);
    return () => window.removeEventListener('app-ready', handleAppReady);
  }, [safeSetAppReady]);

  return (
    <AuthContext.Provider
      value={{
        user,
        isAuthenticated: !!user,
        isLoading,
        isOffline,
        appReady,
        login,
        loginAsSandbox,
        logout,
        isLoggingOut,
        authError,
        clearAuthError,
        cancelLogin,
        hasAccess,
        refreshUserData: (silent = false) => refreshUserData(true, silent),
        setUser: safeSetUser,
        isAdmin,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export default AuthProvider;
