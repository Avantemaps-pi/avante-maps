import React, { useState, useEffect, useCallback, useRef } from 'react';
import { Input } from '@/components/ui/input';
import { Search, MapPin, Store, BadgeCheck, Loader2 } from 'lucide-react';
// Lightweight debounce (replaces lodash/debounce to drop vulnerable transitive deps)
function debounce<T extends (...args: any[]) => void>(fn: T, wait: number) {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const debounced = ((...args: Parameters<T>) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => fn(...args), wait);
  }) as T & { cancel: () => void };
  debounced.cancel = () => {
    if (timer) clearTimeout(timer);
    timer = null;
  };
  return debounced;
}
import { useLocationIQAutocomplete, GeocodingOptions } from '@/hooks/useLocationIQAutocomplete';
import { useBusinessAutocomplete, BusinessSuggestion } from '@/hooks/useBusinessAutocomplete';
import { Place } from '@/types/business';
import { cn } from '@/lib/utils';

export interface MapBounds {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

interface SearchBarProps {
  onSearch?: (searchTerm: string) => void;
  onPlaceSelect?: (place: { name: string; lat: number; lng: number }) => void;
  onBusinessSelect?: (business: BusinessSuggestion) => void;
  placeholder?: string;
  enableAutocomplete?: boolean;
  autocompleteMode?: 'address' | 'business';
  businesses?: Place[];
  mapBounds?: MapBounds;
  countrycodes?: string;
  /** The map's businesses are loading: a spinner and "Loading businesses…" in the box. It stays usable */
  loading?: boolean;
}

const SearchBar: React.FC<SearchBarProps> = ({
  onSearch,
  onPlaceSelect,
  onBusinessSelect,
  placeholder = 'Search businesses',
  enableAutocomplete = true,
  autocompleteMode = 'business',
  businesses = [],
  mapBounds,
  countrycodes,
  loading = false
}) => {
  const [searchTerm, setSearchTerm] = useState('');
  const [showDropdown, setShowDropdown] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const dropdownRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Address autocomplete hook
  const { 
    predictions: addressPredictions, 
    getSuggestions: getAddressSuggestions, 
    getPlaceDetails, 
    clearSuggestions: clearAddressSuggestions 
  } = useLocationIQAutocomplete();

  // Business autocomplete hook
  const { 
    suggestions: businessSuggestions, 
    searchBusinesses, 
    clearSuggestions: clearBusinessSuggestions 
  } = useBusinessAutocomplete(businesses);

  // Get current suggestions based on mode
  const currentSuggestions = autocompleteMode === 'business' ? businessSuggestions : addressPredictions;

  // Debounced autocomplete function for addresses
  const debouncedAddressAutocomplete = useCallback(
    debounce((value: string, bounds?: MapBounds, codes?: string) => {
      const options: GeocodingOptions = {};
      
      if (bounds) {
        options.viewbox = {
          minLon: bounds.minLng,
          minLat: bounds.minLat,
          maxLon: bounds.maxLng,
          maxLat: bounds.maxLat
        };
      }
      
      if (codes) {
        options.countrycodes = codes;
      }
      
      getAddressSuggestions(value, Object.keys(options).length > 0 ? options : undefined);
    }, 300),
    [getAddressSuggestions]
  );

  // Debounced autocomplete function for businesses
  const debouncedBusinessAutocomplete = useCallback(
    debounce((value: string) => {
      searchBusinesses(value);
    }, 250),
    [searchBusinesses]
  );

  // Debounced search function
  const debouncedSearch = useCallback(
    debounce((value: string) => {
      if (onSearch) {
        onSearch(value);
      }
    }, 300),
    [onSearch]
  );

  // Cancel any pending debounced calls on unmount or when handlers change
  useEffect(() => {
    return () => {
      debouncedAddressAutocomplete.cancel();
      debouncedBusinessAutocomplete.cancel();
      debouncedSearch.cancel();
    };
  }, [debouncedAddressAutocomplete, debouncedBusinessAutocomplete, debouncedSearch]);

  // Show/hide dropdown based on suggestions
  useEffect(() => {
    setShowDropdown(currentSuggestions.length > 0);
  }, [currentSuggestions]);

  // Click outside to close dropdown
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(event.target as Node)) {
        setShowDropdown(false);
        setSelectedIndex(-1);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (onSearch && searchTerm.trim()) {
      onSearch(searchTerm);
      setShowDropdown(false);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value;
    setSearchTerm(value);
    setSelectedIndex(-1);

    if (value.trim()) {
      if (enableAutocomplete) {
        if (autocompleteMode === 'business') {
          debouncedBusinessAutocomplete(value);
        } else {
          debouncedAddressAutocomplete(value, mapBounds, countrycodes);
        }
      }
      debouncedSearch(value);
    } else {
      if (autocompleteMode === 'business') {
        clearBusinessSuggestions();
      } else {
        clearAddressSuggestions();
      }
      setShowDropdown(false);
      // Box emptied: drop any pending search for the old term and reset the search
      debouncedSearch.cancel();
      if (onSearch) {
        onSearch('');
      }
    }
  };

  const handleAddressPredictionClick = async (placeId: string, description: string) => {
    setSearchTerm(description);
    setShowDropdown(false);
    setSelectedIndex(-1);

    const placeDetails = await getPlaceDetails(placeId);
    if (placeDetails && onPlaceSelect) {
      onPlaceSelect({
        name: placeDetails.name,
        lat: placeDetails.lat,
        lng: placeDetails.lng,
      });
    }

    if (onSearch) {
      onSearch(description);
    }
  };

  const handleBusinessSuggestionClick = (suggestion: BusinessSuggestion) => {
    setSearchTerm(suggestion.name);
    setShowDropdown(false);
    setSelectedIndex(-1);

    if (onBusinessSelect) {
      onBusinessSelect(suggestion);
    }

    if (onPlaceSelect) {
      onPlaceSelect({
        name: suggestion.name,
        lat: suggestion.lat,
        lng: suggestion.lng,
      });
    }

    if (onSearch) {
      onSearch(suggestion.name);
    }
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!showDropdown || currentSuggestions.length === 0) return;

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setSelectedIndex(prev =>
          prev < currentSuggestions.length - 1 ? prev + 1 : prev
        );
        break;
      case 'ArrowUp':
        e.preventDefault();
        setSelectedIndex(prev => (prev > 0 ? prev - 1 : -1));
        break;
      case 'Enter':
        e.preventDefault();
        if (selectedIndex >= 0 && selectedIndex < currentSuggestions.length) {
          if (autocompleteMode === 'business') {
            const suggestion = businessSuggestions[selectedIndex];
            if (suggestion) handleBusinessSuggestionClick(suggestion);
          } else {
            const prediction = addressPredictions[selectedIndex];
            if (prediction) handleAddressPredictionClick(prediction.placeId, prediction.description);
          }
        } else if (searchTerm.trim()) {
          handleSearch(e);
        }
        break;
      case 'Escape':
        setShowDropdown(false);
        setSelectedIndex(-1);
        break;
    }
  };

  return (
    <div ref={dropdownRef} data-search-bar className="relative w-full">
      <form onSubmit={handleSearch}>
        <Input
          ref={inputRef}
          id="searchBarInput"
          name="searchBarInput"
          type="text"
          placeholder={loading ? 'Loading businesses…' : placeholder}
          aria-label="Search businesses"
          value={searchTerm}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          className="w-full h-11 sm:h-11 rounded-full bg-surface-float border-input shadow-float pl-10 pr-4 text-base text-foreground placeholder:text-muted-foreground focus-visible:ring-offset-2"
          autoComplete="off"
        />
        <div className="absolute inset-y-0 left-0 pl-3.5 flex items-center pointer-events-none">
          {loading ? (
            <Loader2 className="h-[18px] w-[18px] text-primary motion-safe:animate-spin" aria-hidden="true" />
          ) : (
            <Search className="h-[18px] w-[18px] text-muted-foreground" />
          )}
        </div>
      </form>
      {/* Always in the page, so the text appearing is what gets announced */}
      <div role="status" className="sr-only">{loading ? 'Loading businesses…' : ''}</div>

      {enableAutocomplete && showDropdown && currentSuggestions.length > 0 && (
        <div className="absolute top-full left-0 right-0 mt-2 bg-popover text-popover-foreground border border-border rounded-lg shadow-lg max-h-[300px] overflow-y-auto z-[2000]">
          {autocompleteMode === 'business' ? (
            // Business suggestions
            businessSuggestions.map((suggestion, index) => (
              <button
                key={suggestion.id}
                type="button"
                onClick={() => handleBusinessSuggestionClick(suggestion)}
                className={cn(
                  "w-full px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground transition-colors flex items-start gap-3 border-b border-border last:border-b-0",
                  selectedIndex === index && "bg-accent text-accent-foreground"
                )}
              >
                <Store className="h-4 w-4 text-primary mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate flex items-center gap-1.5">
                    {suggestion.name}
                    {(suggestion.isVerified || suggestion.isCertified) && (
                      <BadgeCheck className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                    )}
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {suggestion.category}
                    {suggestion.city && ` • ${suggestion.city}`}
                    {suggestion.country && `, ${suggestion.country}`}
                  </div>
                </div>
              </button>
            ))
          ) : (
            // Address predictions
            addressPredictions.map((prediction, index) => (
              <button
                key={prediction.placeId}
                type="button"
                onClick={() => handleAddressPredictionClick(prediction.placeId, prediction.description)}
                className={cn(
                  "w-full px-4 py-3 text-left hover:bg-accent hover:text-accent-foreground transition-colors flex items-start gap-3 border-b border-border last:border-b-0",
                  selectedIndex === index && "bg-accent text-accent-foreground"
                )}
              >
                <MapPin className="h-4 w-4 text-muted-foreground mt-1 flex-shrink-0" />
                <div className="flex-1 min-w-0">
                  <div className="font-medium text-foreground truncate">
                    {prediction.mainText}
                  </div>
                  <div className="text-sm text-muted-foreground truncate">
                    {prediction.secondaryText}
                  </div>
                </div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

export default SearchBar;
