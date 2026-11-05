import React, { useEffect, useRef, useState } from 'react';
import { Loader2, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { OVERLAY_MOTION, SHEET_MOTION } from '@/components/chat/QuickActionsSheet';
import { payFromBalance } from '@/api/payments';
import { useAuth } from '@/context/auth';
import { usePiPrice } from '@/hooks/usePiPrice';
import { WALLET_BALANCE_QUERY_KEY, useWalletBalance } from '@/hooks/useWalletBalance';
import { Link } from '@/lib/router-compat';
import { cn } from '@/lib/utils';
import { secureLog } from '@/utils/secureLogger';
import { TIERS } from './pricingTiers';

type PayMethod = 'balance' | 'pi';

interface PlanCheckoutSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Kept while the sheet closes, so its content doesn't change as it slides out */
  tierId: string | null;
  /** The Pricing page's frequency: 'monthly' or 'yearly' */
  frequency: string;
  /** "Continue in Pi Wallet": the sheet closes, then the Pi payment starts for the amount shown */
  onPayWithPi: (tierId: string, amountPi: number) => void;
  /** Where focus goes when the sheet closes (the plan's button) */
  onCloseAutoFocus?: (event: Event) => void;
}

// The padding makes up for the thicker border, so the content stays put when a row is selected
const rowClass = (selected: boolean) =>
  cn(
    'flex min-h-16 items-start gap-3 rounded-xl',
    selected ? 'border-2 border-primary bg-accent p-[11px]' : 'border border-border bg-card p-3',
  );

const PlanCheckoutSheet: React.FC<PlanCheckoutSheetProps> = ({ open, onOpenChange, tierId, frequency, onPayWithPi, onCloseAutoFocus }) => {
  const queryClient = useQueryClient();
  const { refreshUserData } = useAuth();
  const { balance, isLoading: isBalanceLoading, isError: isBalanceError, refetch: refetchBalance } = useWalletBalance();
  const { convertUsdToPiRoundedUp, isLoading: isPriceLoading, error: piPriceError, refresh: refreshPrice } = usePiPrice();
  const [choice, setChoice] = useState<PayMethod | null>(null);
  const [isPaying, setIsPaying] = useState(false);
  // One id per attempt at a plan, kept when the sheet is closed and reopened: if a response is lost,
  // the payment may have gone through, and the retry has to be recognised as the same payment
  const attempt = useRef<{ key: string; requestId: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setChoice(null);
    refetchBalance();
    refreshPrice();
  }, [open, refetchBalance, refreshPrice]);

  const tier = TIERS.find(({ id }) => id === tierId);
  const isYearly = frequency === 'yearly';
  const usd = tier ? tier.price[isYearly ? 'yearly' : 'monthly'] : null;
  const piAmount = typeof usd === 'number' ? convertUsdToPiRoundedUp(usd) : null;
  const price = piAmount === null ? null : Number(piAmount);

  // usePiPrice falls back to a made-up rate when pi_price can't be read, and the server checks the
  // real one, so neither payment is offered with an amount that may be wrong
  const priceUnavailable = !isPriceLoading && (!!piPriceError || price === null);
  const priceReady = !isPriceLoading && !priceUnavailable;
  const isBalanceRowLoading = isBalanceLoading || isPriceLoading;
  const balanceUnavailable = !isBalanceRowLoading && (isBalanceError || priceUnavailable);
  const hasEnough = !isBalanceRowLoading && !balanceUnavailable && price !== null && balance >= price;
  const notEnough = !isBalanceRowLoading && !balanceUnavailable && !hasEnough;
  const method: PayMethod | null = priceUnavailable ? null : hasEnough ? (choice ?? 'balance') : 'pi';
  const amountShown = priceReady ? piAmount : null;

  const handleOpenChange = (next: boolean) => {
    if (!next && isPaying) return;
    onOpenChange(next);
  };

  const payWithBalance = async () => {
    if (!tier) return;
    const key = `${tier.id}:${frequency}`;
    if (attempt.current?.key !== key) attempt.current = { key, requestId: crypto.randomUUID() };

    setIsPaying(true);
    const result = await payFromBalance({
      subscriptionTier: tier.id,
      frequency: isYearly ? 'annual' : 'monthly',
      requestId: attempt.current.requestId,
    });
    setIsPaying(false);

    if (result.status === 'paid') {
      attempt.current = null;
      onOpenChange(false);
      toast.success(`${tier.name} plan active`);
      queryClient.invalidateQueries({ queryKey: WALLET_BALANCE_QUERY_KEY });
      refreshUserData(true).catch((error) => secureLog.warn('Refresh after paying from balance failed', error));
    } else if (result.status === 'insufficient') {
      toast.error('Not enough balance');
      setChoice('pi');
      refetchBalance();
    } else {
      secureLog.warn('Pay from balance failed', { tier: tier.id, message: result.message });
      toast.error(result.message);
    }
  };

  const handleContinue = () => {
    if (!tier) return;
    if (method === 'balance') {
      payWithBalance();
    } else if (method === 'pi' && price !== null) {
      onOpenChange(false);
      onPayWithPi(tier.id, price);
    }
  };

  return (
    <Sheet open={open} onOpenChange={handleOpenChange}>
      <SheetContent
        side="bottom"
        hideClose
        onCloseAutoFocus={onCloseAutoFocus}
        overlayClassName={`bg-slate-950/50 ${OVERLAY_MOTION}`}
        className={`flex max-h-[90dvh] flex-col gap-3.5 overflow-y-auto rounded-t-[20px] bg-background px-4 pt-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] ${SHEET_MOTION}`}
      >
        <div className="h-1 w-9 shrink-0 self-center rounded-full bg-input" aria-hidden="true" />
        <div className="flex items-start justify-between gap-2">
          <div>
            <SheetTitle className="text-lg font-bold text-foreground">{tier?.name} plan</SheetTitle>
            <SheetDescription className="text-sm text-muted-foreground">
              ${typeof usd === 'number' ? usd.toFixed(2) : ''} a {isYearly ? 'year' : 'month'} · {amountShown ?? '…'} π today
            </SheetDescription>
          </div>
          <SheetClose
            aria-label="Close"
            disabled={isPaying}
            className="-mt-1.5 -mr-2.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
          >
            <X className="h-5 w-5" aria-hidden="true" />
          </SheetClose>
        </div>

        <fieldset disabled={isPaying} className="m-0 flex flex-col gap-2.5 border-0 p-0">
          <legend className="pb-2 text-sm font-semibold">Pay with</legend>
          <label className={cn(rowClass(method === 'balance'), (notEnough || balanceUnavailable) && 'opacity-60')}>
            <input
              type="radio"
              name="pay-with"
              checked={method === 'balance'}
              disabled={!hasEnough}
              onChange={() => setChoice('balance')}
              className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold">Avante Maps balance</span>
              {isBalanceRowLoading ? (
                <Skeleton data-testid="balance-skeleton" className="mt-1 h-4 w-44" />
              ) : (
                <span className="text-[13px] text-muted-foreground">
                  {balanceUnavailable && 'Balance unavailable right now'}
                  {notEnough && `Not enough: ${balance.toFixed(2)} π available`}
                  {hasEnough && price !== null && `${balance.toFixed(2)} π available · ${(balance - price).toFixed(2)} π left after`}
                </span>
              )}
            </span>
          </label>
          {notEnough && (
            <Link to="/wallet" className="-my-1.5 ml-11 flex min-h-11 items-center self-start text-sm font-semibold text-primary">
              Top up your balance
            </Link>
          )}
          <label className={cn(rowClass(method === 'pi'), priceUnavailable && 'opacity-60')}>
            <input
              type="radio"
              name="pay-with"
              checked={method === 'pi'}
              disabled={priceUnavailable}
              onChange={() => setChoice('pi')}
              className="mt-0.5 h-5 w-5 shrink-0 accent-primary"
            />
            <span className="flex min-w-0 flex-1 flex-col gap-0.5">
              <span className="text-[15px] font-semibold">Pi Wallet</span>
              <span className="text-[13px] text-muted-foreground">
                {priceUnavailable ? 'Price unavailable right now. Try again in a minute.' : 'Approve the payment in the Pi Wallet app'}
              </span>
            </span>
          </label>
        </fieldset>

        <Button type="button" className="h-11 w-full" disabled={isPaying || !priceReady} onClick={handleContinue}>
          {isPaying && <Loader2 className="mr-2 h-4 w-4 animate-spin" aria-hidden="true" />}
          {method === 'balance' ? `Pay ${piAmount} π from balance` : 'Continue in Pi Wallet'}
        </Button>
        <p className="text-center text-xs text-muted-foreground">Covers 1 {isYearly ? 'year' : 'month'} from today.</p>
      </SheetContent>
    </Sheet>
  );
};

export default PlanCheckoutSheet;
