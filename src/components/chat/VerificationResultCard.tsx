import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Clock, Info, Loader2, Shield, ShieldCheck } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Link } from '@/lib/router-compat';
import ContactOTPVerification, { type ContactOTPResult } from './ContactOTPVerification';
import { MIN_CREDITED, MIN_TRANSACTIONS, MIN_WALLETS, formatCheckTime, verificationProgress } from './verificationProgress';

export interface VerificationMetrics {
  contactInfoConfirmed: boolean;
  totalTransactions: number;
  creditedTransactions: number;
  uniqueWallets: number;
  verified: boolean;
  businessName: string;
  /** The server's reasons; kept for the record, not shown (the rows say the same, and stay current) */
  reason?: string | null;
  walletMissing?: boolean;
  /** The business checked, for "Check again" */
  businessId?: number;
  /** The check is still running: the card shows spinners until the result fills it in */
  pending?: boolean | undefined;
  /** When this result arrived (ISO); cards saved before this existed have none */
  checkedAt?: string | undefined;
}

// jo•••@gmail.com: enough to recognise the address without showing it
const maskEmail = (email: string) => {
  const at = email.lastIndexOf('@');
  if (at < 1) return email;
  return `${email.slice(0, Math.min(2, at))}•••@${email.slice(at + 1)}`;
};

const ProgressBar: React.FC<{ value: number; max: number; label: string; thin?: boolean; muted?: boolean | undefined }> = ({ value, max, label, thin, muted }) => (
  <div
    role="progressbar"
    aria-label={label}
    aria-valuemin={0}
    aria-valuemax={max}
    aria-valuenow={Math.min(value, max)}
    className={cn('overflow-hidden rounded-full bg-muted', thin ? 'h-1' : 'h-1.5')}
  >
    <div
      className={cn('h-full rounded-full', muted ? 'bg-muted-foreground' : thin ? 'bg-brand-navy' : 'bg-primary')}
      style={{ width: `${Math.min(value / max, 1) * 100}%` }}
    />
  </div>
);

interface RowProps {
  done: boolean;
  loading: boolean;
  label: string;
  value: string;
  children?: React.ReactNode;
}

// Status circle, label and value on one line, then the row's bars and sub-lines
const Row: React.FC<RowProps> = ({ done, loading, label, value, children }) => (
  <div className="flex items-start gap-3 border-t py-3">
    {loading ? (
      <Loader2 className="h-6 w-6 shrink-0 animate-spin text-muted-foreground" aria-hidden="true" />
    ) : (
      <span
        className={cn(
          'flex h-6 w-6 shrink-0 items-center justify-center rounded-full',
          done ? 'bg-primary text-primary-foreground' : 'border-2 border-input'
        )}
        aria-hidden="true"
      >
        {done && <Check className="h-3.5 w-3.5" strokeWidth={3} />}
      </span>
    )}
    <div className="flex min-w-0 flex-1 flex-col gap-1.5">
      <div className="flex justify-between gap-2 text-[15px] font-semibold">
        <span>{label}</span>
        <span className={cn('whitespace-nowrap', done ? 'text-primary' : 'text-foreground')}>
          {loading ? '' : value}
        </span>
      </div>
      {!loading && children}
    </div>
  </div>
);

const businessesLink = (
  <Link to="/registered-business" className="font-semibold text-primary underline underline-offset-2">
    Your businesses
  </Link>
);

interface VerificationRowsProps {
  metrics: VerificationMetrics;
  contactEmail?: string | undefined;
  /** Which rows have finished their reveal; all of them when left out */
  revealed?: boolean[] | undefined;
  /** Under the contact email: what to do next. Left out on an earlier, read-only result */
  contactActions?: React.ReactNode;
  /** An earlier result: grey bars and no links */
  readOnly?: boolean | undefined;
}

/** The checklist of a verification result: contact email, then transactions and wallets */
export const VerificationRows: React.FC<VerificationRowsProps> = ({ metrics, contactEmail, revealed, contactActions, readOnly }) => {
  const { contactInfoConfirmed, totalTransactions, creditedTransactions, uniqueWallets, walletMissing } = metrics;
  const progress = verificationProgress(metrics);
  const walletsLeft = Math.max(MIN_WALLETS - uniqueWallets, 0);
  const isLoading = (index: number) => (revealed ? !revealed[index] : false);

  return (
    <div className="flex flex-col">
      <Row
        done={contactInfoConfirmed}
        loading={isLoading(0)}
        label="Contact email"
        value={contactInfoConfirmed ? 'Confirmed' : 'Not confirmed'}
      >
        {contactEmail && <p className="text-[13px] leading-[18px] text-muted-foreground">{maskEmail(contactEmail)}</p>}
        {contactActions}
      </Row>

      {walletMissing ? (
        <Row done={false} loading={isLoading(1)} label="Pi wallet" value="Not added">
          {!readOnly && (
            <p className="text-[13px] leading-[18px] text-muted-foreground">
              Add a Pi wallet address to your business. {businessesLink}
            </p>
          )}
        </Row>
      ) : (
        <>
          <Row
            done={progress.transactionsDone}
            loading={isLoading(1)}
            label="Transactions"
            value={`${totalTransactions} of ${MIN_TRANSACTIONS}`}
          >
            <ProgressBar value={totalTransactions} max={MIN_TRANSACTIONS} label="Transactions" muted={readOnly} />
            <p className="text-[13px] leading-[18px] text-muted-foreground">
              Received: {creditedTransactions} of {MIN_CREDITED}
            </p>
            <ProgressBar value={creditedTransactions} max={MIN_CREDITED} label="Payments received" thin muted={readOnly} />
          </Row>
          <Row
            done={progress.walletsDone}
            loading={isLoading(2)}
            label="Wallets traded with"
            value={`${uniqueWallets} of ${MIN_WALLETS}`}
          >
            <ProgressBar value={uniqueWallets} max={MIN_WALLETS} label="Wallets traded with" muted={readOnly} />
            <p className="text-[13px] leading-[18px] text-muted-foreground">
              {walletsLeft === 0 ? 'Done' : `${walletsLeft} more to go`}
            </p>
          </Row>
        </>
      )}
    </div>
  );
};

const REVEAL_DELAYS = [300, 900, 1500];

interface VerificationResultCardProps {
  metrics: VerificationMetrics;
  contactEmail?: string | undefined;
  contactBusinessId?: number | undefined;
  onSendContactOTP?: ((email: string, businessId: number) => Promise<ContactOTPResult>) | undefined;
  onVerifyContactOTP?: ((email: string, otp: string, businessId: number) => Promise<ContactOTPResult>) | undefined;
  /** Re-runs verification for this business; the button is hidden without it */
  onCheckAgain?: (() => void | Promise<void>) | undefined;
  animate?: boolean | undefined;
}

/**
 * The result of a verification check, as progress towards Verified. Everything on it comes
 * from its own state, so confirming the contact email here updates the row, the count and
 * the tip at once.
 */
const VerificationResultCard: React.FC<VerificationResultCardProps> = ({
  metrics,
  contactEmail,
  contactBusinessId,
  onSendContactOTP,
  onVerifyContactOTP,
  onCheckAgain,
  animate = true,
}) => {
  const { verified, businessName } = metrics;

  const [contactInfoConfirmed, setContactInfoConfirmed] = useState(metrics.contactInfoConfirmed);
  const { pending } = metrics;
  const [revealed, setRevealed] = useState<boolean[]>(animate ? [false, false, false] : [true, true, true]);
  const [otpDialogOpen, setOtpDialogOpen] = useState(false);
  const [checking, setChecking] = useState(false);
  // Set when the code is confirmed here; the automatic check runs at most once
  const [confirmedHere, setConfirmedHere] = useState(false);
  const autoCheckedRef = useRef(false);

  const handleVerified = () => {
    setContactInfoConfirmed(true);
    setConfirmedHere(true);
    setOtpDialogOpen(false);
  };

  // Follows the stored result: confirmed elsewhere (the resumed code entry after a reload), or a
  // new check updating this card in place, which can also un-confirm a changed email
  useEffect(() => {
    setContactInfoConfirmed(metrics.contactInfoConfirmed);
  }, [metrics.contactInfoConfirmed, metrics.checkedAt]);

  const handleCheckAgain = useCallback(async () => {
    if (!onCheckAgain) return;
    setChecking(true);
    try {
      await onCheckAgain();
    } finally {
      setChecking(false);
    }
  }, [onCheckAgain]);

  // The rows reveal once, when the result is in
  useEffect(() => {
    if (pending) return;
    const timers = REVEAL_DELAYS.map((delay, i) =>
      setTimeout(() => {
        setRevealed(prev => {
          const next = [...prev];
          next[i] = true;
          return next;
        });
      }, delay)
    );
    return () => timers.forEach(clearTimeout);
  }, [pending]);

  const progress = verificationProgress({ ...metrics, contactInfoConfirmed });
  const lastChecked = formatCheckTime(metrics.checkedAt);
  // Every row done but the server hasn't said Verified (yet): never "Not verified yet" then
  const readyToVerify = !verified && progress.done === progress.total;

  // Confirming the email was the last thing missing: go straight to the server's answer
  useEffect(() => {
    if (!confirmedHere || !readyToVerify || !onCheckAgain || autoCheckedRef.current) return;
    autoCheckedRef.current = true;
    void handleCheckAgain();
  }, [confirmedHere, readyToVerify, onCheckAgain, handleCheckAgain]);

  const canShowOTP = !contactInfoConfirmed && contactEmail && contactBusinessId && onSendContactOTP && onVerifyContactOTP;
  // The code goes to the business's contact email only; without one, say where to add it
  const needsContactEmail = !pending && !contactInfoConfirmed && !!contactBusinessId && !contactEmail;

  return (
    <>
      <section
        aria-label={`Verification progress for ${businessName}`}
        aria-busy={!!pending}
        className="flex flex-col gap-3.5 rounded-xl border bg-card p-4 text-card-foreground"
      >
        <div className="flex items-center gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-primary" aria-hidden="true">
            {verified ? <ShieldCheck className="h-5 w-5" /> : <Shield className="h-5 w-5" />}
          </span>
          <div className="min-w-0">
            <h4 className="text-lg font-bold leading-6">
              {pending ? `Checking ${businessName}…` : verified ? 'Verified' : readyToVerify ? 'Ready to verify' : 'Not verified yet'}
            </h4>
            {!pending && (
              <p data-verification-progress className="text-sm text-muted-foreground">
                {verified
                  ? businessName
                  : readyToVerify
                    ? `${businessName} · All done`
                    : `${businessName} · ${progress.done} of ${progress.total} done`}
              </p>
            )}
          </div>
        </div>
        {lastChecked && (
          <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
            <Clock className="h-4 w-4 shrink-0" aria-hidden="true" />
            Last checked {lastChecked}
          </p>
        )}

        <VerificationRows
          metrics={{ ...metrics, contactInfoConfirmed }}
          contactEmail={contactEmail}
          revealed={revealed}
          contactActions={
            <>
              {canShowOTP && (
                <button
                  type="button"
                  onClick={() => setOtpDialogOpen(true)}
                  className="self-start rounded-md bg-primary px-3 py-1.5 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
                >
                  Confirm
                </button>
              )}
              {needsContactEmail && (
                <p className="text-[13px] leading-[18px] text-muted-foreground">
                  Add a contact email to your business first. {businessesLink}
                </p>
              )}
            </>
          }
        />

        {!verified && !pending && (
          <>
            <div className="flex gap-2.5 rounded-lg bg-accent p-3 text-[13px] leading-[18px] text-accent-foreground">
              <Info className="mt-px h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              {readyToVerify ? (
                <p>Everything's done. Tap Check again to get verified.</p>
              ) : (
                <p>
                  Verification counts payments on your business's Pi wallet. Keep trading in Pi, then check again.
                  {contactInfoConfirmed && ' Your contact email stays confirmed unless you change it.'}
                </p>
              )}
            </div>
            {onCheckAgain && (
              <Button type="button" className="w-full" onClick={handleCheckAgain} disabled={checking}>
                {checking && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
                Check again
              </Button>
            )}
          </>
        )}
      </section>

      {canShowOTP && (
        <Dialog open={otpDialogOpen} onOpenChange={setOtpDialogOpen}>
          <DialogContent className="sm:max-w-md">
            <DialogTitle className="sr-only">Verify Contact Information</DialogTitle>
            <ContactOTPVerification
              email={contactEmail}
              businessId={contactBusinessId}
              businessName={businessName}
              onSendOTP={onSendContactOTP}
              onVerifyOTP={onVerifyContactOTP}
              onVerified={handleVerified}
            />
          </DialogContent>
        </Dialog>
      )}
    </>
  );
};

export default VerificationResultCard;
