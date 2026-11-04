import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { Copy, Store, Wallet as WalletIcon } from 'lucide-react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useAuth } from '@/context/auth';
import { supabase } from '@/integrations/supabase/client';
import { Link } from '@/lib/router-compat';
import { getSessionUserId } from '@/lib/sessionUserId';
import { cn } from '@/lib/utils';

// What the sandbox session has in place of a real address
const SANDBOX_WALLET_PLACEHOLDER = 'sandbox-mock-wallet';

const shortenAddress = (address: string) =>
  address.length <= 9 ? address : `${address.slice(0, 4)}…${address.slice(-4)}`;

const copyAddress = async (address: string) => {
  try {
    await navigator.clipboard.writeText(address);
    toast.success('Address copied');
  } catch {
    toast.error("Couldn't copy the address");
  }
};

const RowIcon: React.FC<{ icon: typeof Store }> = ({ icon: Icon }) => (
  <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-accent text-primary" aria-hidden="true">
    <Icon className="h-[18px] w-[18px]" />
  </span>
);

const CopyButton: React.FC<{ address: string; label: string }> = ({ address, label }) => (
  <button
    type="button"
    aria-label={label}
    onClick={() => void copyAddress(address)}
    className="flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
  >
    <Copy className="h-[18px] w-[18px]" aria-hidden="true" />
  </button>
);

const Address: React.FC<{ address: string | null; missing: string }> = ({ address, missing }) => (
  <p className={cn('text-[13px] text-muted-foreground', address && 'font-mono')}>{address ? shortenAddress(address) : missing}</p>
);

const ROW_CLASS = 'flex min-h-16 items-center gap-3 py-2 pl-3 pr-2';

/** The user's Pi wallet and each of their businesses' payout wallets */
const WalletAddresses: React.FC = () => {
  const { user } = useAuth();

  const { data: businesses, isLoading, isError, refetch } = useQuery({
    queryKey: ['wallet-businesses', user?.uid],
    queryFn: async () => {
      // owner_id is compared with auth.uid(): user.uid can be the Pi ID or stale
      const userId = await getSessionUserId();
      if (!userId) return [];
      const { data, error } = await supabase
        .from('businesses')
        .select('id, business_name, pi_wallet_address, is_active')
        .eq('owner_id', userId)
        .order('created_at', { ascending: false });
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!user,
    retry: false,
  });

  if (!user) return null;

  const walletAddress = user.walletAddress?.trim();
  const piWallet = walletAddress && walletAddress !== SANDBOX_WALLET_PLACEHOLDER ? walletAddress : null;

  return (
    <section aria-labelledby="wallets-heading" className="mb-5 space-y-2">
      <h2 id="wallets-heading" className="text-base font-semibold">Your wallets</h2>
      <div className="divide-y divide-border rounded-xl border bg-card text-card-foreground">
        <div className={ROW_CLASS}>
          <RowIcon icon={WalletIcon} />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold">Your Pi wallet</p>
            <Address address={piWallet} missing="Not shared by Pi" />
          </div>
          {piWallet && <CopyButton address={piWallet} label="Copy your Pi wallet address" />}
        </div>

        {isLoading && (
          <div className={ROW_CLASS} data-testid="wallet-businesses-loading">
            <Skeleton className="h-9 w-9 shrink-0 rounded-full" />
            <Skeleton className="h-9 flex-1" />
          </div>
        )}

        {isError && (
          <div className={ROW_CLASS} role="alert">
            <p className="min-w-0 flex-1 text-sm text-muted-foreground">Couldn't load your businesses.</p>
            <Button type="button" variant="ghost" className="h-11 shrink-0 text-primary" onClick={() => void refetch()}>
              Try again
            </Button>
          </div>
        )}

        {!isError && businesses?.map((business) => {
          const payoutWallet = business.pi_wallet_address?.trim() || null;
          const name = business.business_name;
          return (
            <div key={business.id} className={ROW_CLASS}>
              <RowIcon icon={Store} />
              <div className="min-w-0 flex-1">
                <p className="break-words text-sm font-semibold">
                  {name}
                  {!business.is_active && <span className="font-normal text-muted-foreground"> · Inactive</span>}
                  {' · payout wallet'}
                </p>
                <Address address={payoutWallet} missing="No payout wallet yet" />
              </div>
              {payoutWallet && <CopyButton address={payoutWallet} label={`Copy the ${name} payout wallet address`} />}
              <Link
                to={`/update-registration/${business.id}?field=piWalletAddress`}
                aria-label={payoutWallet ? `Edit the ${name} payout wallet` : `Add a payout wallet for ${name}`}
                className="flex h-11 min-w-11 shrink-0 items-center justify-center rounded-md px-1.5 text-sm font-semibold text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {payoutWallet ? 'Edit' : 'Add'}
              </Link>
            </div>
          );
        })}
      </div>
      {!isError && !!businesses?.length && (
        <p className="text-xs text-muted-foreground">Customers' payments to your business go to its payout wallet.</p>
      )}
    </section>
  );
};

export default WalletAddresses;
