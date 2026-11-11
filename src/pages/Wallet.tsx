import React, { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import AppLayout from '@/components/layout/AppLayout';
import PaymentHistory, { WALLET_ACTIVITY_QUERY_KEY } from '@/components/settings/PaymentHistory';
import BalanceCard from '@/components/wallet/BalanceCard';
import TopUpDialog from '@/components/wallet/TopUpDialog';
import WalletAddresses from '@/components/wallet/WalletAddresses';
import { cleanupStalePayments } from '@/api/payments';
import { useAuth } from '@/context/auth';
import { useWalletBalance } from '@/hooks/useWalletBalance';
import { getSessionUserId } from '@/lib/sessionUserId';
import { secureLog } from '@/utils/secureLogger';

// Signed-in users whose abandoned payments were tidied on this page load: once each per session
const staleCleanupDone = new Set<string>();

const Wallet = () => {
  const { balance, isLoading, isError, refetch } = useWalletBalance();
  const queryClient = useQueryClient();
  const { user } = useAuth();

  // Quietly cancels this user's payments that never completed and are over 10 minutes old, at Pi
  // and in their rows, so Recent activity doesn't show them as Pending. Errors are only logged
  useEffect(() => {
    if (!user?.uid) return;
    void (async () => {
      // The Supabase ID from the session, never user.uid
      const userId = await getSessionUserId();
      if (!userId || staleCleanupDone.has(userId)) return;
      staleCleanupDone.add(userId);
      const result = await cleanupStalePayments(userId);
      if (!result.success) {
        secureLog.warn('Stale payment cleanup failed', {
          message: result.message,
        });
      }
      void queryClient.invalidateQueries({
        queryKey: [WALLET_ACTIVITY_QUERY_KEY],
      });
    })();
  }, [user?.uid, queryClient]);

  const handleTopUpDone = () => {
    void refetch();
    void queryClient.invalidateQueries({ queryKey: [WALLET_ACTIVITY_QUERY_KEY] });
  };

  return (
    <AppLayout title="Wallet" fullWidth={true} className="overflow-x-hidden">
      <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 pt-3 sm:pt-4 pb-4 sm:pb-6" role="region" aria-labelledby="page-title">
        <BalanceCard balance={balance} isLoading={isLoading} isError={isError} />
        <TopUpDialog onDone={handleTopUpDone} />
        <WalletAddresses />
        <PaymentHistory />
      </div>
    </AppLayout>
  );
};

export default Wallet;
