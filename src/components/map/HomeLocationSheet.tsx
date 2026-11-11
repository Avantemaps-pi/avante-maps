import React, { Suspense, lazy, useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetTitle,
} from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import {
  OVERLAY_MOTION,
  SHEET_MOTION,
} from '@/components/chat/QuickActionsSheet';
import { getIpLocation } from '@/hooks/useIpLocationFocus';
import type { HomeLocation } from '@/hooks/useHomeLocation';
import { clearGranted, markGranted } from '@/lib/gpsGrant';
import { defaultCenter } from './mapConfig';

// Leaflet only runs in the browser
const HomeLocationPicker = lazy(() => import('./HomeLocationPicker'));

type Position = { lat: number; lng: number };

interface HomeLocationSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** first: after sign-in, with "Skip for now"; settings: from Settings, with "Remove" */
  variant: 'first' | 'settings';
  home: HomeLocation | null;
  /** Saves the position (null: skip or remove) */
  onSave: (position: Position | null) => Promise<void>;
  isSaving: boolean;
}

// The device's location the way the app finds it: GPS when "Use my location" is on (asking once
// if it hasn't been allowed or refused yet), else the IP location
const findCurrentPosition = async (): Promise<Position | null> => {
  let useGps = typeof navigator !== 'undefined' && !!navigator.geolocation;
  try {
    if (localStorage.getItem('use_location_focus') === '0') useGps = false;
  } catch {
    // storage unavailable: the setting defaults to on
  }
  if (useGps) {
    const fromGps = await new Promise<Position | null>((resolve) => {
      navigator.geolocation.getCurrentPosition(
        (p) => {
          markGranted();
          resolve({ lat: p.coords.latitude, lng: p.coords.longitude });
        },
        (err) => {
          if (err.code === err.PERMISSION_DENIED) clearGranted();
          resolve(null);
        },
        { timeout: 10000, maximumAge: 60000, enableHighAccuracy: true },
      );
    });
    if (fromGps) return fromGps;
  }
  return getIpLocation();
};

/** "Set your home location": a small map with a pin already at the user's location */
const HomeLocationSheet: React.FC<HomeLocationSheetProps> = ({
  open,
  onOpenChange,
  variant,
  home,
  onSave,
  isSaving,
}) => {
  const [position, setPosition] = useState<Position | null>(null);

  // On opening: the saved home in Settings, else where the user is now
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    if (variant === 'settings' && home?.position) {
      setPosition(home.position);
      return;
    }
    setPosition(null);
    void findCurrentPosition().then((found) => {
      if (!cancelled) setPosition(found ?? defaultCenter);
    });
    return () => {
      cancelled = true;
    };
  }, [open, variant, home?.position]);

  const save = async (next: Position | null, done: string | null) => {
    try {
      await onSave(next);
      if (done) toast.success(done);
      onOpenChange(false);
    } catch (error) {
      toast.error(
        error instanceof Error
          ? error.message
          : 'Your home location could not be saved.',
      );
    }
  };

  const located = position !== null;

  return (
    <Sheet open={open} onOpenChange={(next) => !isSaving && onOpenChange(next)}>
      <SheetContent
        side="bottom"
        hideClose
        overlayClassName={`bg-slate-950/50 ${OVERLAY_MOTION}`}
        className={`flex max-h-[90dvh] flex-col gap-3 overflow-y-auto rounded-t-[20px] bg-background px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] ${SHEET_MOTION}`}
      >
        <div
          className="h-1 w-9 shrink-0 self-center rounded-full bg-input"
          aria-hidden="true"
        />
        <div>
          <SheetTitle className="text-lg font-bold text-foreground">
            Set your home location
          </SheetTitle>
          <SheetDescription className="text-sm text-muted-foreground">
            The map opens here when your device's location isn't used.
          </SheetDescription>
        </div>

        <div
          data-home-picker
          className="relative h-56 w-full overflow-hidden rounded-xl border border-border bg-muted"
        >
          {located ? (
            <Suspense
              fallback={<Skeleton className="h-full w-full rounded-none" />}
            >
              <HomeLocationPicker position={position} onChange={setPosition} />
            </Suspense>
          ) : (
            <div
              className="flex h-full items-center justify-center gap-2 text-sm text-muted-foreground"
              role="status"
            >
              <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
              Finding your location…
            </div>
          )}
        </div>
        <p className="text-sm text-muted-foreground">Drag the pin to adjust.</p>

        <div className="flex flex-col gap-2">
          <Button
            type="button"
            className="h-11 w-full"
            disabled={!located || isSaving}
            onClick={() => position && save(position, 'Home location saved')}
          >
            {isSaving && (
              <Loader2
                className="mr-2 h-4 w-4 animate-spin"
                aria-hidden="true"
              />
            )}
            {variant === 'first' ? 'Use this location' : 'Save'}
          </Button>
          {variant === 'first' ? (
            <Button
              type="button"
              variant="ghost"
              className="h-11 w-full"
              disabled={isSaving}
              onClick={() => save(null, null)}
            >
              Skip for now
            </Button>
          ) : (
            home?.position && (
              <Button
                type="button"
                variant="ghost"
                className="h-11 w-full text-destructive hover:text-destructive"
                disabled={isSaving}
                onClick={() => save(null, 'Home location removed')}
              >
                Remove home location
              </Button>
            )
          )}
        </div>
      </SheetContent>
    </Sheet>
  );
};

export default HomeLocationSheet;
