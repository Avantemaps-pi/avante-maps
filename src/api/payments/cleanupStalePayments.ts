/**
 * Cleanup stale payments endpoint
 *
 * This endpoint handles cleaning up stale or abandoned payments
 * to prevent the "pending payment" error in Pi Network
 *
 * With a paymentId, only that payment: the wallet closed without signing it, so it's cancelled at
 * once (at any age) if Pi confirms nothing was signed. If Pi shows a transaction, the answer is
 * { signed: true, txid } and nothing is cancelled
 */
import { supabase } from '@/integrations/supabase/client';
import { secureLog } from '@/utils/secureLogger';
import { readFunctionError } from './functionError';

export interface CleanupResponse {
  success: boolean;
  message: string;
  cleanedCount?: number;
  /** paymentId only: the payment was cancelled at Pi and in its row */
  cancelled?: boolean;
  /** paymentId only: Pi shows a transaction, so it wasn't cancelled */
  signed?: boolean;
  txid?: string | null;
}

export const cleanupStalePayments = async (
  userId: string,
  paymentId?: string,
): Promise<CleanupResponse> => {
  try {
    secureLog.info('Calling cleanup-stale-payments', {
      paymentId: paymentId ?? null,
    });

    const { data, error } = await supabase.functions.invoke(
      'cleanup-stale-payments',
      {
        body: JSON.stringify(paymentId ? { userId, paymentId } : { userId }),
      },
    );

    if (error) {
      const said = await readFunctionError(error);
      secureLog.warn('cleanup-stale-payments failed', {
        paymentId: paymentId ?? null,
        message: said.message ?? error.message,
      });
      return {
        success: false,
        message: `Failed to cleanup stale payments: ${said.message ?? error.message}`,
      };
    }

    return data as CleanupResponse;
  } catch (error) {
    secureLog.error('Error cleaning up stale payments', error);
    return {
      success: false,
      message: 'Failed to cleanup stale payments: ' + (error instanceof Error ? error.message : 'Unknown error')
    };
  }
};
