import { useEffect } from 'react';
import {
  canAutoCentreWithGps,
  GPS_AUTOCENTRE_FAILED_KEY,
  GPS_AUTOCENTRE_FAILED_EVENT,
} from '@/lib/gpsGrant';

const SESSION_KEY = 'ip_location_focused';

type LatLng = { lat: number; lng: number };

// The IP location is kept in memory for this page load only, never in browser storage (a
// location is sensitive). Earlier versions saved it under this key; it's removed on first use
const OLD_STORAGE_KEY = 'ip_location_cache_v1';
let oldCopyRemoved = false;
const removeOldStoredCopy = () => {
  if (oldCopyRemoved) return;
  oldCopyRemoved = true;
  try {
    localStorage.removeItem(OLD_STORAGE_KEY);
  } catch {
    // storage unavailable
  }
};

let known: LatLng | null = null;
let lookup: Promise<LatLng | null> | null = null;

/** The IP location found earlier in this page load, if any (no request) */
export function peekIpLocation(): LatLng | null {
  removeOldStoredCopy();
  return known;
}

/** Keeps an IP location found another way (LocateMe's providers) for the rest of the page load */
export function rememberIpLocation(location: LatLng) {
  removeOldStoredCopy();
  known = location;
}

const lookUpIpLocation = async (): Promise<LatLng | null> => {
  try {
    const res = await fetch(
      'https://ipwho.is/?fields=success,latitude,longitude',
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (
      data?.success &&
      typeof data.latitude === 'number' &&
      typeof data.longitude === 'number'
    ) {
      return { lat: data.latitude, lng: data.longitude };
    }
  } catch {
    // silent fail — non-blocking
  }
  return null;
};

/**
 * The approximate location from the IP address, or null if it can't be found. Looked up at most
 * once per page load: callers at the same time share one request, and a failure isn't kept, so a
 * later call tries again
 */
export function getIpLocation(): Promise<LatLng | null> {
  removeOldStoredCopy();
  if (known) return Promise.resolve(known);
  lookup ??= lookUpIpLocation().then((found) => {
    lookup = null;
    if (found) known = found;
    return found;
  });
  return lookup;
}

/**
 * Map focus on login, once per browser session (sessionStorage flag):
 * - GPS, when LeafletMap will centre on it ("Use my location" on and already allowed), so the map
 *   doesn't jump from city to street
 * - otherwise the user's home location, when they've set one
 * - otherwise the IP location (cached for 24h, HTTPS, no API key), when "Use my location" is on
 * If that GPS attempt fails, the home location or the IP location is used once instead.
 */
export function useIpLocationFocus(
  enabled: boolean,
  home: { lat: number; lng: number } | null = null,
) {
  const homeLat = home?.lat;
  const homeLng = home?.lng;

  useEffect(() => {
    // Clears a copy saved by an earlier version, even when nothing is looked up below
    removeOldStoredCopy();
    if (!enabled) return;
    if (sessionStorage.getItem(SESSION_KEY) === '1') return;

    let cancelled = false;

    const dispatch = (lat: number, lng: number) => {
      sessionStorage.setItem(SESSION_KEY, '1');
      // Slight delay to let map mount
      setTimeout(() => {
        window.dispatchEvent(
          new CustomEvent('centerMap', { detail: { lat, lng, zoom: 14 } }),
        );
      }, 400);
    };

    const focusOnIp = async () => {
      if (localStorage.getItem('use_location_focus') === '0') return;
      const ip = await getIpLocation();
      if (ip && !cancelled) dispatch(ip.lat, ip.lng);
    };

    // The home location before the IP location
    const fallBack = () => {
      if (homeLat !== undefined && homeLng !== undefined)
        dispatch(homeLat, homeLng);
      else void focusOnIp();
    };

    const onGpsFailed = () => {
      window.removeEventListener(GPS_AUTOCENTRE_FAILED_EVENT, onGpsFailed);
      if (!cancelled) fallBack();
    };

    (async () => {
      if (await canAutoCentreWithGps()) {
        if (cancelled) return;
        // GPS centres the map; fall back once if it fails (it may already have)
        sessionStorage.setItem(SESSION_KEY, '1');
        if (sessionStorage.getItem(GPS_AUTOCENTRE_FAILED_KEY) === '1')
          fallBack();
        else window.addEventListener(GPS_AUTOCENTRE_FAILED_EVENT, onGpsFailed);
        return;
      }
      if (!cancelled) fallBack();
    })();

    return () => {
      cancelled = true;
      window.removeEventListener(GPS_AUTOCENTRE_FAILED_EVENT, onGpsFailed);
    };
  }, [enabled, homeLat, homeLng]);
}
