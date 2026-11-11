
import React, { useState, useEffect, lazy, Suspense } from 'react';
import { useLocation, useNavigate } from '@/lib/router-compat';
import { useBusinessData } from '@/hooks/useBusinessData';
import { AlertCircle, Menu, SearchX, Store } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { StateBlock, type StateBlockProps } from '@/components/ui/state-block';
import SearchBar from '@/components/map/SearchBar';
import CategoryFilter, { CATEGORY_OPTIONS } from '@/components/map/CategoryFilter';
import LocateMeButton from '@/components/map/buttons/LocateMeButton';
import LocationBanner from '@/components/map/LocationBanner';
import { useSidebar } from '@/components/ui/sidebar';
import AppSidebar from '@/components/layout/AppSidebar';
import BottomNavBar from '@/components/layout/BottomNavBar';
import PlaceCardSEO from '@/components/seo/PlaceCardSEO';
import MetaTags from '@/components/seo/MetaTags';
import { BusinessSuggestion } from '@/hooks/useBusinessAutocomplete';
import { useSearchTracking } from '@/hooks/useSearchTracking';
import { useAuth } from '@/context/auth/useAuth';
import LandingPage from './LandingPage';
import { useIpLocationFocus } from '@/hooks/useIpLocationFocus';
import { useHomeLocation } from '@/hooks/useHomeLocation';
import HomeLocationSheet from '@/components/map/HomeLocationSheet';
import '../styles/map.css';
import { getOrigin } from '@/utils/browserEnv';
import { Place } from '@/types/business';
import type { LatLngBounds } from 'leaflet';
import MapCardStrip, { type StripScrollRequest } from '@/components/map/MapCardStrip';
import MapListButton from '@/components/map/MapListButton';
import MapListView from '@/components/map/MapListView';
import MapAreaLabel from '@/components/map/MapAreaLabel';
import type { AreaSelection } from '@/components/map/map-components/AreaClickFocus';
import { getCachedArea } from '@/components/map/area/areaLookup';
import { useKeyboardOpen } from '@/hooks/useKeyboardOpen';

const LeafletMap = lazy(() => import('@/components/map/LeafletMap'));
const AddBusinessButton = lazy(() => import('@/components/map/buttons/AddBusinessButton'));

// Whether a place shows under a category chip ('all' shows everything)
const matchesCategory = (place: Place, categoryId: string) => {
  if (categoryId === 'all') return true;
  const opt = CATEGORY_OPTIONS.find(o => o.id === categoryId);
  if (!opt || opt.match.length === 0) return true;
  const haystack = [
    place.category,
    ...(place.business_types || []),
    ...(place.keywords || []),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return opt.match.some(m => haystack.includes(m));
};

// Max cards in the map card strip
const STRIP_MAX = 20;

const placeLatLng = (place: Place) => place.position ?? place.location ?? null;

// Places inside the bounds, nearest to origin first (origin's own place leads)
const placesInBounds = (places: Place[], bounds: LatLngBounds, origin: { lat: number; lng: number }) => {
  const kx = Math.cos((origin.lat * Math.PI) / 180);
  return places
    .map((place) => ({ place, pos: placeLatLng(place) }))
    .filter(({ pos }) => pos && bounds.contains([pos.lat, pos.lng]))
    .map(({ place, pos }) => ({
      place,
      d: (pos!.lat - origin.lat) ** 2 + ((pos!.lng - origin.lng) * kx) ** 2,
    }))
    .sort((a, b) => a.d - b.d)
    .map(({ place }) => place);
};

// The strip's cards: the same order, capped
const buildStripIds = (places: Place[], bounds: LatLngBounds, origin: { lat: number; lng: number }) =>
  placesInBounds(places, bounds, origin)
    .slice(0, STRIP_MAX)
    .map(({ id }) => id);

interface StripState {
  /** Frozen card order; rebuilt only when the user moves the map */
  ids: string[];
  selectedId: string;
  /** Bumped on each selection so the map re-checks the pin is in view */
  selectionSeq: number;
  scroll: StripScrollRequest;
}

const Index = () => {
  const { isAuthenticated, isLoading: authLoading } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [selectedPlace, setSelectedPlace] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState<string>('');
  const [selectedCategoryId, setSelectedCategoryId] = useState<string>('all');
  const { places = [], filteredPlaces = [], isLoading = false, isError, refetch, handleSearch } = useBusinessData();
  const [retrying, setRetrying] = useState(false);
  // Bumped to remount SearchBar, which clears its input (it keeps its own value)
  const [searchResetKey, setSearchResetKey] = useState(0);
  const { setOpenMobile } = useSidebar();
  const { trackBusinessSearch } = useSearchTracking();

  // After login, focus the map once per session: GPS (when allowed), else the home location, else
  // the IP location. Waits for the home location to load
  const {
    home,
    isLoading: homeLoading,
    isError: homeError,
    saveHomeLocation,
    isSaving: homeSaving,
  } = useHomeLocation();
  const homeReady = isAuthenticated && !authLoading && !homeLoading;
  useIpLocationFocus(homeReady, home?.position ?? null);

  // "Set your home location", once per account: shown while home_set_at is null (never when it
  // couldn't be read). Dismissed without a choice, it waits for the next session
  const [homeSheetOpen, setHomeSheetOpen] = useState(false);
  const needsHome =
    homeReady && !homeError && home !== null && home.setAt === null;
  useEffect(() => {
    if (!needsHome) return;
    try {
      if (sessionStorage.getItem('home_sheet_dismissed') === '1') return;
    } catch {
      // storage unavailable
    }
    setHomeSheetOpen(true);
  }, [needsHome]);
  const handleHomeSheetChange = (open: boolean) => {
    setHomeSheetOpen(open);
    if (!open) {
      try {
        sessionStorage.setItem('home_sheet_dismissed', '1');
      } catch {
        // ignore
      }
    }
  };
  const handleHomeSave = async (
    position: { lat: number; lng: number } | null,
  ) => {
    await saveHomeLocation(position);
    if (position) {
      window.dispatchEvent(
        new CustomEvent('centerMap', { detail: { ...position, zoom: 14 } }),
      );
    }
  };

  const handlePlaceClick = (placeId: string, zoomToLocation?: boolean) => {
    setSelectedPlace(placeId);
    if (zoomToLocation) {
      // Trigger zoom event
      window.dispatchEvent(new CustomEvent('zoomToPlace', { detail: { placeId, zoom: true } }));
    }
  };
  
  const handleMenuClick = () => {
    setOpenMobile(true);
  };

  const handlePlaceSelect = (place: { name: string; lat: number; lng: number }) => {
    // Center the map on the selected place
    window.dispatchEvent(new CustomEvent('centerMap', { 
      detail: { lat: place.lat, lng: place.lng, zoom: 15 } 
    }));
  };

  const handleBusinessSelect = (business: BusinessSuggestion) => {
    // Track the business search for personalized recommendations
    trackBusinessSearch(Number(business.id), business.name);
    
    // Show all categories if the active one would hide its pin behind the drawer
    const place = places.find(p => p.id === business.id);
    if (place && !matchesCategory(place, selectedCategoryId)) {
      setSelectedCategoryId('all');
    }

    // Set selected place and zoom to it
    setSelectedPlace(business.id);
    window.dispatchEvent(new CustomEvent('centerMap', { 
      detail: { lat: business.lat, lng: business.lng, zoom: 16 } 
    }));
  };

  const handleSearchChange = (term: string) => {
    setSearchTerm(term);
    handleSearch(term);
  };

  useEffect(() => {
    const timer = setTimeout(() => {
      window.dispatchEvent(new Event('resize'));
    }, 300);
    return () => clearTimeout(timer);
  }, []);

  // Handle shared place URLs
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const sharedPlaceId = urlParams.get('place');
    const state = location.state as { selectedPlaceId?: string; zoomToLocation?: boolean } | null;
    const stateSelectedPlaceId = state?.selectedPlaceId;
    const shouldZoom = state?.zoomToLocation;
    
    if (sharedPlaceId) {
      setSelectedPlace(sharedPlaceId);
    } else if (stateSelectedPlaceId) {
      setSelectedPlace(stateSelectedPlaceId);
      if (shouldZoom) {
        // Trigger zoom event with a slight delay to ensure map is ready
        setTimeout(() => {
          window.dispatchEvent(new CustomEvent('zoomToPlace', { detail: { placeId: stateSelectedPlaceId, zoom: true } }));
        }, 300);
      }
    }
  }, [location]);

  // Apply category filter on top of search filter
  const basePlaces = filteredPlaces.length > 0 || searchTerm ? filteredPlaces : places;
  const visiblePlaces = React.useMemo(
    () => basePlaces.filter(p => matchesCategory(p, selectedCategoryId)),
    [basePlaces, selectedCategoryId]
  );

  // Every business in view, nearest to the map centre first (kept current on every move)
  const [viewBounds, setViewBounds] = useState<LatLngBounds | null>(null);
  const placesInView = React.useMemo(
    () => (viewBounds ? placesInBounds(visiblePlaces, viewBounds, viewBounds.getCenter()) : []),
    [visiblePlaces, viewBounds]
  );

  // Map card strip: a pin tap shows a swipeable strip of the businesses in view,
  // starting with the one tapped; tapping a card opens the drawer
  const [strip, setStrip] = useState<StripState | null>(null);
  const [cardDrawerId, setCardDrawerId] = useState<string | null>(null);
  const keyboardOpen = useKeyboardOpen();
  const visiblePlacesRef = React.useRef(visiblePlaces);
  visiblePlacesRef.current = visiblePlaces;

  // The map area tapped into (country → state → city → suburb)
  const [areaSelection, setAreaSelection] = useState<AreaSelection | null>(null);
  const area = areaSelection?.area ?? null;
  const parentArea = area ? getCachedArea(area.parentKey) : null;

  // "List · N": every business in view as a list
  const [listOpen, setListOpen] = useState(false);
  const listButtonRef = React.useRef<HTMLButtonElement>(null);
  const drawerOpen = !!selectedPlace || !!cardDrawerId;
  const closeList = React.useCallback(() => setListOpen(false), []);

  // Closing the list returns focus to the List button (once it's no longer inert)
  const wasListOpen = React.useRef(false);
  useEffect(() => {
    const closed = wasListOpen.current && !listOpen;
    wasListOpen.current = listOpen;
    if (!closed) return undefined;
    const frame = requestAnimationFrame(() => listButtonRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [listOpen]);

  const stripPlaces = React.useMemo(() => {
    if (!strip) return [];
    const byId = new Map(visiblePlaces.map((p) => [p.id, p]));
    return strip.ids.map((id) => byId.get(id)).filter((p): p is Place => !!p);
  }, [strip, visiblePlaces]);

  const handlePinTap = React.useCallback(
    (id: string, { bounds, fromKeyboard }: { bounds: LatLngBounds; fromKeyboard: boolean }) => {
      setStrip((prev) => {
        const scroll = { seq: (prev?.scroll.seq ?? 0) + 1, focus: fromKeyboard };
        const selectionSeq = (prev?.selectionSeq ?? 0) + 1;
        // Already in the strip: scroll to its card, keep the list
        if (prev?.ids.includes(id)) {
          return { ...prev, selectedId: id, selectionSeq, scroll: { ...scroll, instant: false } };
        }
        const tapped = visiblePlacesRef.current.find((p) => p.id === id);
        const origin = tapped ? placeLatLng(tapped) : null;
        if (!origin) return prev;
        const ids = buildStripIds(visiblePlacesRef.current, bounds, origin);
        // The tapped pin can sit right on the edge of the bounds
        if (ids[0] !== id) ids.unshift(...[id].filter((x) => !ids.includes(x)));
        return { ids: ids.slice(0, STRIP_MAX), selectedId: id, selectionSeq, scroll: { ...scroll, instant: true } };
      });
    },
    []
  );

  // The user dragged or zoomed: rebuild from what's in view, keeping the card if it's still there
  const handleUserMoveEnd = React.useCallback((bounds: LatLngBounds) => {
    setStrip((prev) => {
      if (!prev) return prev;
      const current = visiblePlacesRef.current.find((p) => p.id === prev.selectedId);
      const currentPos = current ? placeLatLng(current) : null;
      const keep = !!currentPos && bounds.contains([currentPos.lat, currentPos.lng]);
      const ids = buildStripIds(visiblePlacesRef.current, bounds, keep && currentPos ? currentPos : bounds.getCenter());
      const first = ids[0];
      if (!first) return null;
      return {
        ids,
        selectedId: keep ? prev.selectedId : first,
        selectionSeq: prev.selectionSeq,
        scroll: { seq: prev.scroll.seq + 1, instant: true, focus: false },
      };
    });
  }, []);

  const handleStripSelect = React.useCallback((id: string) => {
    setStrip((prev) =>
      prev && prev.selectedId !== id ? { ...prev, selectedId: id, selectionSeq: prev.selectionSeq + 1 } : prev
    );
  }, []);

  const closeStrip = React.useCallback(() => setStrip(null), []);

  // Search or category changes close the strip
  useEffect(() => {
    setStrip(null);
  }, [searchTerm, selectedCategoryId]);

  // Nothing left to show (data changed): close it
  useEffect(() => {
    if (strip && stripPlaces.length === 0) setStrip(null);
  }, [strip, stripPlaces.length]);

  // Escape closes the strip (the drawer handles Escape itself while it's open, the list view while it's open)
  useEffect(() => {
    if (!strip || cardDrawerId || selectedPlace || listOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setStrip(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [strip, cardDrawerId, selectedPlace, listOpen]);

  // When the search results update, sync the map viewport to the best match the
  // map actually shows (first of visiblePlaces: search results, relevance order,
  // narrowed by the category). No visible match: leave the map; the no-match card shows.
  const lastCenteredKeyRef = React.useRef<string>('');
  useEffect(() => {
    if (!searchTerm.trim()) {
      lastCenteredKeyRef.current = '';
      return;
    }
    const best = visiblePlaces[0];
    if (!best) return;
    const lat = best.position?.lat ?? best.location?.lat;
    const lng = best.position?.lng ?? best.location?.lng;
    if (lat == null || lng == null) return;

    const key = `${searchTerm}::${selectedCategoryId}::${best.id}`;
    if (lastCenteredKeyRef.current === key) return;
    lastCenteredKeyRef.current = key;

    window.dispatchEvent(new CustomEvent('centerMap', {
      detail: { lat, lng, zoom: 14 },
    }));
  }, [searchTerm, selectedCategoryId, visiblePlaces]);

  // One state for the map screen, and exactly one message for it
  const hasSearch = searchTerm.trim() !== '';
  const hasCategory = selectedCategoryId !== 'all';
  // A refetch with no data puts the query back to pending (isLoading), so keep the
  // error card up while Try again runs, with the button showing its loading state.
  const mapState: 'loading' | 'error' | 'none' | 'no-match' | 'ok' = retrying && places.length === 0
    ? 'error'
    : isLoading
      ? 'loading'
      : isError && places.length === 0
        ? 'error'
      : places.length === 0 && !hasSearch && !hasCategory
        ? 'none'
        : visiblePlaces.length === 0 && (hasSearch || hasCategory)
          ? 'no-match'
          : 'ok';

  const handleRetry = async () => {
    setRetrying(true);
    try {
      await refetch();
    } finally {
      setRetrying(false);
    }
  };

  const clearSearch = () => {
    handleSearchChange('');
    setSearchResetKey(k => k + 1);
  };

  const showAllCategories = () => setSelectedCategoryId('all');

  const getStateCard = (): StateBlockProps | null => {
    if (mapState === 'error') {
      return {
        kind: 'error',
        icon: AlertCircle,
        title: "Couldn't load businesses",
        body: 'Check your connection, then try again. The map itself still works.',
        action: { label: 'Try again', onClick: handleRetry, loading: retrying },
      };
    }
    if (mapState === 'none') {
      return {
        kind: 'empty',
        icon: Store,
        title: 'No businesses on the map yet',
        body: "Register yours and it'll be the first one people find here.",
        action: { label: 'Register business', onClick: () => navigate('/registration') },
      };
    }
    if (mapState === 'no-match') {
      const category = CATEGORY_OPTIONS.find(o => o.id === selectedCategoryId);
      if (!hasSearch) {
        return {
          kind: 'empty',
          icon: category?.icon ?? SearchX,
          title: `No ${(category?.label ?? 'matching').toLowerCase()} businesses yet`,
          body: 'Try another category, or check back soon.',
          action: { label: 'Show all categories', onClick: showAllCategories },
        };
      }
      const matchesInOtherCategories = hasCategory && filteredPlaces.length > 0;
      return {
        kind: 'empty',
        icon: SearchX,
        title: `No results for "${searchTerm.trim()}"`,
        body: matchesInOtherCategories
          ? 'There are matches in other categories.'
          : 'Check the spelling or try another name.',
        action: matchesInOtherCategories
          ? { label: 'Show all categories', onClick: showAllCategories }
          : { label: 'Clear search', onClick: clearSearch },
      };
    }
    return null;
  };
  const stateCard = getStateCard();

  // List view subtitle: the active category and search, e.g. 'Food · matching "coffee"'
  const listSubtitle = [
    hasCategory ? CATEGORY_OPTIONS.find(o => o.id === selectedCategoryId)?.label : undefined,
    hasSearch ? `matching "${searchTerm.trim()}"` : undefined,
  ].filter(Boolean).join(' · ');

  // Find the selected place for SEO
  const selectedPlaceData = [...places, ...filteredPlaces].find(place => place.id === selectedPlace);

  // Show landing page for unauthenticated users
  if (!isAuthenticated && !authLoading) {
    return <LandingPage />;
  }

  // Show loading only when not yet authenticated and still loading
  if (!isAuthenticated && authLoading) {
    return <div className="w-full h-screen bg-muted animate-pulse" />;
  }

  return (
    <div className="w-full h-screen relative overflow-hidden">
      {/* SEO metadata */}
      {selectedPlaceData ? (
        <PlaceCardSEO place={selectedPlaceData} isActive={true} />
      ) : (
        <MetaTags
          title="Discover Local Businesses"
          description="Find and explore local businesses on Avante Maps. Register your business, get discovered by customers, and transact with Pi cryptocurrency."
          keywords={['pi network', 'local businesses', 'business directory', 'cryptocurrency', 'pi payment', 'avante maps', 'business map']}
          authors={[{ name: 'Avante Maps Team' }]}
          ogType="website"
          ogImage={{
            url: `${getOrigin()}/og-image.png`,
            secure_url: `${getOrigin()}/og-image.png`,
            type: 'image/png',
            width: 1200,
            height: 630,
            alt: 'Avante Maps - Local Business Discovery'
          }}
          twitter={{
            card: 'summary_large_image',
            site: '@AvanteMap',
            title: 'Avante Maps - Discover Local Businesses',
            description: 'Find local businesses and pay with Pi Network',
            image: `${getOrigin()}/og-image.png`,
            image_alt: 'Avante Maps Preview'
          }}
          structuredData={{
            '@context': 'https://schema.org',
            '@type': 'WebApplication',
            'name': 'Avante Maps',
            'description': 'Local business discovery platform powered by Pi Network',
            'url': getOrigin(),
            'applicationCategory': 'BusinessApplication',
            'operatingSystem': 'Web',
            'offers': {
              '@type': 'Offer',
              'category': 'Subscription'
            }
          }}
        />
      )}

      <AppSidebar />

      {/* The map screen; inert behind the list view (the drawer's portal isn't inside it) */}
      <div className="contents" inert={listOpen} aria-hidden={listOpen || undefined}>
        {/* Map container with consistent sizing across all screens */}
        <div className="absolute inset-0 w-full h-full">
          <Suspense fallback={<div className="w-full h-full bg-muted animate-pulse" />}>
            <LeafletMap
              places={visiblePlaces}
              selectedPlaceId={selectedPlace}
              onMarkerClick={handlePlaceClick}
              isLoading={isLoading}
              onPinTap={handlePinTap}
              stripSelectedId={strip?.selectedId ?? null}
              stripSelectionSeq={strip?.selectionSeq ?? 0}
              cardDrawerId={cardDrawerId}
              onCardDrawerClose={() => setCardDrawerId(null)}
              onEmptyMapClick={closeStrip}
              onUserMoveEnd={handleUserMoveEnd}
              onBoundsChange={setViewBounds}
              areaSelection={areaSelection}
              onAreaSelect={setAreaSelection}
            />
          </Suspense>
        </div>
      
        {/* Floating UI - responsive positioning with proper spacing for sidebar */}
        {/* pointer-events-none so the map stays draggable in the gaps; each row opts back in */}
        <div data-map-top-stack className="absolute top-0 left-0 right-0 z-20 px-4 md:pl-[280px] lg:pl-[280px] pt-3 sm:pt-4 flex flex-col gap-3 pointer-events-none">
          <div className="flex items-center gap-2 pointer-events-auto">
            <Button
              variant="ghost"
              size="icon"
              onClick={handleMenuClick}
              aria-label="Open menu"
              className="h-11 w-11 sm:h-11 sm:w-11 rounded-full flex-shrink-0 bg-surface-float border border-border shadow-float text-foreground sm:hidden [&_svg]:size-5 sm:[&_svg]:size-5"
            >
              <Menu />
            </Button>
            <div className="flex-1 min-w-0">
              <SearchBar 
                key={searchResetKey}
                onSearch={handleSearchChange}
                onPlaceSelect={handlePlaceSelect}
                onBusinessSelect={handleBusinessSelect}
                enableAutocomplete={true}
                autocompleteMode="business"
                businesses={places}
                loading={mapState === 'loading'}
              />
            </div>
          </div>
          {/* Chips bleed to the right edge; -ml-1/pl-1 leaves room for the focus ring */}
          <CategoryFilter
            selectedCategoryId={selectedCategoryId}
            onSelect={setSelectedCategoryId}
            className="-ml-1 pl-1 -mr-4 pr-4 -my-1 pointer-events-auto"
          />
          <MapAreaLabel
            name={area?.name ?? null}
            parentName={parentArea?.name ?? null}
            onUp={() => parentArea && setAreaSelection({ area: parentArea, fly: true })}
            onClear={() => setAreaSelection(null)}
            hidden={mapState !== 'ok' || keyboardOpen}
          />
          <LocationBanner className="pointer-events-auto" />
        </div>

        {/* Error / empty / no-match card: below the top stack, only the card takes taps.
            Mobile: pr-[76px] keeps it left of the Locate/zoom column (44px + 16px edge + gap) */}
        {stateCard && (
          <div className="absolute inset-x-0 top-[248px] z-10 flex justify-center pl-4 pr-[76px] md:pr-4 md:pl-[280px] pointer-events-none">
            <div className="pointer-events-auto w-full max-w-sm rounded-xl border border-border bg-card text-card-foreground shadow-float">
              <StateBlock {...stateCard} />
            </div>
          </div>
        )}
      
        {strip && stripPlaces.length > 0 && (
          <MapCardStrip
            places={stripPlaces}
            selectedId={strip.selectedId}
            scrollRequest={strip.scroll}
            onSelect={handleStripSelect}
            onOpen={setCardDrawerId}
            hidden={keyboardOpen}
          />
        )}

        {mapState === 'ok' && placesInView.length >= 1 && (
          <MapListButton
            ref={listButtonRef}
            count={placesInView.length}
            onClick={() => setListOpen(true)}
            stripOpen={!!strip}
            hidden={keyboardOpen || drawerOpen || listOpen}
          />
        )}

        <Suspense fallback={null}>
          <AddBusinessButton selectedPlace={selectedPlace} hiddenByStrip={!!strip} mapLoading={mapState === 'loading'} />
        </Suspense>
        {/* Top of the right-hand column: FAB (bottom 96px, 56px tall) + 12px gap + zoom group (90px) + 12px gap = 266px.
            Strip open: its top (76px + 124px = 200px) sits 48px above the FAB's (152px), so 314px */}
        <LocateMeButton
          className={`absolute right-4 z-20 ${strip ? 'bottom-[calc(314px+env(safe-area-inset-bottom))]' : 'bottom-[calc(266px+env(safe-area-inset-bottom))]'}`}
        />
      </div>

      {listOpen && (
        <MapListView
          places={placesInView}
          subtitle={listSubtitle || undefined}
          selectedId={strip?.selectedId ?? null}
          drawerOpen={drawerOpen}
          onOpen={setCardDrawerId}
          onClose={closeList}
        />
      )}
      <BottomNavBar onItemClick={(to) => to === '/' && closeList()} />
      <HomeLocationSheet
        open={homeSheetOpen}
        onOpenChange={handleHomeSheetChange}
        variant="first"
        home={home}
        onSave={handleHomeSave}
        isSaving={homeSaving}
      />
    </div>
  );
};

export default Index;
