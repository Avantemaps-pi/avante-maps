import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { AMOUNT_TOLERANCE, getExpectedPlanPi } from '../_shared/prices.ts';
import {
  getOrCreateLifecycleId,
  makeLogger,
  correlationHeaders,
} from '../_shared/logger.ts';

const FN = 'complete-payment';

const PLAN_NOT_ACTIVATED = {
  success: false,
  error_code: 'plan_not_activated',
  message: 'Payment received, but your plan could not be activated. Please contact support.',
};

const AMOUNT_MISMATCH_AFTER_COMPLETION = {
  success: false,
  error_code: 'amount_mismatch_after_completion',
  message: "Payment received, but it doesn't match the price. Please contact support.",
};

const PAYMENT_USER_MISMATCH = {
  success: false,
  error_code: 'payment_user_mismatch',
  message: "This payment was started from a different Pi account. Sign in with the account you're paying from.",
};

const FEE_NOT_RECORDED = {
  success: false,
  message: 'Payment completed but the message fee could not be recorded. Please try again.',
};

// The row's status once the Pi has moved
const COMPLETED_STATUS = { approved: true, verified: true, completed: true, cancelled: false };

// Pi uids in logs: enough to tell them apart, never the whole value
const shortUid = (uid: unknown) => (typeof uid === 'string' && uid ? `${uid.slice(0, 6)}…` : null);

const PLAN_NAMES: Record<string, string> = {
  individual: 'Individual',
  'small-business': 'Small Business',
  organization: 'Organization',
};
const planName = (tier: string) => PLAN_NAMES[tier] ?? tier;

interface PaymentNotification {
  kind: 'topup_received' | 'plan_paid' | 'plan_not_activated';
  content: string;
  metadata: Record<string, unknown>;
  actionLabel: string;
  clickUrl: string;
}

// The user's in-app notification, in the Notifications page's metadata contract (kind,
// actionLabel; click_url the action's path). Never throws: a payment isn't undone by it
async function notifyPayment(
  supabase: typeof supabaseClient,
  userId: string,
  n: PaymentNotification,
): Promise<{ success: boolean; error?: string }> {
  try {
    const { error } = await supabase.from('notifications').insert({
      user_id: userId,
      type: 'payment',
      content: n.content,
      metadata: { ...n.metadata, kind: n.kind, actionLabel: n.actionLabel },
      priority: 'high',
      read: false,
      delivery_status: 'delivered',
      delivered_at: new Date().toISOString(),
      click_url: n.clickUrl,
    });
    return error ? { success: false, error: error.message } : { success: true };
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// A top up, or a plan paid for and active: the same text as before
const notifyPaymentReceived = (
  supabase: typeof supabaseClient,
  userId: string,
  amount: number,
  subscriptionTier?: string,
) =>
  notifyPayment(supabase, userId, {
    kind: subscriptionTier ? 'plan_paid' : 'topup_received',
    content: `Payment of ${amount} Pi received successfully!${subscriptionTier ? ` Your ${subscriptionTier} subscription is now active.` : ''}`,
    metadata: { amount, tier: subscriptionTier, status: 'approved' },
    actionLabel: subscriptionTier ? 'View plan' : 'Open wallet',
    clickUrl: subscriptionTier ? '/pricing' : '/wallet',
  });

const PaymentRequestSchema = z.object({
  paymentId: z.string()
    .min(1, 'Payment ID is required')
    .max(100, 'Payment ID too long')
    .regex(/^[a-zA-Z0-9_-]+$/, 'Invalid payment ID format'),
  txid: z.string()
    .min(1, 'Transaction ID is required')
    .max(128, 'Transaction ID too long')
    .regex(/^[a-fA-F0-9]+$/, 'Invalid transaction ID format'),
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

  // Grants the plan once per payment and records it on the row. Returns the failure to send, or
  // whether this call granted it (false: an earlier call for this payment already did)
  const activatePlan = async (
    paymentId: string,
    txid: string,
    userId: string,
    tier: string,
    frequency: 'monthly' | 'annual',
  ): Promise<{ failure: Response } | { granted: boolean }> => {
    let planError: string | null = null;
    let granted = true;
    try {
      const { data: grantedNow, error: subscriptionError } = await supabaseClient.rpc('handle_subscription_after_payment', {
        p_user_id: userId,
        p_username: null,
        p_email: null,
        p_subscription_tier: tier,
        p_frequency: frequency,
        p_payment_id: paymentId,
      });
      if (subscriptionError) planError = subscriptionError.message;
      // false: this payment's plan was granted before. (Before the migration it returned nothing)
      granted = grantedNow !== false;
    } catch (subscriptionErr) {
      planError = subscriptionErr instanceof Error ? subscriptionErr.message : String(subscriptionErr);
    }

    const baseStatus = { approved: true, verified: true, completed: true, cancelled: false };

    if (planError !== null) {
      log.error(`${FN}.subscription.not_activated`, { stage: 'db_write', tier, message: planError });
      // Marked on the row so a retry doesn't report success, and so support can find it
      await supabaseClient.from('payments').update({
        status: { ...baseStatus, error: 'plan_not_activated' },
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentId);
      // Told once, here where it's first recorded (a retry gets the terminal answer without this)
      const notified = await notifyPayment(supabaseClient, userId, {
        kind: 'plan_not_activated',
        content: `Payment received for the ${planName(tier)} plan, but your plan isn't active yet. Contact support and we'll sort it out.`,
        metadata: { tier, status: 'plan_not_activated' },
        actionLabel: 'Contact support',
        clickUrl: '/contact',
      });
      if (!notified.success) {
        log.warn(`${FN}.notify.error`, { stage: 'notify', message: notified.error });
      }
      return { failure: respond({ ...PLAN_NOT_ACTIVATED, paymentId, txid }, 500) };
    }

    log.info(granted ? `${FN}.subscription.created` : `${FN}.subscription.already_granted`, { stage: 'db_write', tier });
    const { error: markError } = await supabaseClient.from('payments').update({
      status: { ...baseStatus, plan_activated: true },
      updated_at: new Date().toISOString(),
    }).eq('payment_id', paymentId);
    if (markError) {
      log.error(`${FN}.subscription.mark_failed`, { stage: 'db_write', message: markError.message });
    }
    return { granted };
  };

  // The Pi has moved, but it wasn't the price. Marked so a retry gets this answer rather than success
  const refuseAmountAfterCompletion = async (paymentId: string, txid: string) => {
    await supabaseClient.from('payments').update({
      status: {
        approved: true,
        verified: true,
        completed: true,
        cancelled: false,
        error: 'amount_mismatch_after_completion',
      },
      updated_at: new Date().toISOString(),
    }).eq('payment_id', paymentId);
    return respond({ ...AMOUNT_MISMATCH_AFTER_COMPLETION, paymentId, txid }, 400);
  };

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

    log.extend({
      paymentId: paymentRequest.paymentId,
      userId: paymentRequest.userId,
      txid: paymentRequest.txid,
    });
    log.info(`${FN}.validation.ok`, { stage: 'validation', amount: paymentRequest.amount });

    const piApiKey = Deno.env.get('PI_API_KEY');
    if (!piApiKey) {
      log.error(`${FN}.config.missing_api_key`, { stage: 'error' });
      return respond({ success: false, message: 'Payment service not configured' }, 500);
    }

    const { data: existingPayment, error: lookupError } = await supabaseClient
      .from('payments')
      .select('user_id, txid, status, metadata, approved_amount_pi')
      .eq('payment_id', paymentRequest.paymentId)
      .maybeSingle();

    if (lookupError) {
      log.error(`${FN}.lookup.error`, {
        stage: 'lookup',
        code: lookupError.code,
        message: lookupError.message,
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

    const piNetworkApiUrl = 'https://api.minepi.com/v2/payments';

    // The payment as Pi has it: the amount that moved and the Pi account that paid. null when Pi
    // can't be reached (nothing is changed then, so a retry can carry on)
    const fetchPiPayment = async (): Promise<{ amount: number | null; userUid: string | null } | null> => {
      try {
        const piGetResp = await fetch(`${piNetworkApiUrl}/${paymentRequest.paymentId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Key ${piApiKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (!piGetResp.ok) {
          log.warn(`${FN}.pi_api.get_payment_failed`, { stage: 'pi_api', status: piGetResp.status });
          return null;
        }
        const piPayment = await piGetResp.json();
        const amt = Number(piPayment?.amount);
        return {
          amount: Number.isFinite(amt) && amt > 0 ? amt : null,
          userUid: typeof piPayment?.user_uid === 'string' && piPayment.user_uid ? piPayment.user_uid : null,
        };
      } catch (getErr) {
        log.warn(`${FN}.pi_api.get_payment_exception`, {
          stage: 'pi_api',
          message: getErr instanceof Error ? getErr.message : String(getErr),
        });
        return null;
      }
    };

    // Whether the Pi account that paid is the signed-in user's (users.pi_uid). Never throws: an
    // exception in the completion block below would mark the row cancelled
    const checkPayer = async (piUserUid: string | null): Promise<'match' | 'mismatch' | 'error'> => {
      const { data: payer, error: payerError } = await supabaseClient
        .from('users')
        .select('pi_uid')
        .eq('id', paymentRequest.userId)
        .maybeSingle();
      if (payerError) {
        log.error(`${FN}.verify.user_lookup_error`, { stage: 'lookup', code: payerError.code });
        return 'error';
      }
      const signedInPiUid = payer?.pi_uid ?? null;
      if (signedInPiUid && piUserUid && signedInPiUid === piUserUid) return 'match';
      log.error(`${FN}.verify.payment_user_mismatch`, {
        stage: 'validation',
        piUserUid: shortUid(piUserUid),
        signedInPiUid: shortUid(signedInPiUid),
      });
      return 'mismatch';
    };

    // Paid from another Pi account: nothing is credited, recorded or granted. The Pi has moved, so
    // the row stays completed, marked so a retry gets the same answer
    const refusePayer = async (txid: string) => {
      await supabaseClient.from('payments').update({
        status: { ...COMPLETED_STATUS, error: 'payment_user_mismatch' },
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);
      return respond({ ...PAYMENT_USER_MISMATCH, paymentId: paymentRequest.paymentId, txid }, 403);
    };

    // Pi's payment, checked: the response to send instead, or the amount that moved
    const verifiedPayment = async (txid: string): Promise<{ response: Response } | { amount: number }> => {
      const piPayment = await fetchPiPayment();
      if (!piPayment || piPayment.amount === null) {
        log.error(`${FN}.verify.amount_unavailable`, { stage: 'validation' });
        return {
          response: respond({
            success: false,
            message: 'Unable to verify payment amount',
            paymentId: paymentRequest.paymentId,
            txid,
          }, 502),
        };
      }
      const payer = await checkPayer(piPayment.userUid);
      if (payer === 'error') {
        return { response: respond({ success: false, message: 'Payment processing failed. Please try again.' }, 500) };
      }
      if (payer === 'mismatch') return { response: await refusePayer(txid) };
      return { amount: piPayment.amount };
    };

    // A top up: Pi's amount is credited (once per payment), and the row says so
    const creditTopUp = async (txid: string, amount: number): Promise<Response> => {
      const { data: earlierCredit } = await supabaseClient
        .from('wallet_ledger')
        .select('id')
        .eq('payment_id', paymentRequest.paymentId)
        .maybeSingle();
      const { data: newBalance, error: creditError } = await supabaseClient.rpc(
        'credit_wallet_balance',
        {
          p_user_id: paymentRequest.userId,
          p_amount_pi: amount,
          p_payment_id: paymentRequest.paymentId,
          p_transaction_type: 'deposit',
        },
      );

      if (creditError) {
        log.error(`${FN}.wallet_topup.credit_failed`, {
          stage: 'error',
          message: creditError.message,
        });
        return respond({
          success: false,
          message: 'Payment completed but wallet credit failed. Please contact support.',
          paymentId: paymentRequest.paymentId,
          txid,
        }, 500);
      }

      await supabaseClient.from('payments').update({
        status: { ...COMPLETED_STATUS, credited: true },
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);
      log.info(`${FN}.wallet_topup.credited`, {
        stage: 'db_write',
        amount,
        newBalance,
        alreadyCredited: !!earlierCredit,
      });

      // Told once: not again for a payment credited before
      if (!earlierCredit) {
        const notified = await notifyPaymentReceived(supabaseClient, paymentRequest.userId, amount);
        if (notified.success) {
          log.info(`${FN}.notify.created`, { stage: 'notify' });
        } else {
          log.warn(`${FN}.notify.error`, { stage: 'notify', message: notified.error });
        }
      }

      log.info(`${FN}.done`, {
        stage: 'done',
        terminalReason: 'completed',
        durationMs: Date.now() - startTime,
      });
      return respond({
        success: true,
        message: 'Wallet credited successfully',
        paymentId: paymentRequest.paymentId,
        txid,
        newBalance,
      });
    };

    // A message fee: at least the platform fee must have moved; the fee row is written (once per
    // payment) and the row says so. The response to send instead, or whether it was written now
    const recordMessageFee = async (
      txid: string,
      amount: number,
      md: { conversationId?: string; businessId?: number },
    ): Promise<{ response: Response } | { recordedNow: boolean }> => {
      const { data: feeSetting, error: feeSettingErr } = await supabaseClient
        .from('platform_settings')
        .select('value')
        .eq('key', 'unverified_message_fee_pi')
        .maybeSingle();
      const expectedFeePi = Number(feeSetting?.value ?? 0.5);
      if (feeSettingErr || !Number.isFinite(expectedFeePi) || expectedFeePi <= 0) {
        log.error(`${FN}.verify.fee_setting_unavailable`, { stage: 'validation' });
        return { response: respond({ success: false, message: 'Fee setting unavailable' }, 503) };
      }
      if (amount < expectedFeePi * AMOUNT_TOLERANCE) {
        log.error(`${FN}.verify.message_fee_amount_mismatch`, {
          stage: 'validation', expectedFeePi, verifiedPiAmount: amount,
        });
        return { response: await refuseAmountAfterCompletion(paymentRequest.paymentId, txid) };
      }

      let feeUsd = 0;
      try {
        const { data: priceRow } = await supabaseClient
          .from('pi_price').select('price_usd').limit(1).maybeSingle();
        feeUsd = Number(priceRow?.price_usd ?? 0) * expectedFeePi;
      } catch (_) { /* non-fatal */ }

      const { data: earlierFee } = await supabaseClient
        .from('message_fees')
        .select('id')
        .eq('payment_id', paymentRequest.paymentId)
        .maybeSingle();
      // payment_id is UNIQUE, so a duplicate completion can't create two fee rows. ignoreDuplicates
      // avoids overwriting a row that may already have message_id attached. The fee is pinned to
      // the server's value, never the request's
      const { error: feeError } = await supabaseClient
        .from('message_fees')
        .upsert({
          conversation_id: md.conversationId,
          sender_id: paymentRequest.userId,
          business_id: md.businessId,
          fee_pi: expectedFeePi,
          fee_usd: feeUsd,
          payment_id: paymentRequest.paymentId,
          platform_share_pi: expectedFeePi,
          business_share_pi: 0,
          status: 'paid',
        }, { onConflict: 'payment_id', ignoreDuplicates: true });
      if (feeError) {
        // Not marked, so a retry records it
        log.error(`${FN}.message_fee.insert_error`, { stage: 'db_write', message: feeError.message });
        return { response: respond({ ...FEE_NOT_RECORDED, paymentId: paymentRequest.paymentId, txid }, 500) };
      }
      await supabaseClient.from('payments').update({
        status: { ...COMPLETED_STATUS, fee_recorded: true },
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);
      log.info(`${FN}.message_fee.recorded`, {
        stage: 'db_write', conversationId: md.conversationId, alreadyRecorded: !!earlierFee,
      });
      return { recordedNow: !earlierFee };
    };

    if (existingPayment?.status?.completed) {
      if (existingPayment.txid && existingPayment.txid !== paymentRequest.txid) {
        log.error(`${FN}.lookup.txid_mismatch`, {
          stage: 'lookup',
          recorded: existingPayment.txid,
        });
        return respond({
          success: false,
          message: 'Transaction ID mismatch on completed payment',
        }, 409);
      }
      const txid = existingPayment.txid ?? paymentRequest.txid;
      if (existingPayment.status.error === 'payment_user_mismatch') {
        log.error(`${FN}.terminal.payment_user_mismatch`, { stage: 'transition' });
        return respond({ ...PAYMENT_USER_MISMATCH, paymentId: paymentRequest.paymentId, txid }, 403);
      }
      // A retry mustn't report success for a payment that never got its plan
      if (existingPayment.status.error === 'plan_not_activated') {
        log.error(`${FN}.terminal.plan_not_activated`, { stage: 'transition' });
        return respond({
          ...PLAN_NOT_ACTIVATED,
          paymentId: paymentRequest.paymentId,
          txid,
        }, 500);
      }
      if (existingPayment.status.error === 'amount_mismatch_after_completion') {
        log.error(`${FN}.terminal.amount_mismatch_after_completion`, { stage: 'transition' });
        return respond({
          ...AMOUNT_MISMATCH_AFTER_COMPLETION,
          paymentId: paymentRequest.paymentId,
          txid,
        }, 400);
      }
      // The function died between completing and granting, crediting or recording. The row says
      // what was paid for, whatever this request says
      const rowKind = existingPayment.metadata?.kind;
      const approvedTier = existingPayment.metadata?.subscriptionTier;
      if (
        approvedTier &&
        existingPayment.approved_amount_pi != null &&
        !existingPayment.status.plan_activated &&
        !existingPayment.status.error
      ) {
        log.warn(`${FN}.terminal.granting_missed_plan`, { stage: 'transition', tier: approvedTier });
        const checked = await verifiedPayment(txid);
        if ('response' in checked) return checked.response;
        const plan = await activatePlan(
          paymentRequest.paymentId,
          txid,
          paymentRequest.userId,
          approvedTier,
          existingPayment.metadata?.frequency === 'annual' ? 'annual' : 'monthly',
        );
        if ('failure' in plan) return plan.failure;
        if (plan.granted) {
          const notified = await notifyPaymentReceived(
            supabaseClient,
            paymentRequest.userId,
            Number(existingPayment.approved_amount_pi),
            approvedTier,
          );
          if (!notified.success) {
            log.warn(`${FN}.notify.error`, { stage: 'notify', message: notified.error });
          }
        }
        return respond({
          success: true,
          message: 'Payment completed successfully',
          paymentId: paymentRequest.paymentId,
          txid,
          subscriptionCreated: true,
        });
      }
      if (rowKind === 'wallet_topup' && !existingPayment.status.credited && !existingPayment.status.error) {
        log.warn(`${FN}.terminal.crediting_missed_topup`, { stage: 'transition' });
        const checked = await verifiedPayment(txid);
        if ('response' in checked) return checked.response;
        return await creditTopUp(txid, checked.amount);
      }
      if (rowKind === 'message_fee' && !existingPayment.status.fee_recorded && !existingPayment.status.error) {
        log.warn(`${FN}.terminal.recording_missed_fee`, { stage: 'transition' });
        const checked = await verifiedPayment(txid);
        if ('response' in checked) return checked.response;
        const fee = await recordMessageFee(txid, checked.amount, existingPayment.metadata ?? {});
        if ('response' in fee) return fee.response;
        if (fee.recordedNow) {
          const notified = await notifyPaymentReceived(supabaseClient, paymentRequest.userId, checked.amount);
          if (!notified.success) {
            log.warn(`${FN}.notify.error`, { stage: 'notify', message: notified.error });
          }
        }
        return respond({
          success: true,
          message: 'Payment completed successfully',
          paymentId: paymentRequest.paymentId,
          txid,
          subscriptionCreated: false,
        });
      }
      log.info(`${FN}.terminal.idempotent`, { stage: 'transition', terminalReason: 'completed' });
      return respond({
        success: true,
        message: 'Payment was already completed',
        paymentId: paymentRequest.paymentId,
        txid,
      });
    }

    if (existingPayment?.status?.cancelled) {
      log.warn(`${FN}.terminal.refused`, {
        stage: 'transition',
        terminalReason: 'cancelled',
      });
      return respond({
        success: false,
        message: 'Payment was cancelled and cannot be completed',
      }, 409);
    }

    log.info(`${FN}.pi_api.call`, { stage: 'pi_api' });
    try {
      const completeResponse = await fetch(`${piNetworkApiUrl}/${paymentRequest.paymentId}/complete`, {
        method: 'POST',
        headers: {
          'Authorization': `Key ${piApiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ txid: paymentRequest.txid }),
      });

      const completeResult = await completeResponse.json();
      log.info(`${FN}.pi_api.response`, {
        stage: 'pi_api',
        ok: completeResponse.ok,
        status: completeResponse.status,
      });

      const piAlreadyCompleted = !completeResponse.ok && !!completeResult.message?.includes('already completed');

      if (!completeResponse.ok && !piAlreadyCompleted) {
        await supabaseClient.from('payments').update({
          status: {
            approved: true,
            verified: false,
            completed: false,
            cancelled: true,
            error: `Pi Network completion API error: ${JSON.stringify(completeResult)}`,
          },
          lifecycle_id: lifecycleId,
          updated_at: new Date().toISOString(),
        }).eq('payment_id', paymentRequest.paymentId);

        log.error(`${FN}.pi_api.error`, { stage: 'pi_api', result: completeResult });
        log.transition(existingPayment?.status ?? null, 'cancelled', {
          terminalReason: 'error',
          source: 'pi_api_error',
        });
        return respond({
          success: false,
          message: 'Payment completion failed. Please try again.',
        }, 502);
      }

      await supabaseClient.from('payments').update({
        status: {
          approved: true,
          verified: true,
          completed: true,
          cancelled: false,
          ...(existingPayment?.status?.plan_activated ? { plan_activated: true } : {}),
        },
        txid: paymentRequest.txid,
        lifecycle_id: lifecycleId,
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);

      log.transition(existingPayment?.status ?? 'approved', 'completed', {
        terminalReason: 'completed',
        ...(piAlreadyCompleted ? { source: 'pi_already_completed' } : {}),
      });

      // Pi says it was completed earlier: carry on only for what may have been missed, and only
      // for this user's own row. With no row, anyone could claim a stranger's completed payment
      if (piAlreadyCompleted) {
        const requestKind = paymentRequest.metadata?.kind;
        const rowStatus = existingPayment?.status ?? {};
        const canCarryOn = existingPayment?.approved_amount_pi != null
          ? !rowStatus.plan_activated
          : existingPayment?.metadata?.kind === requestKind &&
            ((requestKind === 'wallet_topup' && !rowStatus.credited) ||
              (requestKind === 'message_fee' && !rowStatus.fee_recorded));
        if (!canCarryOn) {
          log.info(`${FN}.terminal.idempotent`, { stage: 'transition', terminalReason: 'completed', source: 'pi_already_completed' });
          return respond({
            success: true,
            message: 'Payment was already completed',
            paymentId: paymentRequest.paymentId,
            txid: paymentRequest.txid,
          });
        }
      }

      // ✅ SECURITY: Verify the real completed Pi amount matches the
      // server-computed expected price for the requested tier/fee.
      // Never trust client-supplied `amount` or `metadata.feePi` to
      // grant subscriptions or fee-gated messaging rights.
      // Also: the Pi account that paid must be the signed-in user's, before anything is credited,
      // recorded or granted
      const checked = await verifiedPayment(paymentRequest.txid);
      if ('response' in checked) return checked.response;
      const verifiedPiAmount = checked.amount;

      // An amount approved for a plan only buys that plan, whatever this request asks for. Otherwise
      // it could be credited as a top up, and the plan granted from the row on a retry as well
      if (existingPayment?.approved_amount_pi != null) {
        const approvedTier = existingPayment.metadata?.subscriptionTier;
        const approvedFreq = existingPayment.metadata?.frequency === 'annual' ? 'annual' : 'monthly';
        const requestFreq = paymentRequest.metadata?.frequency === 'annual' ? 'annual' : 'monthly';
        if (paymentRequest.metadata?.subscriptionTier !== approvedTier || requestFreq !== approvedFreq) {
          log.error(`${FN}.verify.plan_not_approved`, {
            stage: 'validation',
            tier: paymentRequest.metadata?.subscriptionTier,
            freq: requestFreq,
            approvedTier,
            approvedFreq,
          });
          return respond({
            success: false,
            message: 'Payment does not match the plan that was approved',
          }, 400);
        }
      }

      // Wallet top-ups have no fixed expected price (user picks the amount),
      // so the Pi-API-confirmed `verifiedPiAmount` is the only trustworthy
      // number to credit. Never trust `paymentRequest.amount` or metadata.
      if (paymentRequest.metadata?.kind === 'wallet_topup') {
        return await creditTopUp(paymentRequest.txid, verifiedPiAmount);
      }

      if (paymentRequest.metadata?.subscriptionTier) {
        const tier = paymentRequest.metadata.subscriptionTier;
        const freq = paymentRequest.metadata.frequency === 'annual' ? 'annual' : 'monthly';
        if (existingPayment?.approved_amount_pi != null) {
          // Checked against the price at approval, so a price move since can't refuse a payment
          // the user has signed
          const approvedPi = Number(existingPayment.approved_amount_pi);
          if (verifiedPiAmount < approvedPi * AMOUNT_TOLERANCE) {
            log.error(`${FN}.verify.subscription_amount_mismatch`, {
              stage: 'validation', tier, freq, approvedPi, verifiedPiAmount,
            });
            return await refuseAmountAfterCompletion(paymentRequest.paymentId, paymentRequest.txid);
          }
        } else {
          // Payments approved before approved_amount_pi existed
          const expected = await getExpectedPlanPi(supabaseClient, tier, freq);
          if (!expected.ok && expected.error === 'invalid_tier') {
            log.error(`${FN}.verify.unknown_tier`, { stage: 'validation', tier, freq });
            return respond({ success: false, message: 'Invalid subscription tier' }, 400);
          }
          if (!expected.ok) {
            log.error(`${FN}.verify.pi_price_unavailable`, { stage: 'validation' });
            return respond({ success: false, message: 'Price service unavailable' }, 503);
          }
          const { expectedPi } = expected;
          if (verifiedPiAmount < expectedPi * AMOUNT_TOLERANCE) {
            log.error(`${FN}.verify.subscription_amount_mismatch`, {
              stage: 'validation', tier, freq, expectedPi, verifiedPiAmount,
            });
            return await refuseAmountAfterCompletion(paymentRequest.paymentId, paymentRequest.txid);
          }
        }
      }

      // Told once per payment: not again when the fee was recorded or the plan granted before
      let notify = true;
      if (paymentRequest.metadata?.kind === 'message_fee') {
        const fee = await recordMessageFee(paymentRequest.txid, verifiedPiAmount, paymentRequest.metadata);
        if ('response' in fee) return fee.response;
        notify = fee.recordedNow;
      }

      if (paymentRequest.metadata?.subscriptionTier) {
        const plan = await activatePlan(
          paymentRequest.paymentId,
          paymentRequest.txid,
          paymentRequest.userId,
          paymentRequest.metadata.subscriptionTier,
          paymentRequest.metadata.frequency === 'annual' ? 'annual' : 'monthly',
        );
        if ('failure' in plan) return plan.failure;
        notify = plan.granted;
      }

      if (notify) {
        const notified = await notifyPaymentReceived(
          supabaseClient,
          paymentRequest.userId,
          paymentRequest.amount,
          paymentRequest.metadata?.subscriptionTier
        );
        if (notified.success) {
          log.info(`${FN}.notify.created`, { stage: 'notify' });
        } else {
          log.warn(`${FN}.notify.error`, { stage: 'notify', message: notified.error });
        }
      }

      log.info(`${FN}.done`, {
        stage: 'done',
        terminalReason: 'completed',
        durationMs: Date.now() - startTime,
      });
      return respond({
        success: true,
        message: 'Payment completed successfully',
        paymentId: paymentRequest.paymentId,
        txid: paymentRequest.txid,
        subscriptionCreated: !!paymentRequest.metadata?.subscriptionTier,
      });
    } catch (apiError) {
      log.error(`${FN}.pi_api.exception`, {
        stage: 'pi_api',
        message: apiError instanceof Error ? apiError.message : String(apiError),
      });

      await supabaseClient.from('payments').update({
        status: {
          approved: true,
          verified: false,
          completed: false,
          cancelled: true,
          error: `API call error: ${apiError instanceof Error ? apiError.message : String(apiError)}`,
        },
        lifecycle_id: lifecycleId,
        updated_at: new Date().toISOString(),
      }).eq('payment_id', paymentRequest.paymentId);

      log.transition(existingPayment?.status ?? null, 'cancelled', {
        terminalReason: 'error',
        source: 'pi_api_exception',
      });

      return respond({
        success: false,
        message: 'Payment completion temporarily unavailable',
        paymentId: paymentRequest.paymentId,
        txid: paymentRequest.txid,
      }, 502);
    }
  } catch (error) {
    log.error(`${FN}.unhandled`, {
      stage: 'error',
      message: error instanceof Error ? error.message : String(error),
    });
    return respond({ success: false, message: 'Payment completion service temporarily unavailable' }, 500);
  }
});
