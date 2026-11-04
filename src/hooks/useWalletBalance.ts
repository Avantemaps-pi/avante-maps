import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth';

export const WALLET_BALANCE_QUERY_KEY = ['wallet-balance'];

export const useWalletBalance = () => {
  const { isAuthenticated } = useAuth();

  const { data: balance = 0, isLoading, isError, refetch } = useQuery({
    queryKey: WALLET_BALANCE_QUERY_KEY,
    queryFn: async () => {
      // Always read a fresh session user — never a stale context value.
      const { data: { user: sessionUser }, error: sessionErr } = await supabase.auth.getUser();
      if (sessionErr || !sessionUser) return 0;

      const { data, error } = await supabase.rpc('get_wallet_balance', {
        p_user_id: sessionUser.id,
      });
      if (error) throw error;
      return typeof data === 'number' ? data : 0;
    },
    enabled: isAuthenticated,
    staleTime: 30 * 1000,
    gcTime: 5 * 60 * 1000,
  });

  return { balance, isLoading, isError, refetch };
};
