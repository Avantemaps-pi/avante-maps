/**
 * Pi Network – helpers
 * Clean, safe utilities used by core.ts
 */

import { initPiInstanceIfNeeded } from './core';

declare global {
  interface Window {
    Pi?: any;
    __piInitialized?: boolean;
  }
}

/**
 * Detects Pi Browser reliably.
 */
export const isPiBrowser = (): boolean => {
  try {
    if (typeof navigator === "undefined") return false;

    const ua = navigator.userAgent.toLowerCase();
    const uaDetected =
      ua.includes("pibrowser") ||
      ua.includes("pi browser") ||
      ua.includes("minepi");

    if (uaDetected) return true;

    // Fallback: in production custom domains, treat a loaded Pi SDK as Pi Browser
    // This avoids blocking real users when UA strings change
    if (typeof window !== "undefined") {
      const hasPiSdk = typeof (window as any).Pi !== "undefined";

      // Pi SDK only loads inside Pi Browser, so its presence is reliable
      if (hasPiSdk) {
        return true;
      }
    }

    return false;
  } catch {
    return false;
  }
};


/**
 * Returns basic browser diagnostics.
 */
export const getBrowserInfo = () => {
  try {
    const ua = typeof navigator !== "undefined" ? navigator.userAgent : "";

    return {
      userAgent: ua,
      isPiBrowser: isPiBrowser(),
      platform:
        typeof navigator !== "undefined" ? navigator.platform : "unknown",
      vendor: typeof navigator !== "undefined" ? navigator.vendor : "unknown",
    };
  } catch {
    return {
      userAgent: "",
      isPiBrowser: false,
      platform: "unknown",
      vendor: "unknown",
    };
  }
};

/**
 * Determines if the Pi SDK is really available and initialized.
 */
export const isPiNetworkAvailable = (): boolean => {
  try {
    if (typeof window === "undefined") return false;

    // Allow test mode in preview/dev environments
    const host = window.location?.hostname || '';
    const isPreviewOrDev = 
      host === 'localhost' || 
      host === '127.0.0.1' || 
      host.includes('lovableproject.com') ||
      host.includes('preview');
    
    if (isPreviewOrDev) return true;

    const pi = (window as any).Pi;
    if (!pi) return false;

    const hasAuthMethod = typeof pi.authenticate === "function";
    // The current window.Pi must be initialised (a reloaded SDK replaces it with a new,
    // uninitialised object). Login calls Pi.authenticate() right after this check, so init it now
    const isInit = initPiInstanceIfNeeded();

    return hasAuthMethod && isInit;
  } catch {
    return false;
  }
};

/**
 * Session expiration util (used by auth logic in core.ts)
 */
export const isSessionExpired = (
  lastAuthenticated: number,
  timeout: number
): boolean => {
  try {
    return Date.now() - lastAuthenticated > timeout;
  } catch {
    return true;
  }
};
