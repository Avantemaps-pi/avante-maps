import React, { useState } from 'react';
import { LocateFixed, Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { cn } from '@/lib/utils';
import { secureLog } from '@/utils/secureLogger';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';
import { hasGranted, markGranted, clearGranted } from '@/lib/gpsGrant';
import { peekIpLocation, rememberIpLocation } from '@/hooks/useIpLocationFocus';

const isPiBrowser = () => typeof window !== 'undefined' && !!(window as any).Pi;
const logCtx = () => ({
  isPiBrowser: isPiBrowser(),
  userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'unknown',
  online: typeof navigator !== 'undefined' ? navigator.onLine : null,
});

const TOAST_ID = 'locate-me';

const dispatchCenter = (lat: number, lng: number) => {
  window.dispatchEvent(new CustomEvent('centerMap', { detail: { lat, lng, zoom: 15 } }));
};

// IP fallback: ipapi.co, then geojs.io (both answer cross-origin requests)
const fetchIpLocation = async (): Promise<{ lat: number; lng: number } | null> => {
  const endpoints: Array<{ name: string; fn: () => Promise<{ lat: number; lng: number } | null> }> = [
    {
      name: 'ipapi.co',
      fn: async () => {
        const r = await fetch('https://ipapi.co/json/');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        if (typeof d.latitude === 'number' && typeof d.longitude === 'number') {
          return { lat: d.latitude, lng: d.longitude };
        }
        return null;
      },
    },
    {
      name: 'geojs.io',
      fn: async () => {
        const r = await fetch('https://get.geojs.io/v1/ip/geo.json');
        if (!r.ok) throw new Error(`HTTP ${r.status}`);
        const d = await r.json();
        const lat = parseFloat(d.latitude);
        const lng = parseFloat(d.longitude);
        if (!isNaN(lat) && !isNaN(lng)) return { lat, lng };
        return null;
      },
    },
  ];
  for (const { name, fn } of endpoints) {
    try {
      const res = await fn();
      if (res) {
        secureLog.info('LocateMe: IP fallback succeeded', { provider: name, ...logCtx() });
        return res;
      }
      secureLog.warn('LocateMe: IP fallback returned no coords', { provider: name, ...logCtx() });
    } catch (err: any) {
      secureLog.warn('LocateMe: IP fallback provider failed', {
        provider: name,
        error: err?.message || String(err),
        ...logCtx(),
      });
    }
  }
  return null;
};

const readUseLocationPref = () => {
  try {
    return localStorage.getItem('use_location_focus') !== '0';
  } catch {
    return true;
  }
};

// Tracks whether we've ever surfaced the browser's geolocation prompt to the
// user. We only show it once — either the first time they ever use the
// feature, or after they re-enable a location setting that had been turned
// off. Subsequent clicks silently fall back to IP-based location.
const PROMPTED_KEY = 'geolocation_prompted';
const hasPrompted = () => {
  try { return localStorage.getItem(PROMPTED_KEY) === '1'; } catch { return false; }
};
const markPrompted = () => {
  try { localStorage.setItem(PROMPTED_KEY, '1'); } catch { /* ignore */ }
};
const LocateMeButton: React.FC<{ className?: string }> = ({ className }) => {
  const [loading, setLoading] = useState(false);
  // SSR-safe deterministic defaults; real prefs hydrate from localStorage in
  // the mount effect below so server and first client render stay identical.
  const [enabled, setEnabled] = useState<boolean>(true);
  const keyboardOpen = useKeyboardOpen();

  React.useEffect(() => {
    const sync = () => {
      setEnabled(readUseLocationPref());
    };
    sync();
    window.addEventListener('storage', sync);
    window.addEventListener('use_location_focus_changed', sync as EventListener);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener('use_location_focus_changed', sync as EventListener);
    };
  }, []);

  const useIpFallback = async () => {
    toast.loading('Resolving your approximate location…', {
      id: TOAST_ID,
      description: 'Using IP-based location.',
    });
    const res = await fetchIpLocation();
    if (res) {
      // Kept in memory for this page load, never in browser storage
      rememberIpLocation(res);
      dispatchCenter(res.lat, res.lng);
      toast.success('Centred on your approximate location', { id: TOAST_ID });
    } else {
      secureLog.error('LocateMe: all IP fallback providers failed', logCtx());
      toast.error("Couldn't determine your location", {
        id: TOAST_ID,
        description: 'Network or service error. Check your connection and try again.',
      });
    }
  };

  const usePreciseLocation = () =>
    new Promise<boolean>((resolve) => {
      if (!('geolocation' in navigator)) {
        secureLog.warn('LocateMe: geolocation API unavailable', logCtx());
        resolve(false);
        return;
      }
      navigator.geolocation.getCurrentPosition(
        (pos) => {
          const { latitude, longitude } = pos.coords;
          secureLog.info('LocateMe: precise geolocation succeeded', {
            accuracy: pos.coords.accuracy,
            ...logCtx(),
          });
          markGranted();
          dispatchCenter(latitude, longitude);
          toast.success('Centred on your location', { id: TOAST_ID });
          resolve(true);
        },
        (err) => {
          const codeName =
            err.code === err.PERMISSION_DENIED ? 'PERMISSION_DENIED'
            : err.code === err.POSITION_UNAVAILABLE ? 'POSITION_UNAVAILABLE'
            : err.code === err.TIMEOUT ? 'TIMEOUT'
            : `UNKNOWN_${err.code}`;
          secureLog.warn('LocateMe: precise geolocation failed', {
            code: err.code,
            codeName,
            message: err.message,
            ...logCtx(),
          });
          if (err.code === err.PERMISSION_DENIED) {
            clearGranted();
            toast.message('Location permission denied', {
              id: TOAST_ID,
              description: 'Falling back to approximate IP-based location.',
            });
          }
          resolve(false);
        },
        { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 }
      );
    });

  const handleClick = async () => {
    if (loading) return;
    setLoading(true);

    try {
      secureLog.info('LocateMe: clicked', logCtx());

      // Check permission state first
      let permissionState: PermissionState | 'unknown' = 'unknown';
      try {
        if (navigator.permissions?.query) {
          const status = await navigator.permissions.query({ name: 'geolocation' as PermissionName });
          permissionState = status.state;
        }
      } catch (err: any) {
        secureLog.debug('LocateMe: permissions.query threw', { error: err?.message });
      }
      secureLog.info('LocateMe: permission state', { permissionState, ...logCtx() });

      if (permissionState === 'denied') {
        secureLog.warn('LocateMe: geolocation permission denied — using IP fallback', logCtx());
      }

      // Show the browser prompt only when:
      //   - permission is already 'granted' (no prompt actually shown), OR
      //   - permission is 'prompt' AND we have never asked before / the
      //     user just re-enabled the setting (flag cleared by Settings), OR
      //   - permission can't be read ('unknown') and GPS last succeeded.
      const shouldRequest =
        permissionState === 'granted' ||
        (permissionState === 'prompt' && !hasPrompted()) ||
        (permissionState !== 'denied' && permissionState !== 'prompt' && !hasPrompted()) ||
        (permissionState === 'unknown' && hasGranted());

      if (shouldRequest && 'geolocation' in navigator) {
        // No prompt will appear when permission is granted, or can't be read but GPS was allowed before
        const noPrompt = permissionState === 'granted' || (permissionState === 'unknown' && hasGranted());
        toast.loading(
          noPrompt ? 'Getting your location…' : 'Requesting location permission…',
          { id: TOAST_ID, description: permissionState === 'prompt' ? 'Please allow location access in the prompt.' : undefined }
        );
        if (permissionState !== 'granted') markPrompted();
        const ok = await usePreciseLocation();
        if (ok) return;
      } else if (permissionState === 'prompt' && hasPrompted()) {
        secureLog.info('LocateMe: skipping repeat geolocation prompt — using IP fallback', logCtx());
      }

      // Fallback: the IP location already found this page load
      const known = peekIpLocation();
      if (known) {
        dispatchCenter(known.lat, known.lng);
        toast.success('Centred on your approximate location', { id: TOAST_ID });
        return;
      }

      await useIpFallback();
    } finally {
      setLoading(false);
    }
  };

  const handleClickRef = React.useRef(handleClick);
  React.useEffect(() => { handleClickRef.current = handleClick; });
  React.useEffect(() => {
    const trigger = () => { handleClickRef.current?.(); };
    window.addEventListener('trigger-locate-me', trigger as EventListener);
    return () => window.removeEventListener('trigger-locate-me', trigger as EventListener);
  }, []);

  // Early return only after every hook, so hook order is stable when the setting toggles
  if (!enabled) return null;

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={loading}
      aria-label="Show my location"
      aria-busy={loading}
      // Hidden, not unmounted, while the keyboard is open so trigger-locate-me still works
      aria-hidden={keyboardOpen || undefined}
      inert={keyboardOpen}
      title={loading ? 'Resolving your location…' : 'Show my location'}
      className={cn(
        'h-11 w-11 rounded-full bg-surface-float border border-border shadow-float flex items-center justify-center text-foreground hover:bg-accent transition-[color,background-color,border-color,opacity] duration-150 motion-reduce:transition-none disabled:opacity-70 disabled:cursor-progress',
        keyboardOpen && 'opacity-0 disabled:opacity-0 pointer-events-none',
        className
      )}
    >
      {loading ? (
        <Loader2 className="h-5 w-5 animate-spin" />
      ) : (
        <LocateFixed className="h-5 w-5" />
      )}
    </button>
  );
};

export default LocateMeButton;
