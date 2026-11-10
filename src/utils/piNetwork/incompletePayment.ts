/**
 * Unfinished payments at Pi.
 *
 * Pi reports a payment the user has started but the app hasn't completed (onIncompletePaymentFound,
 * from Pi.authenticate and Pi.createPayment), and blocks new payments until it's dealt with:
 * - with a transaction (the Pi has moved): completed through complete-payment, which checks the
 *   amount, who paid and our row (#167). Its message shows if it refuses.
 * - without one: our stale rows are cancelled at Pi through cleanup-stale-payments (it can only
 *   cancel a payment that has a row with us and is over 10 minutes old). If nothing was cancelled,
 *   the user is asked to finish or cancel it in the Pi Wallet.
 *
 * Logs carry ids only: the payment id and the first 6 characters of the txid.
 */
import { toast } from 'sonner';
import { completePayment } from '@/api/payments';
import { cleanupStalePayments } from '@/api/payments/cleanupStalePayments';
import { supabase } from '@/integrations/supabase/client';
import type { PaymentDTO } from './types';

export const UNFINISHED_PAYMENT_MESSAGE =
  'An earlier Pi payment is unfinished. Open the Pi Wallet to finish or cancel it, then try again.';

export interface IncompletePaymentSeen {
  paymentId: string;
  hasTxid: boolean;
  outcome: 'handling' | 'completed' | 'refused' | 'cancelled' | 'unfinished';
}

// The last one Pi reported on this page (for /diagnostics), and those being handled now
let lastSeen: IncompletePaymentSeen | null = null;
const inFlight = new Set<string>();

export const getLastIncompletePayment = (): IncompletePaymentSeen | null => lastSeen;

const log = (event: string, fields: Record<string, unknown>) =>
  console.log(JSON.stringify({ fn: 'client.incompletePayment', event, ...fields }));

const record = (paymentId: string, hasTxid: boolean, outcome: IncompletePaymentSeen['outcome']) => {
  lastSeen = { paymentId, hasTxid, outcome };
};

export const handleIncompletePayment = async (payment: PaymentDTO): Promise<void> => {
  const paymentId = payment?.identifier;
  if (!paymentId || inFlight.has(paymentId)) return;
  const txid = payment.transaction?.txid ?? null;
  inFlight.add(paymentId);
  record(paymentId, !!txid, 'handling');
  log('found', { paymentId, txid: txid ? `${txid.slice(0, 6)}…` : null });

  try {
    // The Supabase user (never the Pi uid): the server checks it against the row and the payer
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;

    if (txid) {
      if (!userId) {
        record(paymentId, true, 'unfinished');
        toast.error('Sign in to finish your earlier Pi payment, then try again.', { id: 'pi:incomplete' });
        return;
      }
      const result = await completePayment({
        paymentId,
        userId,
        amount: Number(payment.amount),
        memo: payment.memo ?? '',
        metadata: payment.metadata ?? {},
        txid,
      });
      if (result.success) {
        record(paymentId, true, 'completed');
        log('completed', { paymentId });
        toast.success('Your earlier Pi payment is complete.', { id: 'pi:incomplete' });
      } else {
        record(paymentId, true, 'refused');
        log('refused', { paymentId, errorCode: result.error_code ?? null });
        toast.error(result.message || UNFINISHED_PAYMENT_MESSAGE, { id: 'pi:incomplete' });
      }
      return;
    }

    // No transaction: cancel it at Pi if it's one of our stale rows
    const cleaned = userId ? await cleanupStalePayments(userId) : null;
    if (cleaned?.success && (cleaned.cleanedCount ?? 0) > 0) {
      record(paymentId, false, 'cancelled');
      log('cancelled', { paymentId });
      toast.info('An earlier unfinished Pi payment was cancelled. Please try again.', { id: 'pi:incomplete' });
      return;
    }
    record(paymentId, false, 'unfinished');
    log('unfinished', { paymentId });
    toast.error(UNFINISHED_PAYMENT_MESSAGE, { id: 'pi:incomplete' });
  } catch (error) {
    record(paymentId, !!txid, 'unfinished');
    log('error', { paymentId, message: error instanceof Error ? error.message : String(error) });
    toast.error(UNFINISHED_PAYMENT_MESSAGE, { id: 'pi:incomplete' });
  } finally {
    inFlight.delete(paymentId);
  }
};
