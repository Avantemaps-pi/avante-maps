import { SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

interface CreateNotificationParams {
  userId: string;
  type: NotificationType;
  content: string;
  metadata?: Record<string, unknown>;
  priority?: NotificationPriority;
  /** The in-app path the notification's action opens */
  clickUrl?: string;
}

// The plans' display names, for notices (never the slug)
export const PLAN_NAMES: Record<string, string> = {
  individual: 'Individual',
  'small-business': 'Small Business',
  organization: 'Organization',
};
export const planName = (tier: string) => PLAN_NAMES[tier] ?? tier;

/**
 * Creates a notification in the database
 * Should be called with a service role client for server-side notification creation
 */
export async function createNotification(
  supabase: SupabaseClient,
  params: CreateNotificationParams
): Promise<{ success: boolean; error?: string }> {
  const {
    userId,
    type,
    content,
    metadata = {},
    priority = 'medium',
    clickUrl,
  } = params;

  try {
    const { error } = await supabase
      .from('notifications')
      .insert({
        user_id: userId,
        type,
        content,
        metadata,
        priority,
        read: false,
        delivery_status: 'delivered',
        delivered_at: new Date().toISOString(),
        ...(clickUrl ? { click_url: clickUrl } : {}),
      });

    if (error) {
      console.error('Failed to create notification:', error);
      return { success: false, error: error.message };
    }

    console.log(`Notification created for user ${userId}: ${type}`);
    return { success: true };
  } catch (err) {
    const errorMessage = err instanceof Error ? err.message : 'Unknown error';
    console.error('Error creating notification:', errorMessage);
    return { success: false, error: errorMessage };
  }
}

/**
 * Helper to create a business-related notification
 */
export async function createBusinessNotification(
  supabase: SupabaseClient,
  userId: string,
  businessName: string,
  eventType: 'registered' | 'verified' | 'certified'
): Promise<{ success: boolean; error?: string }> {
  const messages: Record<string, { content: string; type: NotificationType; priority: NotificationPriority }> = {
    registered: {
      content: `Your business "${businessName}" has been successfully registered and is now listed on Avante Maps!`,
      type: 'business',
      priority: 'medium',
    },
    verified: {
      content: `Congratulations! Your business "${businessName}" has been verified. You now have a verified badge.`,
      type: 'verification',
      priority: 'high',
    },
    certified: {
      content: `Amazing! Your business "${businessName}" has been certified. You now have a certified badge!`,
      type: 'certification',
      priority: 'high',
    },
  };

  const { content, type, priority } = messages[eventType];

  return createNotification(supabase, {
    userId,
    type,
    content,
    metadata: { businessName, status: eventType },
    priority,
  });
}

/**
 * A payment from the user's Avante Maps balance (nothing was received: the user paid). A plan
 * gets kind plan_paid and View plan, like complete-payment's plan notice; anything else
 * balance_paid and Open wallet
 */
export function createBalancePaymentNotification(
  supabase: SupabaseClient,
  userId: string,
  amountPi: number,
  subscriptionTier?: string,
): Promise<{ success: boolean; error?: string }> {
  const paid = `${amountPi.toFixed(2)} π was paid from your Avante Maps balance.`;
  if (subscriptionTier) {
    return createNotification(supabase, {
      userId,
      type: 'payment',
      content: `Your ${planName(subscriptionTier)} plan is active. ${paid}`,
      metadata: {
        kind: 'plan_paid',
        tier: subscriptionTier,
        amount: amountPi,
        actionLabel: 'View plan',
      },
      priority: 'high',
      clickUrl: '/pricing',
    });
  }
  return createNotification(supabase, {
    userId,
    type: 'payment',
    content: paid.charAt(0).toUpperCase() + paid.slice(1),
    metadata: {
      kind: 'balance_paid',
      amount: amountPi,
      actionLabel: 'Open wallet',
    },
    priority: 'high',
    clickUrl: '/wallet',
  });
}
