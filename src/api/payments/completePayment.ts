/**
 * Payment completion endpoint
 *
 * Calls the `complete-payment` Supabase Edge Function. Forwards the
 * end-to-end lifecycle ID so the entire approve → complete → status
 * lifecycle can be traced in one query.
 */
import { supabase } from '@/integrations/supabase/client';
import { PaymentRequest, PaymentResponse } from './types';
import { readFunctionError } from './functionError';
import {
  correlationHeaders,
  generateLifecycleId,
} from '@/utils/correlation';

const FN = 'client.complete-payment';

function emit(
  level: 'info' | 'warn' | 'error',
  event: string,
  base: Record<string, unknown>,
  extra?: Record<string, unknown>
) {
  const line = JSON.stringify({
    ts: new Date().toISOString(),
    level,
    event,
    fn: FN,
    ...base,
    ...(extra ?? {}),
  });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const completePayment = async (
  req: PaymentRequest & { txid: string },
  opts: { lifecycleId?: string; correlationId?: string } = {}
): Promise<PaymentResponse & { lifecycleId: string; correlationId: string }> => {
  const lifecycleId =
    opts.lifecycleId ?? opts.correlationId ?? generateLifecycleId('complete');
  const base = {
    lifecycleId,
    paymentId: req.paymentId,
    txid: req.txid,
    stage: 'pi_api' as const,
  };

  emit('info', `${FN}.request.start`, base);

  try {
    const timeoutPromise = new Promise<PaymentResponse>((_, reject) => {
      setTimeout(() => reject(new Error('Payment completion request timed out')), 20000);
    });

    const fetchPromise = supabase.functions
      .invoke('complete-payment', {
        body: JSON.stringify(req),
        headers: correlationHeaders(lifecycleId),
      })
      .then(async ({ data, error }) => {
        if (error) {
          emit('error', `${FN}.request.error`, base, { message: error.message });
          const refused = await readFunctionError(error);
          return {
            success: false,
            message: refused.message ?? `Failed to complete payment: ${error.message}`,
            ...(refused.error_code ? { error_code: refused.error_code } : {}),
            paymentId: req.paymentId,
            txid: req.txid,
          } as PaymentResponse;
        }
        emit('info', `${FN}.request.success`, base, {
          serverLifecycleId:
            (data as any)?.lifecycleId ?? (data as any)?.correlationId,
        });
        return data as PaymentResponse;
      });

    const result = await Promise.race([fetchPromise, timeoutPromise]);
    return { ...result, lifecycleId, correlationId: lifecycleId };
  } catch (fetchError) {
    emit('error', `${FN}.request.exception`, base, {
      message: fetchError instanceof Error ? fetchError.message : 'Unknown error',
    });
    return {
      success: false,
      message:
        'Payment completion request failed: ' +
        (fetchError instanceof Error ? fetchError.message : 'Unknown error'),
      paymentId: req.paymentId,
      txid: req.txid,
      lifecycleId,
      correlationId: lifecycleId,
    };
  }
};
