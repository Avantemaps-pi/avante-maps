import { Business, BusinessContactInfo, BusinessHours } from '@/types/business';

// Everything the Your businesses page and the edit form need. contact_info, hours,
// pi_wallet_address and notify_new_message_email must stay here: the edit form fills its fields
// from them and saves them back.
export const OWNED_BUSINESS_COLUMNS = 'id, business_name, owner_id, category, business_description, city, country, images, is_verified, is_certified, verification_status, is_active, created_at, lat, lng, business_types, keywords, location, street_address, state, zip_code, coordinates, contact_info, hours, pi_wallet_address, notify_new_message_email, contact_email_verified_for';

export interface OwnedBusinessRow {
  id: number;
  business_name: string;
  business_description?: string | null;
  location?: string | null;
  category?: string | null;
  street_address?: string | null;
  city?: string | null;
  state?: string | null;
  zip_code?: string | null;
  country?: string | null;
  business_types?: string[] | null;
  keywords?: string[] | null;
  images?: string[] | null;
  lat?: number | null;
  lng?: number | null;
  coordinates?: string | null;
  is_certified?: boolean | null;
  is_verified?: boolean | null;
  verification_status?: string | null;
  // undefined means the column wasn't loaded; null means the business has none
  contact_info?: unknown;
  hours?: unknown;
  pi_wallet_address?: string | null;
  notify_new_message_email?: boolean | null;
  contact_email_verified_for?: string | null;
}

/** The Business the Your businesses page and the edit form work with */
export function toOwnedBusiness(row: OwnedBusinessRow): Business {
  const address = [row.street_address, row.city, row.state, row.zip_code, row.country].filter(Boolean).join(', ');
  return {
    id: row.id,
    name: row.business_name,
    address: address || row.location || '',
    description: row.business_description || '',
    isCertified: !!row.is_certified,
    isVerified: !!row.is_verified,
    verificationStatus: row.verification_status as Business['verificationStatus'],
    streetAddress: row.street_address,
    city: row.city,
    state: row.state,
    zipCode: row.zip_code,
    country: row.country,
    businessTypes: row.business_types,
    keywords: row.keywords,
    category: row.category,
    coordinates: row.coordinates,
    images: row.images,
    lat: row.lat,
    lng: row.lng,
    // Left out when not loaded, so nothing mistakes "not loaded" for "empty"
    ...(row.contact_info !== undefined ? { contactInfo: (row.contact_info ?? {}) as BusinessContactInfo } : {}),
    ...(row.hours !== undefined ? { hours: (row.hours ?? {}) as BusinessHours } : {}),
    ...(row.pi_wallet_address !== undefined ? { piWalletAddress: row.pi_wallet_address ?? '' } : {}),
    ...(row.notify_new_message_email !== undefined ? { notifyNewMessageEmail: row.notify_new_message_email ?? true } : {}),
    ...(row.contact_email_verified_for !== undefined ? { contactEmailVerifiedFor: row.contact_email_verified_for } : {}),
  } as Business;
}

/** Whether the edit form can safely open on this business without losing stored details */
export const isBusinessComplete = (business: Business) =>
  business.contactInfo !== undefined &&
  business.hours !== undefined &&
  business.piWalletAddress !== undefined &&
  business.notifyNewMessageEmail !== undefined;
