import React, { useEffect, useState } from 'react';
import { Skeleton } from '@/components/ui/skeleton';
import { isMainnetPiHost } from '@/config/environment';
import { usePiPrice } from '@/hooks/usePiPrice';

interface BalanceCardProps {
  balance?: number | null;
  isLoading?: boolean;
  isError?: boolean;
}

const BalanceCard: React.FC<BalanceCardProps> = ({ balance, isLoading, isError }) => {
  const { piPrice, isLoading: isPriceLoading, error: piPriceError } = usePiPrice();
  // Read after mount: the page is server-rendered, and there's no window on the server
  const [hostname, setHostname] = useState<string | null>(null);
  useEffect(() => setHostname(window.location.hostname), []);

  const piBalance = typeof balance === 'number' && !Number.isNaN(balance) ? balance : 0;
  // usePiPrice falls back to a made-up rate when pi_price can't be read
  const usdEquivalent = piPrice && !piPriceError ? piBalance * piPrice : null;
  const isMainnet = hostname !== null && isMainnetPiHost(hostname);

  return (
    <section aria-label="Avante Maps balance" className="mb-3 rounded-xl bg-primary px-5 py-[18px] text-primary-foreground">
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold">Avante Maps balance</p>
        {hostname !== null && !isMainnet && (
          <span className="rounded-full border border-primary-foreground/45 px-2 py-0.5 text-xs font-medium">Testnet Pi</span>
        )}
      </div>
      {isLoading ? (
        <Skeleton className="my-1 h-[34px] w-32 bg-primary-foreground/20" />
      ) : isError ? (
        <>
          <p className="text-[34px] font-semibold leading-[42px] tabular-nums">— <span className="text-[26px] opacity-90">π</span></p>
          <p className="text-sm">Couldn't load your balance.</p>
        </>
      ) : (
        <p className="text-[34px] font-semibold leading-[42px] tabular-nums">
          {piBalance.toFixed(2)} <span className="text-[26px] opacity-90">π</span>
        </p>
      )}
      <p className="mt-1 text-sm opacity-90">Pays for plans in the app.</p>
      <p className="text-xs leading-[17px] opacity-90">Your Pi Wallet balance stays in the Pi Wallet app.</p>
      {isMainnet && !isError && !isPriceLoading && (
        <p className="mt-1 text-xs opacity-80">
          {usdEquivalent !== null ? `≈ $${usdEquivalent.toFixed(2)} USD` : 'USD value unavailable'}
        </p>
      )}
    </section>
  );
};

export default BalanceCard;
