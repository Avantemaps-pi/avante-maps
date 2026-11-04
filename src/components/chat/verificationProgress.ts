import type { VerificationMetrics } from './VerificationResultCard';

// Verification thresholds, as in the verify-business function
export const MIN_TRANSACTIONS = 100;
export const MIN_CREDITED = 50;
export const MIN_WALLETS = 10;

export interface VerificationProgress {
  contactDone: boolean;
  transactionsDone: boolean;
  walletsDone: boolean;
  done: number;
  /** 3 checks, or 2 when the business has no Pi wallet (contact email and the wallet itself) */
  total: number;
}

/** How many of the checks a verification result has passed (shared by the card and the toast) */
export function verificationProgress(
  metrics: Pick<VerificationMetrics, 'contactInfoConfirmed' | 'totalTransactions' | 'creditedTransactions' | 'uniqueWallets' | 'walletMissing'>
): VerificationProgress {
  const contactDone = metrics.contactInfoConfirmed;
  const transactionsDone = metrics.totalTransactions >= MIN_TRANSACTIONS && metrics.creditedTransactions >= MIN_CREDITED;
  const walletsDone = metrics.uniqueWallets >= MIN_WALLETS;
  if (metrics.walletMissing) {
    return { contactDone, transactionsDone: false, walletsDone: false, done: contactDone ? 1 : 0, total: 2 };
  }
  const done = [contactDone, transactionsDone, walletsDone].filter(Boolean).length;
  return { contactDone, transactionsDone, walletsDone, done, total: 3 };
}

/** A check's time in the device's format: "today, 17:36" or "3 Nov, 01:37"; null if there's none */
export function formatCheckTime(iso: string | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = date.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const isToday = date.toDateString() === new Date().toDateString();
  return `${isToday ? 'today' : date.toLocaleDateString([], { day: 'numeric', month: 'short' })}, ${time}`;
}
