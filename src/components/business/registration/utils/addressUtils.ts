import { supabase } from '@/integrations/supabase/client';

export interface AddressSuggestion {
  display_name: string;
  lat: number;
  lon: number;
  address: {
    house_number: string;
    road: string;
    city: string;
    state: string;
    postcode: string;
    country: string;
  };
}

/**
 * Fetches address suggestions from the supabase edge function
 * using the logged-in user's JWT for authentication.
 */
export const fetchAddressSuggestions = async (query: string): Promise<AddressSuggestion[]> => {
  if (query.length < 3) return [];

  try {
    // Get current session & JWT
    const { data: sessionData } = await supabase.auth.getSession();
    const token = sessionData?.session?.access_token;

    if (!token) {
      console.error('User not logged in. Cannot fetch address suggestions.');
      return [];
    }

    const { data, error } = await supabase.functions.invoke('geocode-address', {
      body: { address: query },
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (error) {
      console.error('Error fetching address suggestions:', error);
      return [];
    }

    if (!data?.suggestions || !Array.isArray(data.suggestions)) {
      console.warn('No suggestions returned from geocode-address function.');
      return [];
    }

    // Optional debug logging
    console.log('Fetched suggestions:', data.suggestions);

    return data.suggestions;
  } catch (err) {
    console.error('Error calling geocode function:', err);
    return [];
  }
};

/** The one-line address registration and the edit form send to the geocoder */
export const formatFullAddress = (values: {
  streetAddress: string;
  apartment?: string | undefined;
  city: string;
  state: string;
  zipCode: string;
  country: string;
}) =>
  `${values.streetAddress}${values.apartment ? `, ${values.apartment}` : ''}, ${values.city}, ${values.state}, ${values.zipCode}, ${values.country}`;

/** The position of an address (the geocode-address function, which applies the rate limit), or null */
export const geocodeAddress = async (address: string) => {
  try {
    const { data, error } = await supabase.functions.invoke('geocode-address', {
      body: { address }
    });
    if (error) {
      console.error('Error geocoding address:', error);
      return null;
    }
    if (data?.suggestions?.length > 0) {
      const firstResult = data.suggestions[0];
      return { lat: firstResult.lat, lng: firstResult.lon, address_components: firstResult.address };
    }
    return null;
  } catch (err) {
    console.error('Geocode error:', err);
    return null;
  }
};
