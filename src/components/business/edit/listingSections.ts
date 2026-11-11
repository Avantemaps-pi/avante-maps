import {
  Store,
  MapPin,
  Phone,
  Clock,
  ImageIcon,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { Business } from '@/types/business';
import { FormValues, daysOfWeek } from '../registration/formSchema';
import { formatHours } from '../formatHours';

export type ListingSectionId =
  'name' | 'address' | 'contact' | 'hours' | 'photos' | 'wallet';

export interface ListingSection {
  id: ListingSectionId;
  title: string;
  icon: LucideIcon;
  /** The form fields this section edits, and validates on Save */
  fields: Array<keyof FormValues>;
}

// In the overview's order. The id is the sub-route: /update-registration/$businessId/$id
export const LISTING_SECTIONS: ListingSection[] = [
  {
    id: 'name',
    title: 'Name and category',
    icon: Store,
    fields: ['businessName', 'businessTypes'],
  },
  {
    id: 'address',
    title: 'Address',
    icon: MapPin,
    fields: ['streetAddress', 'city', 'state', 'zipCode', 'country'],
  },
  {
    id: 'contact',
    title: 'Contact',
    icon: Phone,
    fields: [
      'countryCode',
      'phone',
      'email',
      'website',
      'notifyNewMessageEmail',
    ],
  },
  {
    id: 'hours',
    title: 'Hours',
    icon: Clock,
    fields: daysOfWeek.flatMap(
      (day) => [day.open, day.close, day.closed] as Array<keyof FormValues>,
    ),
  },
  {
    id: 'photos',
    title: 'Photos and description',
    icon: ImageIcon,
    fields: ['businessDescription'],
  },
  {
    id: 'wallet',
    title: 'Payout wallet',
    icon: Wallet,
    fields: ['piWalletAddress'],
  },
];

export const findListingSection = (id: string | undefined) =>
  LISTING_SECTIONS.find((section) => section.id === id);

// Old deep links (?field=…, e.g. from Wallet and the payout-wallet notification) open that field's section
export const sectionForField = (
  field: string | null,
): ListingSectionId | undefined => {
  if (!field) return undefined;
  if (field === 'pi_wallet_address') return 'wallet';
  return LISTING_SECTIONS.find((section) =>
    section.fields.some((name) => name === field),
  )?.id;
};

export const listingStatus = (business: Business) =>
  business.isCertified
    ? 'Certified'
    : business.isVerified
      ? 'Verified'
      : 'Not verified yet';

/** First 4 and last 4 characters, e.g. GBRP…OX2H */
export const shortWallet = (address: string) =>
  address.length > 12 ? `${address.slice(0, 4)}…${address.slice(-4)}` : address;

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

const hoursSummary = (hours: Business['hours']) => {
  const asText: Record<string, string> = {};
  for (const [day, value] of Object.entries(hours ?? {})) {
    if (!value) continue;
    asText[day] = value.closed
      ? 'closed'
      : value.open && value.close
        ? `${value.open}-${value.close}`
        : '';
  }
  const groups = formatHours(asText);
  if (groups.length === 0) return 'Not set';
  return groups
    .map((group) =>
      group.hours === 'closed'
        ? `Closed ${group.days}`
        : `${group.days} ${group.hours}`,
    )
    .join(' · ');
};

const contactSummary = (business: Business) => {
  const info = business.contactInfo ?? {};
  const email = (info.email ?? '').trim();
  const emailConfirmed =
    !!email && business.contactEmailVerifiedFor === email.toLowerCase();
  const parts = [
    info.phone ? 'Phone' : null,
    email ? (emailConfirmed ? 'Email verified' : 'Email') : null,
    info.website ? 'Website' : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(' · ') : 'Not set';
};

/** The one-line summary of a section's current values, as stored */
export const sectionSummary = (
  id: ListingSectionId,
  business: Business,
): string => {
  switch (id) {
    case 'name': {
      const kind =
        business.category || (business.businessTypes ?? []).join(', ');
      return kind ? `${business.name} · ${kind}` : business.name;
    }
    case 'address':
      return (
        [business.streetAddress, business.city].filter(Boolean).join(', ') ||
        'Not set'
      );
    case 'contact':
      return contactSummary(business);
    case 'hours':
      return hoursSummary(business.hours);
    case 'photos': {
      const photos = (business.images ?? []).length;
      const words = (business.description ?? '')
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      return `${photos === 0 ? 'No photos' : plural(photos, 'photo')} · ${plural(words, 'word')}`;
    }
    case 'wallet':
      return business.piWalletAddress
        ? shortWallet(business.piWalletAddress)
        : 'Not set';
  }
};
