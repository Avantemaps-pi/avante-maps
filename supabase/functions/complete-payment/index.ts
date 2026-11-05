import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';
import { createPaymentNotification } from '../_shared/notifications.ts';
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

  // Grants the plan and records it on the row. Returns the failure to send, or null when granted
  const activatePlan = async (
    paymentId: string,
    txid: string,
    userId: string,
    tier: string,
    frequency: 'monthly' | 'annual',
  ): Promise<Response | null> => {
    let planError: string | null = null;
    try {
      const { error: subscriptionError } = await supabaseClient.rpc('handle_subscription_after_payment', {
        p_user_id: userId,
        p_username: null,
        p_email: null,
        p_subscription_tier: tier,
        p_frequency: frequency,
      });
      if (subscriptionError) planError = subscriptionError.message;
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
      return respond({ ...PLAN_NOT_ACTIVATED, paymentId, txid }, 500);
    }

    log.info(`${FN}.subscription.created`, { stage: 'db_write', tier });
    const { error: markError } = await supabaseClient.from('payments').update({
      status: { ...baseStatus, plan_activated: true },
      updated_at: new Date().toISOString(),
    }).eq('payment_id', paymentId);
    if (markError) {
      log.error(`${FN}.subscription.mark_failed`, { stage: 'db_write', message: markError.message });
    }
    return null;
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
      // A retry mustn't report success for a payment that never got its plan
      if (existingPayment.status.error === 'plan_not_activated') {
        log.error(`${FN}.terminal.plan_not_activated`, { stage: 'transition' });
        return respond({
          ...PLAN_NOT_ACTIVATED,
          paymentId: paymentRequest.paymentId,
          txid: existingPayment.txid ?? paymentRequest.txid,
        }, 500);
      }
      if (existingPayment.status.error === 'amount_mismatch_after_completion') {
        log.error(`${FN}.terminal.amount_mismatch_after_completion`, { stage: 'transition' });
        return respond({
          ...AMOUNT_MISMATCH_AFTER_COMPLETION,
          paymentId: paymentRequest.paymentId,
          txid: existingPayment.txid ?? paymentRequest.txid,
        }, 400);
      }
      // The function died between completing and granting. The row says which plan was paid for,
      // whatever this request says
      const approvedTier = existingPayment.metadata?.subscriptionTier;
      if (
        approvedTier &&
        existingPayment.approved_amount_pi != null &&
        !existingPayment.status.plan_activated &&
        !existingPayment.status.error
      ) {
        log.warn(`${FN}.terminal.granting_missed_plan`, { stage: 'transition', tier: approvedTier });
        const txid = existingPayment.txid ?? paymentRequest.txid;
        const failure = await activatePlan(
          paymentRequest.paymentId,
          txid,
          paymentRequest.userId,
          approvedTier,
          existingPayment.metadata?.frequency === 'annual' ? 'annual' : 'monthly',
        );
        if (failure) return failure;
        const notified = await createPaymentNotification(
          supabaseClient,
          paymentRequest.userId,
          Number(existingPayment.approved_amount_pi),
          approvedTier,
        );
        if (!notified.success) {
          log.warn(`${FN}.notify.error`, { stage: 'notify', message: notified.error });
        }
        return respond({
          success: true,
          message: 'Payment completed successfully',
          paymentId: paymentRequest.paymentId,
          txid,
          subscriptionCreated: true,
        });
      }
      log.info(`${FN}.terminal.idempotent`, { stage: 'transition', terminalReason: 'completed' });
      return respond({
        success: true,
        message: 'Payment was already completed',
        paymentId: paymentRequest.paymentId,
        txid: existingPayment.txid ?? paymentRequest.txid,
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
      const piNetworkApiUrl = 'https://api.minepi.com/v2/payments';
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
        const canCarryOn = existingPayment?.approved_amount_pi != null
          ? !existingPayment.status?.plan_activated
          : (requestKind === 'wallet_topup' || requestKind === 'message_fee') && existingPayment?.metadata?.kind === requestKind;
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
      let verifiedPiAmount: number | null = null;
      try {
        const piGetResp = await fetch(`${piNetworkApiUrl}/${paymentRequest.paymentId}`, {
          method: 'GET',
          headers: {
            'Authorization': `Key ${piApiKey}`,
            'Content-Type': 'application/json',
          },
        });
        if (piGetResp.ok) {
          const piPayment = await piGetResp.json();
          const amt = Number(piPayment?.amount);
          if (Number.isFinite(amt) && amt > 0) verifiedPiAmount = amt;
        } else {
          log.warn(`${FN}.pi_api.get_payment_failed`, {
            stage: 'pi_api', status: piGetResp.status,
          });
        }
      } catch (getErr) {
        log.warn(`${FN}.pi_api.get_payment_exception`, {
          stage: 'pi_api',
          message: getErr instanceof Error ? getErr.message : String(getErr),
        });
      }

      if (verifiedPiAmount == null) {
        log.error(`${FN}.verify.amount_unavailable`, { stage: 'verify' });
        return respond({
          success: false,
          message: 'Unable to verify payment amount',
          paymentId: paymentRequest.paymentId,
          txid: paymentRequest.txid,
        }, 502);
      }

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
        const { data: newBalance, error: creditError } = await supabaseClient.rpc(
          'credit_wallet_balance',
          {
            p_user_id: paymentRequest.userId,
            p_amount_pi: verifiedPiAmount,
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
            txid: paymentRequest.txid,
          }, 500);
        }

        log.info(`${FN}.wallet_topup.credited`, {
          stage: 'db_write',
          amount: verifiedPiAmount,
          newBalance,
        });

        try {
          await createPaymentNotification(
            supabaseClient,
            paymentRequest.userId,
            verifiedPiAmount,
          );
          log.info(`${FN}.notify.created`, { stage: 'notify' });
        } catch (notifError) {
          log.warn(`${FN}.notify.error`, {
            stage: 'notify',
            message: notifError instanceof Error ? notifError.message : String(notifError),
          });
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
          txid: paymentRequest.txid,
          newBalance,
        });
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
            log.error(`${FN}.verify.unknown_tier`, { stage: 'verify', tier, freq });
            return respond({ success: false, message: 'Invalid subscription tier' }, 400);
          }
          if (!expected.ok) {
            log.error(`${FN}.verify.pi_price_unavailable`, { stage: 'verify' });
            return respond({ success: false, message: 'Price service unavailable' }, 503);
          }
          const { expectedPi } = expected;
          if (verifiedPiAmount < expectedPi * AMOUNT_TOLERANCE) {
            log.error(`${FN}.verify.subscription_amount_mismatch`, {
              stage: 'verify', tier, freq, expectedPi, verifiedPiAmount,
            });
            return await refuseAmountAfterCompletion(paymentRequest.paymentId, paymentRequest.txid);
          }
        }
      }

      if (paymentRequest.metadata?.kind === 'message_fee') {
        const { data: feeSetting, error: feeSettingErr } = await supabaseClient
          .from('platform_settings')
          .select('value')
          .eq('key', 'unverified_message_fee_pi')
          .maybeSingle();
        const expectedFeePi = Number(feeSetting?.value ?? 0.5);
        if (feeSettingErr || !Number.isFinite(expectedFeePi) || expectedFeePi <= 0) {
          log.error(`${FN}.verify.fee_setting_unavailable`, { stage: 'verify' });
          return respond({ success: false, message: 'Fee setting unavailable' }, 503);
        }
        if (verifiedPiAmount < expectedFeePi * AMOUNT_TOLERANCE) {
          log.error(`${FN}.verify.message_fee_amount_mismatch`, {
            stage: 'verify', expectedFeePi, verifiedPiAmount,
          });
          return await refuseAmountAfterCompletion(paymentRequest.paymentId, paymentRequest.txid);
        }
        // Pin fee to the server-side expected value to prevent forged metadata.
        (paymentRequest.metadata as any).feePi = expectedFeePi;
      }

      if (paymentRequest.metadata?.kind === 'message_fee') {
        try {
          const md = paymentRequest.metadata as any;
          let feeUsd = 0;
          try {
            const { data: priceRow } = await supabaseClient
              .from('pi_price').select('price_usd').limit(1).maybeSingle();
            feeUsd = Number(priceRow?.price_usd ?? 0) * Number(md.feePi ?? paymentRequest.amount);
          } catch (_) { /* non-fatal */ }
          // Idempotent insert: payment_id is UNIQUE, so a duplicate
          // completion callback for the same Pi payment cannot create
          // two fee rows. ignoreDuplicates avoids overwriting a row
          // that may already have message_id attached.
          const { error: feeError } = await supabaseClient
            .from('message_fees')
            .upsert({
              conversation_id: md.conversationId,
              sender_id: paymentRequest.userId,
              business_id: md.businessId,
              fee_pi: md.feePi ?? paymentRequest.amount,
              fee_usd: feeUsd,
              payment_id: paymentRequest.paymentId,
              platform_share_pi: md.feePi ?? paymentRequest.amount,
              business_share_pi: 0,
              status: 'paid',
            }, { onConflict: 'payment_id', ignoreDuplicates: true });
          if (feeError) {
            log.warn(`${FN}.message_fee.insert_error`, {
              stage: 'db_write', message: feeError.message,
            });
          } else {
            log.info(`${FN}.message_fee.recorded`, {
              stage: 'db_write', conversationId: md.conversationId,
            });
          }
        } catch (feeErr) {
          log.error(`${FN}.message_fee.exception`, {
            stage: 'error',
            message: feeErr instanceof Error ? feeErr.message : String(feeErr),
          });
        }
      }


      if (paymentRequest.metadata?.subscriptionTier) {
        const failure = await activatePlan(
          paymentRequest.paymentId,
          paymentRequest.txid,
          paymentRequest.userId,
          paymentRequest.metadata.subscriptionTier,
          paymentRequest.metadata.frequency === 'annual' ? 'annual' : 'monthly',
        );
        if (failure) return failure;
      }

      try {
        await createPaymentNotification(
          supabaseClient,
          paymentRequest.userId,
          paymentRequest.amount,
          paymentRequest.metadata?.subscriptionTier
        );
        log.info(`${FN}.notify.created`, { stage: 'notify' });
      } catch (notifError) {
        log.warn(`${FN}.notify.error`, {
          stage: 'notify',
          message: notifError instanceof Error ? notifError.message : String(notifError),
        });
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
