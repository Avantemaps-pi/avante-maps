import { useEffect } from 'react';
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import type { RealtimeChannel } from '@supabase/supabase-js';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth';

export const UNREAD_MESSAGES_QUERY_KEY = ['unread-messages-count'];

// "9+" above 9
export const formatUnreadCount = (count: number) =>
  count > 9 ? '9+' : String(count);

// One realtime channel and one visibility listener, however many components use the hook
let channel: RealtimeChannel | null = null;
let listeners = 0;
let refetchTimer: ReturnType<typeof setTimeout> | null = null;
let onVisibilityChange: (() => void) | null = null;

const startLive = (queryClient: QueryClient) => {
  listeners += 1;
  if (channel) return;
  const refetch = () => {
    void queryClient.invalidateQueries({ queryKey: UNREAD_MESSAGES_QUERY_KEY });
  };
  // Several changes in a row (a message bumps the conversation twice) refetch once
  const refetchSoon = () => {
    if (refetchTimer) clearTimeout(refetchTimer);
    refetchTimer = setTimeout(() => {
      refetchTimer = null;
      refetch();
    }, 500);
  };
  // removeChannel only drops a channel once the server confirms, so each one gets a new name
  const suffix = Math.random().toString(36).slice(2);
  channel = supabase
    .channel(`unread-messages-${suffix}`)
    .on(
      'postgres_changes',
      { event: 'INSERT', schema: 'public', table: 'conversations' },
      refetchSoon,
    )
    .on(
      'postgres_changes',
      { event: 'UPDATE', schema: 'public', table: 'conversations' },
      refetchSoon,
    )
    .subscribe();
  onVisibilityChange = () => {
    if (document.visibilityState === 'visible') refetch();
  };
  document.addEventListener('visibilitychange', onVisibilityChange);
};

const stopLive = () => {
  listeners = Math.max(0, listeners - 1);
  if (listeners > 0) return;
  if (channel) void supabase.removeChannel(channel);
  channel = null;
  if (refetchTimer) clearTimeout(refetchTimer);
  refetchTimer = null;
  if (onVisibilityChange)
    document.removeEventListener('visibilitychange', onVisibilityChange);
  onVisibilityChange = null;
};

export interface UnreadMessageCounts {
  /** Everything: the user's own conversations plus their businesses' */
  total: number;
  /** customer_unread on conversations the user started ("My messages") */
  customer: number;
  /** business_unread per business the user owns, by business id */
  byBusiness: Record<number, number>;
}

const NO_UNREAD: UnreadMessageCounts = {
  total: 0,
  customer: 0,
  byBusiness: {},
};

/**
 * Unread messages per inbox: as the customer, and on each business the user owns. Both sides
 * count on a conversation with their own business. All zero when signed out.
 */
export const useUnreadMessageCounts = (): UnreadMessageCounts => {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();

  const { data = NO_UNREAD } = useQuery({
    // The user is only in the key so one account's count is never shown to the next
    queryKey: [...UNREAD_MESSAGES_QUERY_KEY, user?.uid ?? null],
    queryFn: async (): Promise<UnreadMessageCounts> => {
      // Ownership is checked against the live session's user, never user.uid
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) return NO_UNREAD;

      // RLS returns only conversations the user is the customer on or owns the business of
      const [conversations, owned] = await Promise.all([
        supabase
          .from('conversations')
          .select(
            'id, business_id, customer_id, customer_unread, business_unread',
          ),
        supabase.from('businesses').select('id').eq('owner_id', userId),
      ]);
      if (conversations.error) throw conversations.error;
      if (owned.error) throw owned.error;

      const byBusiness: Record<number, number> = {};
      for (const b of owned.data ?? []) byBusiness[b.id] = 0;
      let customer = 0;
      for (const c of conversations.data ?? []) {
        if (c.customer_id === userId) customer += c.customer_unread ?? 0;
        if (c.business_id in byBusiness)
          byBusiness[c.business_id] =
            (byBusiness[c.business_id] ?? 0) + (c.business_unread ?? 0);
      }
      const total =
        customer + Object.values(byBusiness).reduce((n, count) => n + count, 0);
      return { total, customer, byBusiness };
    },
    enabled: isAuthenticated,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  useEffect(() => {
    if (!isAuthenticated) return;
    startLive(queryClient);
    return stopLive;
  }, [isAuthenticated, queryClient]);

  return isAuthenticated ? data : NO_UNREAD;
};

/** All unread messages, for the nav and Messages-tab badges. 0 when signed out */
export const useUnreadMessagesCount = () => useUnreadMessageCounts().total;
