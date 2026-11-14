import { PlacePrediction } from '@/hooks/useLocationIQAutocomplete';

/**
 * Extract house number from a search query string
 * @param query - The original search query (e.g., "12 Example Street")
 * @returns The extracted house number or empty string
 */
export const extractHouseNumber = (query: string): string => {
  const match = query.match(/^\d+[\w-]*/);
  return match ? match[0] : '';
};

/**
 * Parse city name intelligently to avoid administrative divisions
 * @param address - The address object from LocationIQ
 * @param displayName - The full display_name string from LocationIQ
 * @returns The parsed city name
 */
export const parseCity = (address: any, displayName: string): string => {
  const rawCity = address.city || address.town || address.village || '';
  
  // If city contains administrative terms, try to extract actual city name from display_name
  if (rawCity.includes('Municipality') || rawCity.includes('District') || rawCity.includes('Metropolitan')) {
    const parts = displayName.split(',').map(p => p.trim());
    // Look for a part that doesn't contain administrative terms
    const cityPart = parts.find(p => 
      !p.includes('Municipality') && 
      !p.includes('District') &&
      !p.includes('Metropolitan') &&
      !p.includes('Ward') &&
      p.length > 0 &&
      p.length < 50 &&
      !p.match(/^\d/) // Don't pick parts starting with numbers
    );
    if (cityPart) return cityPart;
  }
  
  return rawCity;
};

/**
 * Build complete street address from prediction and original query
 * @param prediction - The address prediction from LocationIQ
 * @returns The complete street address string
 */
export const buildStreetAddress = (prediction: PlacePrediction): string => {
  // Extract house number from original query
  const houseNumber = prediction.originalQuery ? extractHouseNumber(prediction.originalQuery) : '';
  const road = prediction.address.road || '';
  
  // Combine house number with road if we have both
  if (houseNumber && road) {
    return `${houseNumber} ${road}`;
  } else if (prediction.address.house_number && road) {
    return `${prediction.address.house_number} ${road}`;
  } else if (road) {
    return road;
  }
  
  return prediction.mainText;
};
