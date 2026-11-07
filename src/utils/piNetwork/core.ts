/**
 * Pi Network SDK Core - Clean, Modern Implementation
 * ~180 lines | TypeScript | Production-ready
 */

import type { AuthResult, PaymentDTO, PaymentCallbacks, PaymentData, Scope } from './types';
import { isPiBrowserUserAgent, shouldUsePiSandbox } from '@/config/environment';

// ─────────────────────────────────────────────────────────────────────────────
// State Machine
// ─────────────────────────────────────────────────────────────────────────────
let sdkLoaded = false;
let initInFlight: Promise<boolean> | null = null;
let sandboxMode = false;
let cachedAuth: AuthResult | null = null;
let incompletePaymentHandler: ((payment: PaymentDTO) => void) | null = null;

const AUTH_STORAGE_KEY = 'pi_auth_result';
const SDK_URL = 'https://sdk.minepi.com/pi-sdk.js';

// Use existing global Pi declaration from global.d.ts

// ─────────────────────────────────────────────────────────────────────────────
// Pi SDK Script Loader
// ─────────────────────────────────────────────────────────────────────────────
const loadPiSdk = (): Promise<void> => {
  return new Promise((resolve, reject) => {
    // Early exit if already loaded
    if (window.Pi) {
      resolve();
      return;
    }

    // Already in the document (the head tag, or an earlier call): wait for it, never add a second
    if (document.querySelector('script[src*="sdk.minepi.com/pi-sdk.js"]')) {
      const checkInterval = setInterval(() => {
        if (window.Pi) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);
      setTimeout(() => {
        clearInterval(checkInterval);
        reject(new Error('SDK load timeout'));
      }, 10000);
      return;
    }

    // Inject script
    const script = document.createElement('script');
    script.src = SDK_URL;
    script.async = true;
    script.onload = () => {
      if (window.Pi) resolve();
      else reject(new Error('Pi SDK loaded but window.Pi not available'));
    };
    script.onerror = () => reject(new Error('Failed to load Pi SDK script'));
    document.head.appendChild(script);
  });
};

// ─────────────────────────────────────────────────────────────────────────────
// Pi Browser Detection - ONLY use user agent, never window.Pi
// The SDK loads window.Pi in ALL browsers, making it unreliable for detection
// ─────────────────────────────────────────────────────────────────────────────
export const isPiBrowser = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return false;
  return isPiBrowserUserAgent(navigator.userAgent);
};

// Sandbox only outside the Pi Browser on non-mainnet hosts: the rule in src/config/environment.ts,
// the same one PI_INIT_SCRIPT inlines
export const determineSandboxMode = (): boolean => {
  if (typeof window === 'undefined' || typeof navigator === 'undefined') return true;
  return shouldUsePiSandbox(window.location.hostname, navigator.userAgent);
};

// ─────────────────────────────────────────────────────────────────────────────
// SDK Initialization, per SDK instance
// PI_INIT_SCRIPT (src/routes/__root.tsx) inits the SDK before the bundle loads. A reloaded
// pi-sdk.js replaces window.Pi with a new, uninitialised object, so "initialised" is a marker on
// the window.Pi object itself (__avanteInit, or window.__piInitializedInstance when the object
// can't take a property), never a page flag alone.
// ─────────────────────────────────────────────────────────────────────────────
interface PiInitWindow {
  Pi?: any;
  __piInitialized?: boolean;
  __piSandboxMode?: boolean;
  __piInitializedInstance?: unknown;
}
const piWindow = (): PiInitWindow => window as unknown as PiInitWindow;

/** Whether this SDK object has had Pi.init() from us */
export const isPiInstanceInitialized = (pi: unknown = piWindow().Pi): boolean =>
  !!pi && ((pi as { __avanteInit?: boolean }).__avanteInit === true || piWindow().__piInitializedInstance === pi);

// Pi.init() on the current window.Pi, and the marker on it. Sync, like Pi.init()
const initCurrentInstance = (force = false): boolean => {
  const w = piWindow();
  const pi = w.Pi;
  if (!pi || typeof pi.init !== 'function') return false;
  if (!force && isPiInstanceInitialized(pi)) return true;
  sandboxMode = determineSandboxMode();
  pi.init({ version: '2.0', sandbox: sandboxMode });
  try {
    Object.defineProperty(pi, '__avanteInit', { value: true, configurable: true });
  } catch {
    // A frozen object: __piInitializedInstance still says so
  }
  w.__piInitializedInstance = pi;
  w.__piInitialized = true;
  w.__piSandboxMode = sandboxMode;
  console.log(`✅ Pi SDK initialized (sandbox: ${sandboxMode}${force ? ', again after "not initialized"' : ''})`);
  return true;
};

/** Inits the current window.Pi now if it hasn't been (for checks that can't wait) */
export const initPiInstanceIfNeeded = (): boolean => {
  if (typeof window === 'undefined') return false;
  try {
    return initCurrentInstance();
  } catch (error) {
    console.warn('⚠️ Pi SDK init failed:', error instanceof Error ? error.message : error);
    return false;
  }
};

const runInitialization = async (): Promise<boolean> => {
  sandboxMode = determineSandboxMode();
  const host = window.location?.hostname || 'unknown';

  if (isPiInstanceInitialized()) {
    sdkLoaded = true;
    return true;
  }

  // Outside the Pi Browser with sandbox (desktop testing) and no SDK yet: test mode
  if (!piWindow().Pi && !isPiBrowser() && sandboxMode) {
    console.warn('⚠️ Not in Pi Browser - test mode available');
    sdkLoaded = true;
    return true;
  }

  try {
    // Waits for the head's pi-sdk.js (adds one only if there's none)
    await loadPiSdk();
    if (!initCurrentInstance()) {
      console.warn('⚠️ Pi SDK not available after loading');
      return false;
    }
    sdkLoaded = true;
    console.log(`✅ Pi SDK ready (sandbox: ${sandboxMode}, host: ${host})`);
    return true;
  } catch (error) {
    console.warn('⚠️ Pi SDK initialization failed:', error instanceof Error ? error.message : error);
    return false;
  }
};

// Checks the current window.Pi every time (it may have been replaced), and shares one run
export const initializePiNetwork = async (): Promise<boolean> => {
  if (typeof window === 'undefined') return false;
  if (isPiInstanceInitialized()) {
    sdkLoaded = true;
    return true;
  }
  initInFlight ??= runInitialization().finally(() => {
    initInFlight = null;
  });
  return initInFlight;
};

/** Call immediately before any Pi SDK call: inits the current window.Pi if it isn't */
export const ensurePiInitialized = async (): Promise<void> => {
  if (isPiInstanceInitialized()) return;
  await initializePiNetwork();
};

export const isPiNotInitializedError = (error: unknown): boolean => {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  return /not initiali[sz]ed/i.test(message);
};

/**
 * Runs an SDK call after ensurePiInitialized(). If it fails with "not initialized" (the SDK
 * object was replaced, or init didn't take), inits the current window.Pi and tries once more.
 * Not for createPayment, which has its own rule (see below).
 */
export const withPiInit = async <T>(call: () => Promise<T> | T): Promise<T> => {
  await ensurePiInitialized();
  try {
    return await call();
  } catch (error) {
    if (!isPiNotInitializedError(error)) throw error;
    console.warn('⚠️ Pi SDK said "not initialized": initializing and trying once more');
    initCurrentInstance(true);
    return await call();
  }
};

export const isSdkInitialized = (): boolean => sdkLoaded && isPiInstanceInitialized();

export const forceSdkReinitialization = async (): Promise<boolean> => {
  sdkLoaded = false;
  try {
    if (initCurrentInstance(true)) {
      sdkLoaded = true;
      return true;
    }
  } catch {
    // Falls through to the full initialization
  }
  return initializePiNetwork();
};

/** Pi.nativeFeaturesList() on an initialised SDK, retried once on "not initialized" */
export const getNativeFeaturesList = (): Promise<unknown> =>
  withPiInit(() => {
    const pi = piWindow().Pi;
    if (!pi?.nativeFeaturesList) throw new Error('Pi.nativeFeaturesList not available');
    return pi.nativeFeaturesList();
  });

// ─────────────────────────────────────────────────────────────────────────────
// Authentication Helpers
// ─────────────────────────────────────────────────────────────────────────────
export const authenticate = async (scopes: Scope[] = ['username', 'payments']): Promise<AuthResult> => {
  await ensurePiInitialized();

  const host = window.location?.hostname || 'unknown';
  console.log('🔐 Pi.authenticate() pre-check:', {
    host,
    piExists: !!window.Pi,
    instanceInitialized: isPiInstanceInitialized(),
    piSandbox: piWindow().__piSandboxMode,
  });

  if (!window.Pi) throw new Error('Pi SDK not available');
  if (!window.Pi.authenticate) throw new Error('Pi.authenticate not available');

  const result = await withPiInit(() =>
    window.Pi.authenticate(scopes, (uuid: string) => uuid),
  );
  
  const authResult: AuthResult = {
    accessToken: result.accessToken,
    user: {
      uid: result.user.uid,
      username: result.user.username,
      roles: result.user.roles,
    },
  };

  // Cache in memory and localStorage
  cachedAuth = authResult;
  try {
    localStorage.setItem(AUTH_STORAGE_KEY, JSON.stringify(authResult));
  } catch { /* localStorage unavailable */ }

  return authResult;
};

export const getCachedAuth = (): AuthResult | null => {
  if (cachedAuth) return cachedAuth;
  
  try {
    const stored = localStorage.getItem(AUTH_STORAGE_KEY);
    if (stored) {
      cachedAuth = JSON.parse(stored);
      return cachedAuth;
    }
  } catch { /* localStorage unavailable */ }
  
  return null;
};

export const clearAuth = (): void => {
  cachedAuth = null;
  try {
    localStorage.removeItem(AUTH_STORAGE_KEY);
  } catch { /* localStorage unavailable */ }
};

// Backward-compatible aliases
export const authenticateUser = authenticate;
export const getPiAuthResult = getCachedAuth;
export const clearPiAuth = clearAuth;
export const requestUserPermissions = async (scopes: Scope[] = ['username', 'payments']): Promise<boolean> => {
  try { await authenticate(scopes); return true; } catch { return false; }
};

// ─────────────────────────────────────────────────────────────────────────────
// Payment Helpers
// ─────────────────────────────────────────────────────────────────────────────
// If the SDK says "not initialized" (thrown, or through onError) before the payment exists at
// Pi, the current window.Pi is initialised and the payment started once more. Never after
// onReadyForServerApproval has fired, or when Pi sent a payment with the error: that payment
// already exists at Pi
export const createPayment = async (
  data: PaymentData,
  callbacks: PaymentCallbacks
): Promise<PaymentDTO | null> => {
  await ensurePiInitialized();
  if (!window.Pi) {
    callbacks.onError(new Error('Pi SDK not available'));
    return null;
  }

  let approvalStarted = false;
  let retried = false;

  const retryOnce = () => {
    retried = true;
    console.warn('⚠️ Pi SDK said "not initialized" before the payment existed: initializing and starting it once more');
    initCurrentInstance(true);
    return start();
  };

  const start = (): PaymentDTO | null =>
    window.Pi.createPayment(data, {
      onReadyForServerApproval: (paymentId: string) => {
        approvalStarted = true;
        return callbacks.onReadyForServerApproval(paymentId);
      },
      onReadyForServerCompletion: callbacks.onReadyForServerCompletion,
      onCancel: callbacks.onCancel,
      onError: (error: Error, payment?: PaymentDTO) => {
        if (!approvalStarted && !payment && !retried && isPiNotInitializedError(error)) {
          try {
            retryOnce();
          } catch (retryError) {
            callbacks.onError(retryError instanceof Error ? retryError : new Error(String(retryError)));
          }
          return;
        }
        callbacks.onError(error, payment);
      },
      onIncompletePaymentFound: (payment: PaymentDTO) => {
        incompletePaymentHandler?.(payment);
      },
    });

  try {
    return start();
  } catch (error) {
    if (!approvalStarted && !retried && isPiNotInitializedError(error)) return retryOnce();
    throw error;
  }
};

export const setIncompletePaymentHandler = (handler: (payment: PaymentDTO) => void): void => {
  incompletePaymentHandler = handler;
};

// Legacy alias
export const createPiPayment = createPayment;

// ─────────────────────────────────────────────────────────────────────────────
// High-Level Exports
// ─────────────────────────────────────────────────────────────────────────────
export const PiClient = {
  init: initializePiNetwork,
  ensureInitialized: ensurePiInitialized,
  authenticate,
  createPayment,
  getCachedAuth,
  clearAuth,
  isPiBrowser,
};

export const piNetworkCore = {
  initialize: initializePiNetwork,
  authenticate,
};

// Legacy aliases for backward compatibility
export const initPi = initializePiNetwork;
export const initializePi = (): boolean => { initializePiNetwork(); return true; };
