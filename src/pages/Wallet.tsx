import React from 'react';
import AppLayout from '@/components/layout/AppLayout';
import PaymentHistory from '@/components/settings/PaymentHistory';
import BalanceCard from '@/components/wallet/BalanceCard';
import TopUpDialog from '@/components/wallet/TopUpDialog';
import { useWalletBalance } from '@/hooks/useWalletBalance';

const Wallet = () => {
  const { balance, isLoading, isError, refetch } = useWalletBalance();

  return (
    <AppLayout title="Wallet" fullWidth={true} className="overflow-x-hidden">
      <div className="w-full max-w-4xl mx-auto px-4 sm:px-6 pt-3 sm:pt-4 pb-4 sm:pb-6" role="region" aria-labelledby="page-title">
        <BalanceCard balance={balance} isLoading={isLoading} isError={isError} />
        <TopUpDialog onSuccess={() => { void refetch(); }} />
        <PaymentHistory />
      </div>
    </AppLayout>
  );
};

export default Wallet;
