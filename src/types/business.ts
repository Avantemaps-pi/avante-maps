export interface BusinessContactInfo {
  first_name?: string;
  last_name?: string;
  phone?: string;
  email?: string;
  website?: string;
}

export interface BusinessHours {
  [day: string]: {
    open: string;
    close: string;
    closed: boolean;
  };
}

export interface Business {
  id: number;
  name: string;
  address: string;
  description: string;
  isCertified: boolean;
  isVerified?: boolean;
  verificationStatus?: 'pending' | 'verified' | 'rejected';
  // Extended fields from database
  streetAddress?: string;
  city?: string;
  state?: string;
  zipCode?: string;
  country?: string;
  businessTypes?: string[];
  keywords?: string[];
  category?: string;
  coordinates?: string;
  contactInfo?: BusinessContactInfo;
  hours?: BusinessHours;
  piWalletAddress?: string;
  /** Email the owner when a customer messages the business (undefined when not loaded) */
  notifyNewMessageEmail?: boolean;
  /** The contact email confirmed through CommuniCon, lower-cased (null when none) */
  contactEmailVerifiedFor?: string | null;
  images?: string[];
  lat?: number;
  lng?: number;
}

export interface Place {
  id: string;
  name: string;
  position: {
    lat: number;
    lng: number;
  };
  address: string;
  rating: number;
  totalReviews?: number | undefined;
  category: string;
  description: string;
  image?: string | undefined;
  images?: string[] | undefined;
  website?: string | undefined;
  phone?: string | undefined;
  email?: string | undefined;
  hours?: {
    [key: string]: string;
  } | undefined;
  isVerified?: boolean | undefined;
  isCertified?: boolean | undefined;
  verificationStatus?: 'pending' | 'verified' | 'rejected' | null | undefined;
  business_types?: string[] | undefined;
  keywords?: string[] | undefined;
  isUserBusiness?: boolean | undefined;
  location?: {
    lat: number;
    lng: number;
  } | undefined;
  // Enhanced address fields
  streetAddress?: string | undefined;
  city?: string | undefined;
  state?: string | undefined;
  postalCode?: string | undefined;
  country?: string | undefined;
  // Search relevance
  distance?: number | undefined; // Distance in meters from search point
  relevance?: number | undefined; // Search relevance score
}
