import React from 'react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  CheckCircle2,
  XCircle,
  AlertTriangle,
  Clock,
  Info,
  Loader2,
} from 'lucide-react';
import type { TerminalReason } from '@/hooks/usePaymentStatusPolling';
import type { PaymentOutcome } from './useSubscriptionPayment';

interface PaymentOutcomeBannerProps {
  isPolling: boolean;
  isTerminal: boolean;
  terminalReason: TerminalReason | null;
  paymentId: string | null;
  /** Called when the user opts to retry. Only shown when retry is safe. */
  onRetry?: () => void;
  /** Called when the user dismisses the banner. */
  onDismiss?: () => void;
  /** Disable retry while another action is in flight. */
  retryDisabled?: boolean;
  /** A plan payment that ended without being completed (nothing signed, or no result in time) */
  outcome?: PaymentOutcome | null;
}

interface OutcomeMeta {
  title: string;
  description: string;
  tone: 'success' | 'pending' | 'destructive' | 'info';
  Icon: React.ComponentType<{ className?: string }>;
  /** Whether retrying is appropriate without risking a double charge. */
  canRetry: boolean;
}

const OUTCOMES: Record<TerminalReason, OutcomeMeta> = {
  completed: {
    title: 'Payment completed',
    description:
      'Your payment was confirmed on the Pi network and your subscription is active.',
    tone: 'success',
    Icon: CheckCircle2,
    canRetry: false,
  },
  cancelled: {
    title: 'Payment cancelled',
    description:
      'The payment was cancelled before any Pi was transferred. You can safely try again.',
    tone: 'pending',
    Icon: XCircle,
    canRetry: true,
  },
  voided: {
    title: 'Payment voided',
    description:
      'The payment expired without completing. No Pi was transferred. You can safely try again.',
    tone: 'pending',
    Icon: AlertTriangle,
    canRetry: true,
  },
  error: {
    title: 'Payment failed',
    description:
      'Something went wrong while finalizing the payment. If your wallet was not charged, you can try again.',
    tone: 'destructive',
    Icon: XCircle,
    canRetry: true,
  },
  timeout: {
    title: 'Status check timed out',
    description:
      'We could not confirm the final state in time. Please check your Pi wallet before retrying — do not retry if you see a successful transfer.',
    tone: 'destructive',
    Icon: Clock,
    canRetry: false,
  },
};

// Neutral: the wallet closed before signing (nothing charged), or no result within the 90 s limit
const NOT_COMPLETED: Record<
  PaymentOutcome,
  { title: string; lines: string[] }
> = {
  not_completed: {
    title: 'Payment not completed',
    lines: ['Nothing was charged. You can try again.'],
  },
  not_enough_pi: {
    title: 'Payment not completed',
    lines: [
      'Nothing was charged. You can try again.',
      'Not enough Pi in your wallet.',
    ],
  },
  unconfirmed: {
    title: "We couldn't confirm this payment yet",
    lines: ['If Pi left your wallet, it will be credited automatically.'],
  },
};

const toneClasses: Record<OutcomeMeta['tone'], string> = {
  success: 'border-primary/30 bg-accent text-accent-foreground',
  pending: 'border-input bg-muted text-foreground',
  destructive: 'border-destructive/30 bg-destructive/10 text-foreground',
  info: 'bg-secondary text-secondary-foreground',
};

const iconToneClasses: Record<OutcomeMeta['tone'], string> = {
  success: 'text-primary',
  pending: 'text-muted-foreground',
  destructive: 'text-destructive',
  info: 'text-primary',
};

export const PaymentOutcomeBanner: React.FC<PaymentOutcomeBannerProps> = ({
  isPolling,
  isTerminal,
  terminalReason,
  paymentId,
  onRetry,
  onDismiss,
  retryDisabled,
  outcome,
}) => {
  // Active polling state — show a non-dismissible "in progress" indicator.
  if (isPolling && !isTerminal) {
    return (
      <Card className="mb-4 border-input bg-muted text-foreground">
        <CardContent className="flex items-start gap-3 p-4">
          <Loader2 className="mt-0.5 h-5 w-5 shrink-0 animate-spin text-muted-foreground" />
          <div className="flex-1">
            <h3 className="text-sm font-medium">Confirming payment…</h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Waiting for the Pi network to finalize this payment. Please don't
              start a new one yet.
            </p>
            {paymentId && (
              <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
                {paymentId}
              </p>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (outcome) {
    const { title, lines } = NOT_COMPLETED[outcome];
    return (
      <Card role="status" className={`mb-4 ${toneClasses.pending}`}>
        <CardContent className="flex items-start gap-3 p-4">
          <Info
            className={`mt-0.5 h-5 w-5 shrink-0 ${iconToneClasses.pending}`}
          />
          <div className="flex-1">
            <h3 className="text-sm font-medium">{title}</h3>
            {lines.map((line) => (
              <p key={line} className="mt-1 text-xs text-muted-foreground">
                {line}
              </p>
            ))}
            {onDismiss && (
              <div className="mt-3 flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={onDismiss}>
                  Dismiss
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>
    );
  }

  if (!isTerminal || !terminalReason) return null;

  const meta = OUTCOMES[terminalReason];
  const { Icon } = meta;

  return (
    <Card className={`mb-4 ${toneClasses[meta.tone]}`}>
      <CardContent className="flex items-start gap-3 p-4">
        <Icon className={`mt-0.5 h-5 w-5 shrink-0 ${iconToneClasses[meta.tone]}`} />
        <div className="flex-1">
          <h3 className="text-sm font-medium">{meta.title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{meta.description}</p>
          {paymentId && (
            <p className="mt-1 truncate font-mono text-xs text-muted-foreground">
              {paymentId}
            </p>
          )}
          <div className="mt-3 flex flex-wrap gap-2">
            {meta.canRetry && onRetry && (
              <Button
                size="sm"
                variant="outline"
                onClick={onRetry}
                disabled={retryDisabled}
              >
                Try again
              </Button>
            )}
            {onDismiss && (
              <Button
                size="sm"
                variant="ghost"
                onClick={onDismiss}
              >
                Dismiss
              </Button>
            )}
          </div>
        </div>
      </CardContent>
    </Card>
  );
};

export default PaymentOutcomeBanner;
