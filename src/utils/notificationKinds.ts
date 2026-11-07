import {
  AlertCircle,
  Award,
  Bell,
  CalendarX,
  Clock,
  Coins,
  EyeOff,
  Mail,
  MessageSquare,
  ShieldAlert,
  ShieldCheck,
  Star,
  Store,
  Wallet,
  type LucideIcon,
} from 'lucide-react';
import { NotificationProps, NotificationType } from '@/types/notification';

// What a notification is about. metadata.kind is written by the server for new rows; older rows
// have only a type, mapped below. Anything unknown is a generic row.
export type NotificationKind =
  | 'new_message'
  | 'payout_wallet_changed'
  | 'contact_email_changed'
  | 'plan_ending'
  | 'plan_ended'
  | 'listing_deactivated'
  | 'verified'
  | 'certified'
  | 'new_review'
  | 'topup_received'
  | 'plan_paid'
  | 'plan_not_activated'
  | 'business_registered'
  | 'generic';

export type NotificationTint = 'primary' | 'muted' | 'destructive';

interface KindConfig {
  icon: LucideIcon;
  tint: NotificationTint;
  /** The action's label when metadata.actionLabel is missing but there's a click_url */
  defaultAction: string;
}

const KINDS: Record<NotificationKind, KindConfig> = {
  new_message: { icon: MessageSquare, tint: 'primary', defaultAction: 'Reply' },
  payout_wallet_changed: {
    icon: ShieldAlert,
    tint: 'primary',
    defaultAction: 'Check payout wallet',
  },
  contact_email_changed: {
    icon: Mail,
    tint: 'muted',
    defaultAction: 'Confirm email',
  },
  plan_ending: { icon: Clock, tint: 'primary', defaultAction: 'Renew plan' },
  plan_ended: {
    icon: CalendarX,
    tint: 'primary',
    defaultAction: 'Choose a plan',
  },
  listing_deactivated: {
    icon: EyeOff,
    tint: 'muted',
    defaultAction: 'Choose which stays',
  },
  verified: {
    icon: ShieldCheck,
    tint: 'primary',
    defaultAction: 'View verification',
  },
  certified: {
    icon: Award,
    tint: 'primary',
    defaultAction: 'View certification',
  },
  new_review: { icon: Star, tint: 'primary', defaultAction: 'Reply to review' },
  topup_received: {
    icon: Wallet,
    tint: 'primary',
    defaultAction: 'Open wallet',
  },
  plan_paid: { icon: Coins, tint: 'primary', defaultAction: 'Open wallet' },
  plan_not_activated: {
    icon: AlertCircle,
    tint: 'destructive',
    defaultAction: 'Contact support',
  },
  business_registered: {
    icon: Store,
    tint: 'muted',
    defaultAction: 'View business',
  },
  generic: { icon: Bell, tint: 'primary', defaultAction: 'Open' },
};

const TYPE_TO_KIND: Partial<Record<NotificationType, NotificationKind>> = {
  business: 'business_registered',
  payment: 'plan_paid',
  verification: 'verified',
  certification: 'certified',
  message: 'new_message',
  review: 'new_review',
};

const isKind = (value: unknown): value is NotificationKind =>
  typeof value === 'string' && value in KINDS && value !== 'generic';

const metadataOf = (
  notification: NotificationProps,
): Record<string, unknown> =>
  typeof notification.metadata === 'object' && notification.metadata !== null
    ? (notification.metadata as Record<string, unknown>)
    : {};

const text = (value: unknown) =>
  typeof value === 'string' && value.trim() ? value.trim() : null;

export const getNotificationKind = (
  notification: NotificationProps,
): NotificationKind => {
  const kind = metadataOf(notification)['kind'];
  if (isKind(kind)) return kind;
  return TYPE_TO_KIND[notification.type] ?? 'generic';
};

export const getKindConfig = (kind: NotificationKind) => KINDS[kind];

/** The person (for messages and reviews) or business the notification is about, if known */
export const getNotificationName = (
  notification: NotificationProps,
): string | null => {
  const metadata = metadataOf(notification);
  return text(metadata['userName']) ?? text(metadata['businessName']);
};

/** The action under the text: needs a click_url; the label is the server's, else the kind's */
export const getNotificationAction = (
  notification: NotificationProps,
): { label: string; url: string } | null => {
  const url = text(notification.click_url);
  if (!url) return null;
  const label =
    text(metadataOf(notification)['actionLabel']) ??
    KINDS[getNotificationKind(notification)].defaultAction;
  return { label, url };
};

export const wasAlsoEmailed = (notification: NotificationProps) =>
  metadataOf(notification)['emailed'] === true;

const ACTIVITY_KINDS: NotificationKind[] = ['new_message', 'new_review'];
// Generic rows keep the tab their type had before kinds: followers and likes are activity
const ACTIVITY_TYPES: NotificationType[] = ['follower', 'like'];

export const isActivityNotification = (notification: NotificationProps) => {
  const kind = getNotificationKind(notification);
  return kind === 'generic'
    ? ACTIVITY_TYPES.includes(notification.type)
    : ACTIVITY_KINDS.includes(kind);
};
