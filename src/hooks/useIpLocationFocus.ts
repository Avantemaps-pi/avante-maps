import { useEffect } from 'react';
import {
  canAutoCentreWithGps,
  GPS_AUTOCENTRE_FAILED_KEY,
  GPS_AUTOCENTRE_FAILED_EVENT,
} from '@/lib/gpsGrant';

const CACHE_KEY = 'ip_location_cache_v1';
const SESSION_KEY = 'ip_location_focused';
const TTL_MS = 24 * 60 * 60 * 1000; // 24h

interface CachedLocation {
  lat: number;
  lng: number;
  ts: number;
}

/** The approximate location from the IP address (cached for 24h), or null if it can't be found */
export async function getIpLocation(): Promise<{
  lat: number;
  lng: number;
} | null> {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (raw) {
      const cached: CachedLocation = JSON.parse(raw);
      if (Date.now() - cached.ts < TTL_MS)
        return { lat: cached.lat, lng: cached.lng };
    }
  } catch {
    // ignore
  }

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
      try {
        localStorage.setItem(
          CACHE_KEY,
          JSON.stringify({
            lat: data.latitude,
            lng: data.longitude,
            ts: Date.now(),
          }),
        );
      } catch {
        // ignore
      }
      return { lat: data.latitude, lng: data.longitude };
    }
  } catch {
    // silent fail — non-blocking
  }
  return null;
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
