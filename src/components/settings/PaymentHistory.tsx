import React from 'react';
import { useQuery } from '@tanstack/react-query';
import { format } from 'date-fns';
import { RefreshCw } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { TIERS } from '@/components/pricing/pricingTiers';
import { useAuth } from '@/context/auth';
import { supabase } from '@/integrations/supabase/client';
import { Link } from '@/lib/router-compat';
import { getSessionUserId } from '@/lib/sessionUserId';
import { cn } from '@/lib/utils';

export const WALLET_ACTIVITY_QUERY_KEY = 'wallet-activity';

const PAGE_SIZE = 10;

interface PaymentStatusJson {
  approved?: boolean;
  verified?: boolean;
  completed?: boolean;
  cancelled?: boolean;
  voided?: boolean;
  error?: string;
}

interface PaymentMetadata {
  kind?: string;
  subscriptionTier?: string;
}

interface PaymentRow {
  id: number;
  amount: number;
  approved_amount_pi: number | null;
  memo: string | null;
  status: PaymentStatusJson | null;
  metadata: PaymentMetadata | null;
  created_at: string | null;
}

interface LedgerRow {
  id: number;
  amount_pi: number;
  transaction_type: string;
  reference_id: string | null;
  created_at: string;
}

interface ActivityItem {
  key: string;
  label: string;
  /** What comes before the status in the row's meta line */
  meta: string[];
  status: string | null;
  statusIsBad: boolean;
  amount: string;
  amountClass: string;
  needsSupport: boolean;
  sortTime: number;
}

const planLabel = (tierId: string | undefined) => {
  const name = TIERS.find(({ id }) => id === tierId)?.name;
  return name ? `${name} plan` : 'Plan';
};

const formatDate = (ts: string | null) => {
  const date = ts ? new Date(ts) : null;
  return date && !Number.isNaN(date.getTime()) ? format(date, 'd MMM') : '—';
};

const sortTime = (ts: string | null) => {
  const time = ts ? new Date(ts).getTime() : 0;
  return Number.isNaN(time) ? 0 : time;
};

function deriveStatus(status: PaymentStatusJson | null): { label: string; bad: boolean; moneyFailed: boolean; cancelled: boolean; needsSupport: boolean } {
  const settled = { moneyFailed: false, cancelled: false, needsSupport: false };
  const failed = (label: string) => ({ label, bad: true, moneyFailed: true, cancelled: false, needsSupport: false });
  // The Pi moved, so this one isn't a failed payment: its amount stays the normal colour
  if (status?.completed && status.error === 'plan_not_activated') {
    return { label: 'Paid · plan not activated', bad: true, ...settled, needsSupport: true };
  }
  if (status?.completed) return { label: 'Completed', bad: false, ...settled };
  if (status?.cancelled) {
    return { label: status.error === 'amount_mismatch' ? 'Cancelled · price changed' : 'Cancelled', bad: true, ...settled, cancelled: true };
  }
  if (status?.voided) return failed('Voided');
  if (status?.error) return failed('Error');
  return { label: 'Pending', bad: false, ...settled };
}

function paymentToItem(row: PaymentRow): ActivityItem {
  const state = deriveStatus(row.status);
  const isTopUp = row.metadata?.kind === 'wallet_topup';
  const tier = row.metadata?.subscriptionTier;
  let label: string;
  let type: string | null = null;
  if (isTopUp) {
    label = 'Top up';
  } else if (tier) {
    label = planLabel(tier);
    type = 'Plan';
  } else if (row.metadata?.kind === 'message_fee') {
    label = 'Message fee';
  } else if (row.memo) {
    label = row.memo;
    type = 'Payment';
  } else {
    label = 'Payment';
  }
  // A plan's real amount is what Pi reported at approval. amount is what the client sent
  const amount = Number(row.approved_amount_pi ?? row.amount).toFixed(2);
  return {
    key: `payment-${row.id}`,
    label,
    meta: [...(type ? [type] : []), formatDate(row.created_at)],
    status: state.label,
    statusIsBad: state.bad,
    // A cancelled payment moved nothing, so it has no sign
    amount: state.cancelled ? `${amount} π` : `${isTopUp ? '+' : '−'} ${amount} π`,
    amountClass: state.cancelled ? 'text-muted-foreground' : state.moneyFailed ? 'text-destructive' : isTopUp ? 'text-primary' : 'text-foreground',
    needsSupport: state.needsSupport,
    sortTime: sortTime(row.created_at),
  };
}

function ledgerToItem(row: LedgerRow): ActivityItem {
  if (Number(row.amount_pi) > 0) {
    return {
      key: `ledger-${row.id}`,
      label: row.transaction_type === 'refund' ? 'Refund' : 'Balance adjustment',
      meta: [formatDate(row.created_at)],
      status: null,
      statusIsBad: false,
      amount: `+ ${Number(row.amount_pi).toFixed(2)} π`,
      amountClass: 'text-primary',
      needsSupport: false,
      sortTime: sortTime(row.created_at),
    };
  }
  const isPlan = row.reference_id?.startsWith('plan:') ?? false;
  return {
    key: `ledger-${row.id}`,
    label: isPlan ? planLabel(row.reference_id?.split(':')[1]) : 'Payment from balance',
    meta: isPlan ? ['Plan', 'Paid from balance', formatDate(row.created_at)] : [formatDate(row.created_at)],
    status: null,
    statusIsBad: false,
    amount: `− ${Math.abs(Number(row.amount_pi)).toFixed(2)} π`,
    amountClass: 'text-foreground',
    needsSupport: false,
    sortTime: sortTime(row.created_at),
  };
}

// null when there's no session
const fetchActivity = async (): Promise<ActivityItem[] | null> => {
  // RLS checks user_id = auth.uid(); user.uid can be the Pi ID or stale.
  const userId = await getSessionUserId();
  if (!userId) return null;

  const [payments, ledger] = await Promise.all([
    supabase
      .from('payments')
      .select('id, amount, approved_amount_pi, memo, status, metadata, created_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE),
    // Everything but a deposit's credit, which already shows from payments as "Top up". The user
    // filter matters here, because this table's policy lets an admin read everyone's rows
    supabase
      .from('wallet_ledger')
      .select('id, amount_pi, transaction_type, reference_id, created_at')
      .eq('user_id', userId)
      .or('amount_pi.lt.0,transaction_type.neq.deposit')
      .order('created_at', { ascending: false })
      .limit(PAGE_SIZE),
  ]);
  if (payments.error) throw payments.error;
  if (ledger.error) throw ledger.error;

  // approved_amount_pi is newer than the generated Supabase types
  const paymentRows = (payments.data ?? []) as unknown as PaymentRow[];
  return [...paymentRows.map(paymentToItem), ...((ledger.data ?? []) as LedgerRow[]).map(ledgerToItem)]
    .sort((a, b) => b.sortTime - a.sortTime)
    .slice(0, PAGE_SIZE);
};

const PaymentHistory: React.FC = () => {
  const { user } = useAuth();
  const { data: items, isLoading, isFetching, isError, error, refetch } = useQuery({
    queryKey: [WALLET_ACTIVITY_QUERY_KEY, user?.uid],
    queryFn: fetchActivity,
    enabled: !!user?.uid,
    retry: false,
  });

  if (!user?.uid || items === null) {
    return <p className="text-sm text-muted-foreground">Sign in to view your payment history.</p>;
  }

  return (
    <section aria-labelledby="activity-heading" className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 id="activity-heading" className="text-base font-semibold">Recent activity</h2>
        <button
          type="button"
          aria-label="Refresh activity"
          onClick={() => void refetch()}
          className="-mr-2 flex h-11 w-11 items-center justify-center rounded-full text-primary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <RefreshCw className={cn('h-5 w-5', isFetching && 'animate-spin')} aria-hidden="true" />
        </button>
      </div>

      {isLoading ? (
        <div className="space-y-2" data-testid="activity-loading">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[60px] w-full rounded-xl" />
          ))}
        </div>
      ) : isError ? (
        <p role="alert" className="rounded-xl border bg-card px-5 py-6 text-center text-sm text-destructive">
          Failed to load activity: {error instanceof Error ? error.message : 'please try again.'}
        </p>
      ) : !items?.length ? (
        <div className="rounded-xl border bg-card px-5 py-6 text-center text-card-foreground">
          <h3 className="text-[15px] font-semibold">No activity yet</h3>
          <p className="mt-1.5 text-sm text-muted-foreground">Top ups and plan payments will show here.</p>
        </div>
      ) : (
        <>
          <ul className="divide-y divide-border rounded-xl border bg-card text-card-foreground">
            {items.map((item) => (
              <li key={item.key} className="px-3 py-2">
                <div className="flex min-h-11 items-center gap-3">
                  <div className="min-w-0 flex-1">
                    <p className="break-words text-sm font-semibold">{item.label}</p>
                    <p className="text-xs text-muted-foreground">
                      {item.meta.join(' · ')}
                      {item.status && (
                        <>
                          {' · '}
                          <span className={cn(item.statusIsBad && 'text-destructive')}>{item.status}</span>
                        </>
                      )}
                    </p>
                  </div>
                  <p className={cn('shrink-0 text-sm font-semibold tabular-nums', item.amountClass)}>{item.amount}</p>
                </div>
                {item.needsSupport && (
                  <p className="text-xs text-muted-foreground">
                    <Link to="/contact" className="inline-flex min-h-11 items-center font-medium text-primary underline">Contact support</Link>
                    {' and we\'ll sort it out.'}
                  </p>
                )}
              </li>
            ))}
          </ul>
          <p className="text-xs text-muted-foreground">Your 10 most recent payments.</p>
        </>
      )}
    </section>
  );
};

export default PaymentHistory;
