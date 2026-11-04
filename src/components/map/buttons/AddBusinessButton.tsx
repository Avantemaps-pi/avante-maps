import React, { useState, useEffect } from 'react';
import { Link, useNavigate } from '@/lib/router-compat';
import { Button } from '@/components/ui/button';
import { Plus, X, Store, MessageSquare } from 'lucide-react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth/useAuth';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';

interface AddBusinessButtonProps {
  selectedPlace: string | null;
  /** Hidden but mounted while the map card strip is open */
  hiddenByStrip?: boolean;
  /** The map's businesses are still loading: the button waits for them */
  mapLoading?: boolean;
}

type FabState = 'expanded' | 'collapsed' | 'hasBusiness';

const FIRST_VISIT_KEY = 'fab_first_visit';
// _v2: keyed by the Supabase user ID; ignores counts cached under the old key
const BUSINESS_COUNT_CACHE_KEY = 'fab_business_count_cache_v2';
const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

interface BusinessCountCache {
  ownerId: string;
  count: number;
  timestamp: string;
}

const AddBusinessButton: React.FC<AddBusinessButtonProps> = ({ selectedPlace, hiddenByStrip = false, mapLoading = false }) => {
  const { user, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  const [fabState, setFabState] = useState<FabState | null>(null);
  const [speedDialOpen, setSpeedDialOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(true);
  const [isExpanding, setIsExpanding] = useState(false);
  const keyboardOpen = useKeyboardOpen();
  const hidden = keyboardOpen || hiddenByStrip;

  // Close the speed dial when the on-screen keyboard opens or the card strip takes its place
  useEffect(() => {
    if (hidden) setSpeedDialOpen(false);
  }, [hidden]);

  useEffect(() => {
    let cancelled = false;

    const applyState = (hasBusiness: boolean, firstVisit: string) => {
      if (hasBusiness) {
        setFabState('hasBusiness');
        setIsLoading(false);
        return;
      }
      const elapsed = Date.now() - new Date(firstVisit).getTime();
      setFabState(elapsed > TWENTY_FOUR_HOURS_MS ? 'collapsed' : 'expanded');
      setIsLoading(false);
    };

    const determineState = async () => {
      // Record first visit timestamp if missing
      let firstVisit = localStorage.getItem(FIRST_VISIT_KEY);
      if (!firstVisit) {
        firstVisit = new Date().toISOString();
        localStorage.setItem(FIRST_VISIT_KEY, firstVisit);
      }

      let hasBusiness = false;

      if (isAuthenticated && user?.uid) {
        // Ownership must use the Supabase user ID (RLS: owner_id = auth.uid()), never the Pi ID
        const { data: { session } } = await supabase.auth.getSession();
        const ownerId = session?.user?.id;
        if (!ownerId) {
          if (!cancelled) applyState(false, firstVisit);
          return;
        }

        // Try cache first for instant state
        try {
          const raw = localStorage.getItem(BUSINESS_COUNT_CACHE_KEY);
          if (raw) {
            const cache: BusinessCountCache = JSON.parse(raw);
            if (cache.ownerId === ownerId) {
              hasBusiness = cache.count > 0;
            }
          }
        } catch {
          // ignore parse errors
        }

        // Apply cached state immediately so UI renders fast
        if (!cancelled) applyState(hasBusiness, firstVisit);

        // Background refresh from Supabase
        try {
          const { count } = await supabase
            .from('businesses')
            .select('id', { count: 'exact', head: true })
            .eq('owner_id', ownerId);
          const freshHasBusiness = (count ?? 0) > 0;

          // Update cache
          const cache: BusinessCountCache = {
            ownerId,
            count: count ?? 0,
            timestamp: new Date().toISOString(),
          };
          localStorage.setItem(BUSINESS_COUNT_CACHE_KEY, JSON.stringify(cache));

          if (!cancelled) applyState(freshHasBusiness, firstVisit);
          return;
        } catch (error) {
          console.warn('Failed to refresh business count, using cached/default state:', error);
          // Cached state is already applied; ensure loading is cleared
          if (!cancelled) setIsLoading(false);
          return;
        }
      }

      // Not authenticated: rely solely on first visit timing
      if (!cancelled) applyState(false, firstVisit);
    };

    determineState();
    return () => { cancelled = true; };
  }, [isAuthenticated, user?.uid]);

  const positionClass = selectedPlace ? 'right-16 md:right-[calc(50%+200px)]' : 'right-4';
  // 96px clears the 64px bottom nav and the map attribution pill above it
  const bottomClass = 'bottom-[calc(6rem+env(safe-area-inset-bottom))]';
  // Faded out, not unmounted, while the on-screen keyboard or the card strip is showing
  const keyboardClass = hidden ? 'opacity-0 pointer-events-none' : '';
  const keyboardProps = { 'aria-hidden': hidden || undefined, inert: hidden };
  // Fades in once loading ends. No fill, so it can't override the opacity-0 above when it finishes
  const appearClass = 'motion-safe:animate-in motion-safe:fade-in-0 [--tw-animation-duration:150ms]';

  // Nothing to see or focus. It holds the button's place because the zoom control lines up with it
  if (isLoading || mapLoading) {
    return (
      <div
        data-add-business-button
        aria-hidden="true"
        className={`invisible pointer-events-none absolute h-14 w-14 ${bottomClass} ${positionClass}`}
      />
    );
  }

  // State 1: expanded pill
  if (fabState === 'expanded') {
    return (
      <div data-add-business-button className={`absolute ${bottomClass} ${positionClass} z-20 transition-all duration-300 motion-reduce:transition-none ${appearClass} ${keyboardClass}`} {...keyboardProps}>
        <Link to="/registration">
          <Button
            data-add-business-fab
            className="h-14 sm:h-14 pl-4 pr-6 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover shadow-float flex items-center gap-2 transition-all duration-300 [&_svg]:size-[18px] sm:[&_svg]:size-[18px]"
            aria-label="Register a business"
          >
            <Plus className="flex-shrink-0" />
            <span className="text-sm font-semibold whitespace-nowrap">Register business</span>
          </Button>
        </Link>
      </div>
    );
  }

  // State 2 / 3: collapsed icon with speed dial
  const registerLabel = fabState === 'hasBusiness' ? 'Add another business' : 'Register business';

  const handleRegisterExpand = () => {
    setSpeedDialOpen(false);
    setIsExpanding(true);
    window.setTimeout(() => {
      navigate('/registration');
    }, 2000);
  };

  const actions = [
    { icon: Store, label: registerLabel, onClick: handleRegisterExpand, isRegister: true },
    { icon: MessageSquare, label: 'CommuniCon', onClick: () => navigate('/communicon') },
  ];

  const handleActionClick = (action: typeof actions[number]) => {
    if (action.isRegister) {
      action.onClick();
      return;
    }
    setSpeedDialOpen(false);
    action.onClick();
  };

  // Expanding transition: animate collapsed icon into full pill, then navigate
  if (isExpanding) {
    return (
      <div
        data-add-business-button
        className={`absolute ${bottomClass} ${positionClass} z-30 transition-opacity duration-150 motion-reduce:transition-none ${keyboardClass}`}
        {...keyboardProps}
      >
        <Button
          data-add-business-fab
          disabled
          style={{ animation: 'fab-expand 600ms ease-out forwards' }}
          className="h-14 sm:h-14 pl-4 pr-6 rounded-full bg-primary text-primary-foreground shadow-float flex items-center gap-2 overflow-hidden [&_svg]:size-[18px] sm:[&_svg]:size-[18px]"
          aria-label={registerLabel}
        >
          <Plus className="flex-shrink-0" />
          <span
            style={{ animation: 'fab-label-fade 500ms ease-out 250ms forwards', opacity: 0 }}
            className="text-sm font-semibold whitespace-nowrap"
          >
            {registerLabel}
          </span>
        </Button>
        <style>{`
          @keyframes fab-expand {
            from { width: 3.5rem; padding-left: 0; padding-right: 0; }
            to { width: auto; padding-left: 1rem; padding-right: 1.5rem; }
          }
          @keyframes fab-label-fade {
            from { opacity: 0; transform: translateX(-4px); }
            to { opacity: 1; transform: translateX(0); }
          }
        `}</style>
      </div>
    );
  }

  return (
    <>
      {speedDialOpen && (
        <div
          className="fixed inset-0 bg-overlay z-[55] animate-fade-in"
          onClick={() => setSpeedDialOpen(false)}
          aria-hidden="true"
        />
      )}
      <div
        data-add-business-button
        className={`absolute ${bottomClass} ${positionClass} ${speedDialOpen ? 'z-[56]' : 'z-30'} flex flex-col items-end gap-3 transition-opacity duration-150 motion-reduce:transition-none ${appearClass} ${keyboardClass}`}
        {...keyboardProps}
      >
        {speedDialOpen && (
          <div className="flex flex-col items-end gap-3 mb-1 animate-fade-in">
            {actions.map((action) => {
              const Icon = action.icon;
              return (
                <div key={action.label} className="flex items-center gap-3">
                  <span className="bg-surface-float text-foreground text-sm font-medium px-3 py-1.5 rounded-md shadow-float whitespace-nowrap">
                    {action.label}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleActionClick(action)}
                    aria-label={action.label}
                    className="h-12 w-12 rounded-full bg-surface-float border border-border hover:bg-accent shadow-float flex items-center justify-center text-foreground transition-colors"
                  >
                    <Icon className="h-5 w-5" />
                  </button>
                </div>
              );
            })}
          </div>
        )}
        <Button
          data-add-business-fab
          onClick={() => setSpeedDialOpen((s) => !s)}
          aria-label={speedDialOpen ? 'Close menu' : 'Open quick actions'}
          aria-expanded={speedDialOpen}
          className="h-14 w-14 sm:h-14 sm:w-14 p-0 rounded-full bg-primary text-primary-foreground hover:bg-primary-hover shadow-float flex items-center justify-center"
        >
          {speedDialOpen ? (
            <X className="h-5 w-5 transition-transform duration-300" />
          ) : (
            <Plus className="h-5 w-5 transition-transform duration-300" />
          )}
        </Button>
      </div>
    </>
  );
};

export default AddBusinessButton;
