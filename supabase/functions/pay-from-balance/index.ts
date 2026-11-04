import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { getExpectedPlanPi } from '../_shared/prices.ts';
import {
  getOrCreateLifecycleId,
  makeLogger,
  correlationHeaders,
} from '../_shared/logger.ts';

const FN = 'pay-from-balance';

// An amount in the body is dropped here: the server works out what's owed
const PayRequestSchema = z.object({
  kind: z.enum(['subscription']),
  subscriptionTier: z.string().min(1).max(50),
  frequency: z.enum(['monthly', 'annual']),
  requestId: z.string().uuid('Invalid request ID'),
});

const supabaseClient = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  const lifecycleId = getOrCreateLifecycleId(req);
  const log = makeLogger({ fn: FN, lifecycleId });

  const respond = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ ...body, lifecycleId, correlationId: lifecycleId }), {
      headers: {
        ...corsHeaders,
        ...correlationHeaders(lifecycleId),
        'Content-Type': 'application/json',
      },
      status,
    });

  if (req.method !== 'POST') {
    return respond({ success: false, message: 'Method not allowed' }, 405);
  }

  log.info(`${FN}.request.received`, { stage: 'validation' });

  try {
    // The user comes from the token, never from the body
    const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return respond({ success: false, message: 'Unauthorized' }, 401);
    }
    const { data: authData, error: authError } = await supabaseClient.auth.getUser(authHeader.replace('Bearer ', ''));
    if (authError || !authData?.user) {
      return respond({ success: false, message: 'Unauthorized' }, 401);
    }
    const userId = authData.user.id;
    log.extend({ userId });

    const rawBody = await req.json().catch(() => null);
    const validationResult = PayRequestSchema.safeParse(rawBody);
    if (!validationResult.success) {
      const errors = validationResult.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      log.warn(`${FN}.validation.failed`, { stage: 'validation', errors });
      return respond({ success: false, message: 'Invalid request data', errors }, 400);
    }
    const { subscriptionTier: tier, frequency, requestId } = validationResult.data;

    const expected = await getExpectedPlanPi(supabaseClient, tier, frequency);
    if (!expected.ok && expected.error === 'invalid_tier') {
      log.warn(`${FN}.verify.unknown_tier`, { stage: 'validation', tier, frequency });
      return respond({ success: false, message: 'Invalid subscription tier' }, 400);
    }
    if (!expected.ok) {
      log.error(`${FN}.verify.pi_price_unavailable`, { stage: 'validation' });
      return respond({ success: false, message: 'Price service unavailable' }, 503);
    }

    // To 2 decimals, the amount the Pricing page shows
    const amountPi = Number(expected.expectedPi.toFixed(2));

    const { data: balance, error: payError } = await supabaseClient.rpc('pay_plan_from_balance', {
      p_user_id: userId,
      p_tier: tier,
      p_frequency: frequency,
      p_amount_pi: amountPi,
      p_request_id: requestId,
    });

    if (payError) {
      // Any RAISE defaults to P0001, so the code alone doesn't mean an insufficient balance
      if (payError.code === 'P0001' && payError.message?.includes('insufficient balance')) {
        const have = /have (-?[\d.]+)/.exec(payError.message)?.[1];
        log.info(`${FN}.pay.insufficient_balance`, { stage: 'db_write', tier, frequency, amountPi });
        return respond({
          success: false,
          error_code: 'insufficient_balance',
          message: 'Not enough balance',
          balance: have === undefined ? null : Number(have),
        }, 409);
      }
      log.error(`${FN}.pay.failed`, { stage: 'db_write', code: payError.code, message: payError.message });
      return respond({ success: false, message: 'Payment failed. Your balance has not changed.' }, 500);
    }

    log.info(`${FN}.done`, { stage: 'done', tier, frequency, amountPi, balance });
    return respond({ success: true, balance, amountPi, tier, frequency });
  } catch (error) {
    log.error(`${FN}.unhandled`, {
      stage: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return respond({ success: false, message: 'Payment service temporarily unavailable' }, 500);
  }
});
