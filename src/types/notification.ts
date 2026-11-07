export type NotificationType = 
  | 'message' 
  | 'review' 
  | 'business' 
  | 'follower' 
  | 'like'
  | 'verification'
  | 'certification'
  | 'payment'
  | 'bookmark'
  | 'system';

export type NotificationPriority = 'low' | 'medium' | 'high';

export interface NotificationMetadata {
  /** What the notification is about (see src/utils/notificationKinds.ts); older rows have none */
  kind?: string;
  businessId?: number;
  businessName?: string;
  conversationId?: string;
  /** The label of the action link to click_url */
  actionLabel?: string;
  /** The same news was also sent by email */
  emailed?: boolean;
  userName?: string;
  rating?: number;
  status?: 'pending' | 'approved' | 'rejected' | 'verified' | 'certified';
  amount?: number;
  viewCount?: number;
  actionUrl?: string;
  tier?: string;
  date?: string;
  featureName?: string;
  count?: number;
}

export interface NotificationProps {
  id: string;
  type: NotificationType;
  content: string;
  time: string;
  read: boolean;
  metadata?: NotificationMetadata;
  created_at?: string;
  priority: NotificationPriority;
  /** The action's in-app path */
  click_url?: string | null;
}
