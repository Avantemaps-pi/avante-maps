import React, { useEffect, useRef, useState } from 'react';
import { ChevronDown, Info, Shield } from 'lucide-react';
import { cn } from '@/lib/utils';
import { VerificationRows, type VerificationMetrics } from './VerificationResultCard';
import { formatCheckTime, verificationProgress } from './verificationProgress';

interface VerificationHistoryRowProps {
  metrics: VerificationMetrics;
  contactEmail?: string | undefined;
  /** The message's own time, for cards saved before checkedAt existed */
  timestamp: string;
}

/** An older result for a business that has a newer card: one row, which opens read-only */
const VerificationHistoryRow: React.FC<VerificationHistoryRowProps> = ({ metrics, contactEmail, timestamp }) => {
  const [open, setOpen] = useState(false);
  const rowRef = useRef<HTMLButtonElement>(null);
  const { done, total } = verificationProgress(metrics);

  // The list stays pinned to the bottom as its items grow, which would push the row that was
  // just opened out of view; bring it back once that has settled
  useEffect(() => {
    if (!open) return;
    let second = 0;
    const first = requestAnimationFrame(() => {
      second = requestAnimationFrame(() => rowRef.current?.scrollIntoView({ block: 'start' }));
    });
    return () => {
      cancelAnimationFrame(first);
      cancelAnimationFrame(second);
    };
  }, [open]);

  return (
    <div>
      <button
        ref={rowRef}
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className={cn(
          'flex min-h-14 w-full items-center gap-3 border bg-card px-3 py-2 text-left text-card-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
          open ? 'rounded-t-xl border-b-0' : 'rounded-xl'
        )}
      >
        <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground" aria-hidden="true">
          <Shield className="h-4 w-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block text-sm font-semibold">
            {metrics.businessName} · {done} of {total} done
          </span>
          <span className="block text-xs text-muted-foreground">
            Earlier check · {formatCheckTime(metrics.checkedAt) ?? timestamp}
          </span>
        </span>
        <ChevronDown className={cn('h-5 w-5 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} aria-hidden="true" />
      </button>
      {open && (
        <div className="rounded-b-xl border border-t-0 bg-card px-3 pb-3 text-card-foreground">
          <VerificationRows metrics={metrics} contactEmail={contactEmail} readOnly />
          <p className="mt-2 flex gap-2 text-xs text-muted-foreground">
            <Info className="h-4 w-4 shrink-0" aria-hidden="true" />
            Earlier result. Check the latest card below for today's numbers.
          </p>
        </div>
      )}
    </div>
  );
};

export default VerificationHistoryRow;
