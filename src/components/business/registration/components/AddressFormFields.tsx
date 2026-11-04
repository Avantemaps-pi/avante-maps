import React, { useRef, useState, useEffect } from 'react';
import { FormField, FormItem, FormLabel, FormControl, FormDescription, FormMessage } from '@/components/ui/form';
import { Input } from '@/components/ui/input';
import { useFormContext } from 'react-hook-form';
import { FormValues } from '../formSchema';
import { Building2, MapPinned, Mail, Globe, MapPin, Loader2, Check, ChevronsUpDown } from 'lucide-react';
import { useLocationIQAutocomplete } from '@/hooks/useLocationIQAutocomplete';
import { buildStreetAddress, parseCity } from '../utils/addressParser';
import { getCountryCode, allCountries, commonCountries } from '../utils/countryCodeMapping';
import { useCountryGeolocation } from '@/hooks/useCountryGeolocation';
import { cn } from '@/lib/utils';
import { STEP_LABEL_CLASS } from './stepLabel';
import { Button } from '@/components/ui/button';
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator } from '@/components/ui/command';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';

interface AddressFormFieldsProps {
  disabled?: boolean | undefined;
  /** Registration steps: sentence-case labels without icons, in the steps' label style */
  stepLabels?: boolean | undefined;
  /** Update business: the apartment is edited as part of the street, so there's no Apartment box */
  hideApartment?: boolean | undefined;
}

const AddressFormFields: React.FC<AddressFormFieldsProps> = ({ disabled, stepLabels, hideApartment }) => {
  const form = useFormContext<FormValues>();
  const { predictions, isLoading, getSuggestions, clearSuggestions } = useLocationIQAutocomplete();
  const [showSuggestions, setShowSuggestions] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const timeoutRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [autofillDetected, setAutofillDetected] = useState(false);
  const inputRefs = useRef<{ [key: string]: HTMLInputElement | null }>({});
  const [countryOpen, setCountryOpen] = useState(false);

  // Watch country field to filter address suggestions
  const selectedCountry = form.watch('country');

  // Auto-detect user's country
  const { country: detectedCountry, isLoading: isDetectingCountry } = useCountryGeolocation();

  // Pre-select detected country if form is empty
  useEffect(() => {
    if (detectedCountry && !selectedCountry && !isDetectingCountry) {
      form.setValue('country', detectedCountry, { shouldValidate: true });
    }
  }, [detectedCountry, selectedCountry, isDetectingCountry, form]);

  const handleAddressChange = (value: string) => {
    form.setValue('streetAddress', value);

    if (timeoutRef.current) clearTimeout(timeoutRef.current);

    const trimmedValue = value.trim();
    if (trimmedValue.length < 3) {
      clearSuggestions();
      setShowSuggestions(false);
      return;
    }

    timeoutRef.current = setTimeout(() => {
      // Get country code for filtering
      const countryCode = getCountryCode(selectedCountry);
      
      getSuggestions(trimmedValue, {
        ...(countryCode !== undefined ? { countrycodes: countryCode } : {}),
      });
      setShowSuggestions(true);
    }, 200);
  };

  const handleSuggestionClick = (prediction: typeof predictions[0]) => {
    console.log('📍 Address selected:', prediction);
    console.log('📦 Address object:', prediction.address);
    
    // Build street address using smart parsing
    const streetAddress = buildStreetAddress(prediction);
    console.log('✓ Setting street address:', streetAddress);
    form.setValue('streetAddress', streetAddress, { shouldValidate: true, shouldDirty: true, shouldTouch: true });

    // Parse city with smart logic to avoid municipality names
    const city = parseCity(prediction.address, prediction.description);
    
    if (city) {
      console.log('✓ Setting city:', city);
      form.setValue('city', city, { shouldValidate: true, shouldDirty: true, shouldTouch: true });
    } else {
      console.warn('⚠️ No city found in address');
    }

    // Auto-fill state/province
    const state = prediction.address.state || 
                  prediction.address.province || 
                  prediction.address.region || '';
    
    if (state) {
      console.log('✓ Setting state:', state);
      form.setValue('state', state, { shouldValidate: true, shouldDirty: true, shouldTouch: true });
    } else {
      console.warn('⚠️ No state found in address');
    }

    // Auto-fill postal code
    const postcode = prediction.address.postcode || '';
    
    if (postcode) {
      console.log('✓ Setting postal code:', postcode);
      form.setValue('zipCode', postcode, { shouldValidate: true, shouldDirty: true, shouldTouch: true });
    } else {
      console.warn('⚠️ No postal code found in address');
    }

    // Auto-fill country if not already set or if different
    const country = prediction.address.country || '';
    
    if (country && !selectedCountry) {
      console.log('✓ Setting country:', country);
      form.setValue('country', country, { shouldValidate: true, shouldDirty: true, shouldTouch: true });
    }

    clearSuggestions();
    setShowSuggestions(false);
  };

  // Clear suggestions when country changes
  useEffect(() => {
    clearSuggestions();
    setShowSuggestions(false);
  }, [selectedCountry, clearSuggestions]);

  // Detect browser autofill
  useEffect(() => {
    const detectAutofill = (e: AnimationEvent) => {
      if (e.animationName === 'onAutoFillStart') {
        setAutofillDetected(true);
        setTimeout(() => setAutofillDetected(false), 500);
      }
    };

    Object.values(inputRefs.current).forEach(input => {
      if (input) {
        input.addEventListener('animationstart', detectAutofill as any);
      }
    });

    return () => {
      Object.values(inputRefs.current).forEach(input => {
        if (input) {
          input.removeEventListener('animationstart', detectAutofill as any);
        }
      });
    };
  }, []);

  // Cleanup timeout on unmount
  useEffect(() => () => {
    if (timeoutRef.current) clearTimeout(timeoutRef.current);
  }, []);

  // Click outside to close suggestions
  useEffect(() => {
    const handleClickOutside = (event: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setShowSuggestions(false);
      }
    };

    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  return (
    <div className="space-y-6">
      {/* Country - FIRST for filtering (Searchable Combobox) */}
      <FormField
        control={form.control}
        name="country"
        render={({ field }) => (
          <FormItem className="flex flex-col">
            <FormLabel className={stepLabels ? cn(STEP_LABEL_CLASS, "flex items-center gap-2") : "text-base font-semibold flex items-center gap-2"}>
              {!stepLabels && <Globe className="w-5 h-5 text-primary" />}
              Country
              {isDetectingCountry && (
                <Loader2 className="w-4 h-4 animate-spin text-muted-foreground" />
              )}
            </FormLabel>
            <Popover open={countryOpen} onOpenChange={setCountryOpen}>
              <PopoverTrigger asChild>
                <FormControl>
                  <Button
                    variant="outline"
                    role="combobox"
                    aria-expanded={countryOpen}
                    disabled={disabled}
                    className={cn(
                      "h-11 sm:h-10 w-full justify-between rounded-xl border-2 hover:bg-transparent",
                      !field.value && "text-muted-foreground"
                    )}
                  >
                    {field.value || "Select your country first..."}
                    <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
                  </Button>
                </FormControl>
              </PopoverTrigger>
              <PopoverContent className="w-full p-0 bg-background border border-border" align="start">
                <Command>
                  <CommandInput placeholder="Search countries..." />
                  <CommandList className="max-h-80">
                    <CommandEmpty>No country found.</CommandEmpty>
                    <CommandGroup heading="Popular">
                      {commonCountries.map((country) => (
                        <CommandItem
                          key={`common-${country.code}`}
                          value={country.name}
                          onSelect={() => {
                            field.onChange(country.name);
                            setCountryOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              field.value === country.name ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {country.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                    <CommandSeparator />
                    <CommandGroup heading="All Countries">
                      {allCountries.map((country) => (
                        <CommandItem
                          key={`all-${country.code}`}
                          value={country.name}
                          onSelect={() => {
                            field.onChange(country.name);
                            setCountryOpen(false);
                          }}
                        >
                          <Check
                            className={cn(
                              "mr-2 h-4 w-4",
                              field.value === country.name ? "opacity-100" : "opacity-0"
                            )}
                          />
                          {country.name}
                        </CommandItem>
                      ))}
                    </CommandGroup>
                  </CommandList>
                </Command>
              </PopoverContent>
            </Popover>
            <FormMessage />
            {selectedCountry && (
              <p className="text-sm text-muted-foreground mt-1">
                Address search will be filtered to {selectedCountry}
              </p>
            )}
          </FormItem>
        )}
      />

      {/* Street Address with Autocomplete */}
      <div className="relative" ref={containerRef}>
        <FormField
          control={form.control}
          name="streetAddress"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={stepLabels ? STEP_LABEL_CLASS : "text-base font-semibold flex items-center gap-2"}>
                {!stepLabels && <MapPin className="w-5 h-5 text-primary" />}
                {stepLabels ? 'Street address' : 'Street Address'}
              </FormLabel>
              <FormControl>
                <Input
                  id="streetAddress"
                  placeholder={selectedCountry 
                    ? `Search for an address in ${selectedCountry}...` 
                    : "Select a country first to search addresses..."}
                  {...field}
                  ref={(el) => {
                    inputRefs.current['streetAddress'] = el;
                    field.ref(el);
                  }}
                  onChange={(e) => {
                    if (!autofillDetected) {
                      handleAddressChange(e.target.value);
                    }
                  }}
                  onFocus={() => predictions.length > 0 && setShowSuggestions(true)}
                  disabled={disabled}
                  autoComplete="address-line1"
                  className="h-11 sm:h-10 rounded-xl border-2 focus:border-primary transition-colors"
                />
              </FormControl>
              <FormMessage />

              {/* Autocomplete Suggestions */}
              {showSuggestions && predictions.length > 0 && (
                <div className="absolute z-50 w-full mt-1 bg-background border border-border rounded-lg shadow-lg max-h-80 overflow-auto">
                  {predictions.map((prediction, index) => (
                    <button
                      key={prediction.placeId || index}
                      type="button"
                      className="w-full px-4 py-3 text-left hover:bg-muted transition-colors border-b border-border last:border-b-0 flex items-start gap-3"
                      onClick={() => handleSuggestionClick(prediction)}
                    >
                      <span className="text-muted-foreground mt-0.5 flex-shrink-0">
                        📍
                      </span>
                      <div className="flex-1 min-w-0">
                        <div className="font-medium text-foreground truncate">
                          {prediction.mainText}
                        </div>
                        <div className="text-sm text-muted-foreground truncate">
                          {prediction.secondaryText}
                        </div>
                      </div>
                    </button>
                  ))}
                </div>
              )}

              {/* Loading indicator */}
              {isLoading && (
                <div className="absolute right-3 top-12 transform -translate-y-1/2">
                  <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
                </div>
              )}

              {hideApartment && (
                <FormDescription className={cn("text-[13px] leading-[18px]", showSuggestions && predictions.length > 0 && "invisible")}>
                  Include the apartment, suite or unit here, e.g. 12 Dock Road, Unit 4
                </FormDescription>
              )}
            </FormItem>
          )}
        />
      </div>

      {/* Apartment/Unit (Optional) */}
      {!hideApartment && (
        <FormField
          control={form.control}
          name="apartment"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={stepLabels ? STEP_LABEL_CLASS : "text-base font-semibold flex items-center gap-2"}>
                {!stepLabels && <Building2 className="w-5 h-5 text-primary" />}
                {stepLabels ? 'Apartment, suite or unit (optional)' : 'Apartment, Suite, Unit (Optional)'}
              </FormLabel>
              <FormControl>
                <Input
                  id="apartment"
                  placeholder="e.g., Suite 100, Unit 5B, Apt 2A"
                  {...field}
                  ref={(el) => {
                    inputRefs.current['apartment'] = el;
                    field.ref(el);
                  }}
                  disabled={disabled}
                  autoComplete="address-line2"
                  className="h-11 sm:h-10 rounded-xl border-2 focus:border-primary transition-colors"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      )}

      {/* City, Province, Postal Code in Grid */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {/* City */}
        <FormField
          control={form.control}
          name="city"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={stepLabels ? STEP_LABEL_CLASS : "text-base font-semibold flex items-center gap-2"}>
                {!stepLabels && <MapPinned className="w-5 h-5 text-primary" />}
                City
              </FormLabel>
              <FormControl>
                <Input
                  id="city"
                  placeholder="e.g., Toronto"
                  {...field}
                  ref={(el) => {
                    inputRefs.current['city'] = el;
                    field.ref(el);
                  }}
                  disabled={disabled}
                  autoComplete="address-level2"
                  className="h-11 sm:h-10 rounded-xl border-2 focus:border-primary transition-colors"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Province/State */}
        <FormField
          control={form.control}
          name="state"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={stepLabels ? STEP_LABEL_CLASS : "text-base font-semibold flex items-center gap-2"}>
                {!stepLabels && <MapPinned className="w-5 h-5 text-primary" />}
                {stepLabels ? 'Province or state' : 'Province/State'}
              </FormLabel>
              <FormControl>
                <Input
                  id="state"
                  placeholder="e.g., ON"
                  {...field}
                  ref={(el) => {
                    inputRefs.current['state'] = el;
                    field.ref(el);
                  }}
                  disabled={disabled}
                  autoComplete="address-level1"
                  className="h-11 sm:h-10 rounded-xl border-2 focus:border-primary transition-colors"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />

        {/* Postal Code */}
        <FormField
          control={form.control}
          name="zipCode"
          render={({ field }) => (
            <FormItem>
              <FormLabel className={stepLabels ? STEP_LABEL_CLASS : "text-base font-semibold flex items-center gap-2"}>
                {!stepLabels && <Mail className="w-5 h-5 text-primary" />}
                {stepLabels ? 'Postal code' : 'Postal Code'}
              </FormLabel>
              <FormControl>
                <Input
                  id="zipCode"
                  placeholder="e.g., M5H 2N2"
                  {...field}
                  ref={(el) => {
                    inputRefs.current['zipCode'] = el;
                    field.ref(el);
                  }}
                  disabled={disabled}
                  autoComplete="postal-code"
                  className="h-11 sm:h-10 rounded-xl border-2 focus:border-primary transition-colors"
                />
              </FormControl>
              <FormMessage />
            </FormItem>
          )}
        />
      </div>
    </div>
  );
};

export default AddressFormFields;
