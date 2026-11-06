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

/**
 * Unread messages across all of the user's conversations: as the customer, plus on the
 * businesses they own. 0 when signed out.
 */
export const useUnreadMessagesCount = () => {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();

  const { data = 0 } = useQuery({
    // The user is only in the key so one account's count is never shown to the next
    queryKey: [...UNREAD_MESSAGES_QUERY_KEY, user?.uid ?? null],
    queryFn: async () => {
      // Ownership is checked against the live session's user, never user.uid
      const {
        data: { session },
      } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) return 0;

      // RLS returns only conversations the user is the customer on or owns the business of
      const { data: rows, error } = await supabase
        .from('conversations')
        .select('id, customer_id, customer_unread, business_unread');
      if (error) throw error;
      return (rows ?? []).reduce(
        (total, c) =>
          total +
          ((c.customer_id === userId ? c.customer_unread : c.business_unread) ??
            0),
        0,
      );
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

  return isAuthenticated ? data : 0;
};
