/**
 * Pays a plan from the Avante Maps balance through the `pay-from-balance` Edge Function.
 * The server works out the amount, and the requestId makes a retry safe.
 */
import { supabase } from '@/integrations/supabase/client';
import { SUPABASE_CONFIG, getSupabaseFunctionsUrl } from '@/config/supabase';

const REQUEST_TIMEOUT_MS = 30000;

export type PayFromBalanceResult =
  | { status: 'paid'; balance: number; amountPi: number }
  | { status: 'insufficient'; balance: number | null }
  | { status: 'error'; message: string };

export const payFromBalance = async (req: {
  subscriptionTier: string;
  frequency: 'monthly' | 'annual';
  requestId: string;
}): Promise<PayFromBalanceResult> => {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session?.access_token) {
    return { status: 'error', message: 'Please log in to your account first' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${getSupabaseFunctionsUrl()}/pay-from-balance`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: SUPABASE_CONFIG.anonKey,
        Authorization: `Bearer ${session.access_token}`,
      },
      body: JSON.stringify({ kind: 'subscription', ...req }),
      signal: controller.signal,
    });
    const body = await response.json().catch(() => null);

    if (response.ok && body?.success) {
      return { status: 'paid', balance: body.balance, amountPi: body.amountPi };
    }
    if (response.status === 409 && body?.error_code === 'insufficient_balance') {
      return { status: 'insufficient', balance: body.balance ?? null };
    }
    return { status: 'error', message: body?.message || 'Payment failed. Your balance has not changed.' };
  } catch {
    // The payment may or may not have gone through. Trying again with the same requestId is safe
    return { status: 'error', message: "We couldn't confirm the payment. Please try again." };
  } finally {
    clearTimeout(timeout);
  }
};
