
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { AMOUNT_TOLERANCE, getExpectedPlanPi } from '../_shared/prices.ts';
import {
  getOrCreateLifecycleId,
  makeLogger,
  correlationHeaders,
} from '../_shared/logger.ts';

const FN = 'approve-payment';

const PaymentRequestSchema = z.object({
  paymentId: z.string()
    .min(1, 'Payment ID is required')
    .max(100, 'Payment ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid payment ID format'),
  userId: z.string().uuid('Invalid user ID format'),
  amount: z.number().positive('Amount must be positive').max(1000000, 'Amount exceeds maximum'),
  memo: z.string().max(500, 'Memo too long').transform(val =>
    val.replace(/[<>]/g, '')
  ).optional(),
  metadata: z.object({
    kind: z.enum(['subscription', 'message_fee', 'wallet_topup']).optional(),
    subscriptionTier: z.enum(['individual', 'small-business', 'organization']).optional(),
    frequency: z.enum(['monthly', 'annual']).optional(),
    duration: z.number().int().positive().max(365).optional(),
    conversationId: z.string().uuid().optional(),
    businessId: z.number().int().positive().optional(),
    feePi: z.number().positive().max(100).optional(),
  }).strict(),
  // Optional here so a missing one gets pi_token_missing, not a generic validation error
  piAccessToken: z.string().min(10).max(2000).optional(),
});

const PAYMENT_USER_MISMATCH = {
  success: false,
  error_code: 'payment_user_mismatch',
  message: "This payment was started from a different Pi account. Sign in with the account you're paying from.",
};

const PI_TOKEN_MISSING = {
  success: false,
  error_code: 'pi_token_missing',
  message: 'Please reopen Avante Maps and try again.',
};

const PI_TOKEN_INVALID = {
  success: false,
  error_code: 'pi_token_invalid',
  message: 'Your Pi sign-in has expired. Close and reopen Avante Maps, then try again.',
};

// Pi uids and usernames in logs: enough to tell them apart, never the whole value
const shortUid = (uid: unknown) => (typeof uid === 'string' && uid ? `${uid.slice(0, 6)}…` : null);

// Subscription tier assignment is intentionally NOT performed here.
// See `complete-payment` — tier upgrades only occur after the on-chain
// payment is verified completed, to prevent free subscription grants via
// approval-only calls with forged amount/metadata.


function isStalePayment(payment: any): boolean {
  const createdAt = new Date(payment.created_at).getTime();
  const now = Date.now();
  const tenMinutesInMs = 10 * 60 * 1000;
  return (
    !payment.status.completed &&
    !payment.status.cancelled &&
    (now - createdAt) > tenMinutesInMs
  );
}

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
  const startTime = Date.now();

  const respond = (body: Record<string, unknown>, status = 200) =>
    new Response(JSON.stringify({ ...body, lifecycleId, correlationId: lifecycleId }), {
      headers: {
        ...corsHeaders,
        ...correlationHeaders(lifecycleId),
        'Content-Type': 'application/json',
      },
      status,
    });

  log.info(`${FN}.request.received`, { stage: 'validation' });

  try {
    // ✅ SECURITY: Require & verify caller JWT
    const authHeader = req.headers.get('authorization') || req.headers.get('Authorization');
    if (!authHeader?.startsWith('Bearer ')) {
      return respond({ success: false, message: 'Unauthorized' }, 401);
    }
    const callerToken = authHeader.replace('Bearer ', '');
    const { data: authData, error: authError } = await supabaseClient.auth.getUser(callerToken);
    if (authError || !authData?.user) {
      return respond({ success: false, message: 'Unauthorized' }, 401);
    }
    const authenticatedUserId = authData.user.id;

    const rawBody = await req.json();
    const validationResult = PaymentRequestSchema.safeParse(rawBody);

    if (!validationResult.success) {
      const errors = validationResult.error.errors.map(e => ({
        field: e.path.join('.'),
        message: e.message,
      }));
      log.warn(`${FN}.validation.failed`, { stage: 'validation', errors });
      return respond({ success: false, message: 'Invalid request data', errors }, 400);
    }

    const paymentRequest = validationResult.data;

    // ✅ SECURITY: Caller must match userId in body
    if (paymentRequest.userId !== authenticatedUserId) {
      log.error(`${FN}.auth.user_mismatch`, { stage: 'validation', authenticatedUserId });
      return respond({ success: false, message: 'Forbidden: user mismatch' }, 403);
    }

    log.extend({ paymentId: paymentRequest.paymentId, userId: paymentRequest.userId });
    log.info(`${FN}.validation.ok`, { stage: 'validation', amount: paymentRequest.amount });

    // An old client still open. Nothing has been written yet
    const piAccessToken = paymentRequest.piAccessToken;
    if (!piAccessToken) {
      log.warn(`${FN}.validation.pi_token_missing`, { stage: 'validation' });
      return respond({ ...PI_TOKEN_MISSING, paymentId: paymentRequest.paymentId }, 400);
    }

    const piApiKey = Deno.env.get('PI_API_KEY');
    if (!piApiKey) {
      log.error(`${FN}.config.missing_api_key`, { stage: 'error' });
      return respond({ success: false, message: 'Payment service not configured' }, 500);
    }

    const { data: existingPayment, error: checkError } = await supabaseClient
      .from('payments')
      .select('*')
      .eq('payment_id', paymentRequest.paymentId)
      .single();

    if (checkError && checkError.code !== 'PGRST116') {
      log.error(`${FN}.lookup.error`, {
        stage: 'lookup',
        code: checkError.code,
        message: checkError.message,
      });
      return respond({ success: false, message: 'Payment processing failed. Please try again.' }, 500);
    }

    log.info(`${FN}.lookup.ok`, {
      stage: 'lookup',
      exists: !!existingPayment,
      currentStatus: existingPayment?.status ?? null,
    });

    if (existingPayment && existingPayment.user_id !== paymentRequest.userId) {
      log.error(`${FN}.lookup.ownership_mismatch`, {
        stage: 'lookup',
        ownerOnRecord: existingPayment.user_id,
      });
      return respond({ success: false, message: 'Payment ownership mismatch' }, 403);
    }

    if (existingPayment?.status?.completed) {
      log.info(`${FN}.terminal.idempotent`, { stage: 'transition', terminalReason: 'completed' });
      return respond({
        success: true,
        message: 'Payment already completed',
        paymentId: paymentRequest.paymentId,
        txid: existingPayment.txid,
      });
    }
    if (existingPayment?.status?.cancelled && !isStalePayment(existingPayment)) {
      log.info(`${FN}.terminal.idempotent`, { stage: 'transition', terminalReason: 'cancelled' });
      return respond({
        success: false,
        message: 'Payment was cancelled',
        paymentId: paymentRequest.paymentId,
      }, 409);
    }

    if (existingPayment && isStalePayment(existingPayment)) {
      log.warn(`${FN}.stale.detected`, { stage: 'lookup' });
      try {
        const piNetworkApiUrl = 'https://api.minepi.com/v2/payments';
        await fetch(`${piNetworkApiUrl}/${paymentRequest.paymentId}/cancel`, {
          method: 'POST',
          headers: {
            'Authorization': `Key ${piApiKey}`,
            'Content-Type': 'application/json',
          },
        });

        await supabaseClient.from('payments').update({
          status: {
            approved: false,
            verified: false,
            completed: false,
            cancelled: true,
            error: 'Payment automatically cancelled due to staleness (>10 minutes old)',
          },
          updated_at: new Date().toISOString(),
        }).eq('payment_id', paymentRequest.paymentId);

        log.transition(existingPayment.status, { cancelled: true }, {
          terminalReason: 'cancelled',
          reason: 'stale',
        });
      } catch (cancelError) {
        log.error(`${FN}.stale.cancel_error`, {
          stage: 'error',
          message: cancelError instanceof Error ? cancelError.message : String(cancelError),
        });
      }
    }

    if (existingPayment?.status?.approved && !isStalePayment(existingPayment)) {
      log.info(`${FN}.terminal.idempotent`, { stage: 'transition', terminalReason: null, note: 'already_approved' });
      return respond({
        success: true,
        message: 'Payment was already approved',
        paymentId: paymentRequest.paymentId,
      });
    }

    // A plan's price is checked before the user can sign. No row is written if it can't be
    let expectedPlanPi: number | null = null;
    if (paymentRequest.metadata.subscriptionTier) {
      const tier = paymentRequest.metadata.subscriptionTier;
      const freq = paymentRequest.metadata.frequency === 'annual' ? 'annual' : 'monthly';
      const expected = await getExpectedPlanPi(supabaseClient, tier, freq);
      if (!expected.ok && expected.error === 'invalid_tier') {
        log.warn(`${FN}.verify.unknown_tier`, { stage: 'validation', tier, freq });
        return respond({ success: false, message: 'Invalid subscription tier' }, 400);
      }
      if (!expected.ok) {
        log.error(`${FN}.verify.pi_price_unavailable`, { stage: 'validation' });
        return respond({ success: false, message: 'Price service unavailable' }, 503);
      }
      expectedPlanPi = expected.expectedPi;
    }

    if (!existingPayment) {
      const { error } = await supabaseClient
        .from('payments')
        .insert({
          payment_id: paymentRequest.paymentId,
          user_id: paymentRequest.userId,
          amount: paymentRequest.amount,
          memo: paymentRequest.memo,
          metadata: paymentRequest.metadata,
          lifecycle_id: lifecycleId,
          status: {
            approved: false,
            verified: false,
            completed: false,
            cancelled: false,
          },
        });
      if (error && error.code !== '23505') {
        log.error(`${FN}.db_write.insert_error`, {
          stage: 'db_write',
          code: error.code,
          message: error.message,
        });
        return respond({ success: false, message: 'Payment processing failed. Please try again.' }, 500);
      }
      log.transition('none', 'pending', { idempotent: error?.code === '23505' });
    }

    // Set for a plan: stored with the plan it was checked for, so complete-payment can hold the
    // payment to both. A retry may send different metadata from the first attempt's row
    let approvedPlanFields: { approved_amount_pi: number; metadata: typeof paymentRequest.metadata } | null = null;

    // Cancels the payment at Pi and marks the row, for a payment that mustn't be approved
    const cancelAtPi = async (error: string) => {
      try {
        const cancelResponse = await fetch(`https://api.minepi.com/v2/payments/${paymentRequest.paymentId}/cancel`, {
          method: 'POST',
          headers: {
            'Authorization': `Key ${piApiKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (!cancelResponse.ok) {
          log.warn(`${FN}.pi_api.cancel_failed`, { stage: 'pi_api', status: cancelResponse.status });
        }
      } catch (cancelError) {
        log.warn(`${FN}.pi_api.cancel_exception`, {
          stage: 'pi_api',
          message: cancelError instanceof Error ? cancelError.message : String(cancelError),
        });
      }
      await supabaseClient.from('payments').update({
        status: {
          approved: false,
          verified: false,
          completed: false,
          cancelled: true,
          error,
        },
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);
      log.transition('pending', 'cancelled', { terminalReason: 'cancelled', source: error });
    };

    // The payment as Pi has it, for every kind: who is paying, and (for a plan) the amount the user
    // would sign. Never from the request body
    let piAmount: number | null = null;
    let piUserUid: string | null = null;
    let piFetched = false;
    try {
      const piGetResp = await fetch(`https://api.minepi.com/v2/payments/${paymentRequest.paymentId}`, {
        method: 'GET',
        headers: {
          'Authorization': `Key ${piApiKey}`,
          'Content-Type': 'application/json',
        },
      });
      if (piGetResp.ok) {
        const piPayment = await piGetResp.json();
        piFetched = true;
        const amt = Number(piPayment?.amount);
        if (Number.isFinite(amt) && amt > 0) piAmount = amt;
        piUserUid = typeof piPayment?.user_uid === 'string' && piPayment.user_uid ? piPayment.user_uid : null;
      } else {
        // Pi's own error text (never the key): says whether it rejects the key or can't see the payment
        const piErrorBody = (await piGetResp.text().catch(() => '')).slice(0, 300);
        log.warn(`${FN}.pi_api.get_payment_failed`, {
          stage: 'pi_api',
          status: piGetResp.status,
          piErrorBody,
          keyLength: piApiKey.length,
          keyHasWhitespace: /\s/.test(piApiKey),
        });
      }
    } catch (getErr) {
      log.warn(`${FN}.pi_api.get_payment_exception`, {
        stage: 'pi_api',
        message: getErr instanceof Error ? getErr.message : String(getErr),
      });
    }

    // Left pending, so approving again can still work
    if (!piFetched) {
      log.error(`${FN}.verify.payment_unavailable`, { stage: 'pi_api' });
      return respond({ success: false, message: 'Unable to verify payment' }, 502);
    }

    // Who holds this visit's token, in this app. Pi uids are per app and one project serves both
    // apps, so users.pi_uid can't be compared with the payment's. Left pending if Pi won't say
    let piMe: { uid: string; username: string } | null = null;
    try {
      const meResp = await fetch('https://api.minepi.com/v2/me', {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${piAccessToken}` },
      });
      if (meResp.ok) {
        const me = await meResp.json();
        // Without both we can't say who this is, which isn't the same as a different account
        if (typeof me?.uid === 'string' && me.uid && typeof me?.username === 'string' && me.username) {
          piMe = { uid: me.uid, username: me.username };
        }
        if (!piMe) log.warn(`${FN}.pi_api.me_incomplete`, { stage: 'pi_api' });
      } else {
        log.warn(`${FN}.pi_api.me_failed`, { stage: 'pi_api', status: meResp.status });
      }
    } catch (meErr) {
      log.warn(`${FN}.pi_api.me_exception`, {
        stage: 'pi_api',
        message: meErr instanceof Error ? meErr.message : String(meErr),
      });
    }
    if (!piMe) {
      return respond({ ...PI_TOKEN_INVALID, paymentId: paymentRequest.paymentId }, 401);
    }

    // The token holder must be the payer in this app, and the payer this account (a Pi username is
    // the same in every app)
    const { data: payer, error: payerError } = await supabaseClient
      .from('users')
      .select('username')
      .eq('id', paymentRequest.userId)
      .maybeSingle();
    if (payerError) {
      log.error(`${FN}.verify.user_lookup_error`, { stage: 'lookup', code: payerError.code });
      return respond({ success: false, message: 'Payment processing failed. Please try again.' }, 500);
    }
    const signedInUsername = payer?.username ?? null;
    if (
      !piUserUid ||
      piMe.uid !== piUserUid ||
      !signedInUsername ||
      piMe.username.toLowerCase() !== signedInUsername.toLowerCase()
    ) {
      log.error(`${FN}.verify.payment_user_mismatch`, {
        stage: 'validation',
        piUserUid: shortUid(piUserUid),
        piMeUid: shortUid(piMe.uid),
        piMeUsername: shortUid(piMe.username),
        signedInUsername: shortUid(signedInUsername),
      });
      await cancelAtPi('payment_user_mismatch');
      return respond({ ...PAYMENT_USER_MISMATCH, paymentId: paymentRequest.paymentId }, 403);
    }

    if (expectedPlanPi !== null) {
      if (piAmount === null) {
        log.error(`${FN}.verify.amount_unavailable`, { stage: 'pi_api' });
        return respond({ success: false, message: 'Unable to verify payment amount' }, 502);
      }

      if (piAmount < expectedPlanPi * AMOUNT_TOLERANCE) {
        log.warn(`${FN}.verify.amount_mismatch`, { stage: 'validation', piAmount, expectedPi: expectedPlanPi });
        await cancelAtPi('amount_mismatch');
        return respond({
          success: false,
          error_code: 'amount_mismatch',
          message: 'The payment amount does not match the plan price',
          expectedPi: expectedPlanPi,
          paymentId: paymentRequest.paymentId,
        }, 400);
      }

      approvedPlanFields = { approved_amount_pi: piAmount, metadata: paymentRequest.metadata };
    }

    log.info(`${FN}.pi_api.call`, { stage: 'pi_api' });
    try {
      const piNetworkApiUrl = 'https://api.minepi.com/v2/payments';
      const approveResponse = await fetch(`${piNetworkApiUrl}/${paymentRequest.paymentId}/approve`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${piApiKey}`,
          'Content-Type': 'application/json',
        },
      });

      const approveResult = await approveResponse.json();
      log.info(`${FN}.pi_api.response`, {
        stage: 'pi_api',
        ok: approveResponse.ok,
        status: approveResponse.status,
      });

      if (!approveResponse.ok) {
        if (approveResult.message?.includes('already approved')) {
          await supabaseClient.from('payments').update({
            status: {
              approved: true,
              verified: false,
              completed: false,
              cancelled: false,
            },
            ...(approvedPlanFields ?? {}),
            updated_at: new Date().toISOString(),
          }).eq('payment_id', paymentRequest.paymentId);

          log.transition('pending', 'approved', { source: 'pi_already_approved' });
          return respond({
            success: true,
            message: 'Payment was already approved',
            paymentId: paymentRequest.paymentId,
          });
        }

        await supabaseClient.from('payments').update({
          status: {
            approved: false,
            verified: false,
            completed: false,
            cancelled: true,
            error: `Pi Network API error: ${JSON.stringify(approveResult)}`,
          },
          updated_at: new Date().toISOString(),
        }).eq('payment_id', paymentRequest.paymentId);

        log.error(`${FN}.pi_api.error`, { stage: 'pi_api', result: approveResult });
        log.transition('pending', 'cancelled', { terminalReason: 'error', source: 'pi_api_error' });
        return respond({ success: false, message: 'Payment approval failed. Please try again.' }, 502);
      }

      await supabaseClient.from('payments').update({
        status: {
          approved: true,
          verified: false,
          completed: false,
          cancelled: false,
        },
        ...(approvedPlanFields ?? {}),
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);
      log.transition('pending', 'approved');

      // SECURITY: Do NOT grant subscription tiers on approval.
      // Approval only signals intent — the on-chain Pi transfer has not
      // been completed or verified yet. Subscription changes are applied
      // exclusively in `complete-payment` after the payment is confirmed
      // completed and the amount is validated server-side.


      log.info(`${FN}.done`, { stage: 'done', durationMs: Date.now() - startTime });
      return respond({
        success: true,
        message: 'Payment approved successfully',
        paymentId: paymentRequest.paymentId,
      });
    } catch (apiError) {
      log.error(`${FN}.pi_api.exception`, {
        stage: 'pi_api',
        message: apiError instanceof Error ? apiError.message : String(apiError),
      });
      await supabaseClient.from('payments').update({
        status: {
          approved: false,
          verified: false,
          completed: false,
          cancelled: true,
          error: `API call error: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
        },
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);
      log.transition('pending', 'cancelled', { terminalReason: 'error', source: 'pi_api_exception' });

      return respond({ success: false, message: 'Payment service temporarily unavailable. Please try again.' }, 502);
    }
  } catch (error) {
    log.error(`${FN}.unhandled`, {
      stage: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return respond({ success: false, message: 'Payment service error. Please try again later.' }, 500);
  }
});
