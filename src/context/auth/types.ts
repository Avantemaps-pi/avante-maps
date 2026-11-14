
import { SubscriptionTier } from '@/utils/piNetwork';

export interface PiUser {
  uid: string;                      // Supabase UUID (for auth.uid())
  pi_uid?: string;                  // Pi Network UID (optional for backwards compatibility)
  username: string;
  walletAddress?: string;
  roles?: string[];
  accessToken?: string; // Optional for security - not stored client-side
  lastAuthenticated: number;
  subscriptionTier: SubscriptionTier;
  businessCount?: number;
}

export interface AuthContextType {
  user: PiUser | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  isOffline: boolean;
  appReady: boolean;
  login: () => Promise<void>;
  loginAsSandbox: () => void;
  /** automatic: not asked for by the user (session expired); stays on a page that works signed out */
  logout: (options?: { automatic?: boolean }) => Promise<void>;
  /** True from a logout's start until sign-out finishes */
  isLoggingOut: boolean;
  authError: string | null;
  clearAuthError: () => void;
  cancelLogin: () => void;
  hasAccess: (requiredTier: SubscriptionTier) => boolean;
  refreshUserData: (silent?: boolean) => Promise<void>;
  setUser: (user: PiUser | null) => void;
  isAdmin: boolean;
}


// Session expires after 24 hours of inactivity
// Note: useSessionRestoration uses a 15-minute threshold for silent refresh
// when browser is closed, but the session itself remains valid for 24 hours
export const SESSION_TIMEOUT = 24 * 60 * 60 * 1000; // 24 hours in milliseconds
export const STORAGE_KEY = 'avante_maps_auth';
