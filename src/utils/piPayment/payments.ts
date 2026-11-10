/**
 * Pi Payment Utilities – Clean Rewrite
 * ------------------------------------
 * Works with the new core.ts
 */

import {
  initializePiNetwork,
  createPiPayment,
  getPiAuthResult,
  setIncompletePaymentHandler,
} from '../piNetwork/core';

import type {
  PiPaymentInitiateOptions,
  PaymentCallbacks,
} from '../piNetwork/types';

import { approvePayment, completePayment } from '@/api/payments';
import { supabase } from '@/integrations/supabase/client';
import { generateLifecycleId } from '@/utils/correlation';

// State tracking
let paymentInProgress = false;
// Separate lock for wallet top-ups — a subscription purchase and a wallet
// top-up are distinct flows and shouldn't block one another.
let walletTopUpInProgress = false;

export interface PaymentResult {
  success: boolean;
  message: string;
  shouldRefreshUser?: boolean;
  paymentId?: string;
  /** Why the server refused, when it says: amount_mismatch, plan_not_activated, amount_mismatch_after_completion */
  errorCode?: string;
}

/**
 * Ensures the Pi SDK is fully initialized before doing anything.
 */
export async function initPiForPayments(): Promise<void> {
  const ok = await initializePiNetwork();

  if (!ok) {
    throw new Error('Failed to initialize Pi Network SDK');
  }
}

/**
 * Start a payment (full metadata + callbacks).
 * This is now the unified entry point your UI calls.
 */
export async function startPayment(
  options: PiPaymentInitiateOptions,
  callbacks?: PaymentCallbacks
) {
  // Guarantee SDK + auth loaded
  await initPiForPayments();

  const paymentData = {
    amount: options.amount,
    memo: options.memo,
    metadata: options.metadata || {}
  };
  const noopCallbacks: PaymentCallbacks = {
    onReadyForServerApproval: () => {},
    onReadyForServerCompletion: () => {},
    onCancel: () => {},
    onError: () => {},
  };
  return await createPiPayment(paymentData, callbacks ?? noopCallbacks);
}

/**
 * Execute a subscription payment with full flow.
 *
 * NOTE: This is the per-period U2A flow used today. When the Pi Network
 * PiRC2 subscription contract ships and `FEATURE_FLAGS.pirc2Subscriptions`
 * is enabled (see `src/config/featureFlags.ts`), monthly renewals should
 * be driven server-side via an allowance-based charge job instead.
 * Rationale and migration plan: docs/pirc2-integration.md
 */
export async function executeSubscriptionPayment(
  amountPi: number,
  tier: string,
  frequency: 'monthly' | 'yearly',
  hooks?: { onPaymentId?: (paymentId: string) => void; planName?: string }
): Promise<PaymentResult> {
  if (paymentInProgress) {
    return {
      success: false,
      message: 'A payment is already in progress'
    };
  }
  
  paymentInProgress = true;
  
  try {
    // Ensure SDK is ready
    await initPiForPayments();
    
    // Try cached auth first; if missing, re-authenticate with Pi SDK
    let authResult = getPiAuthResult();
    if (!authResult) {
      try {
        const { authenticate } = await import('../piNetwork/core');
        authResult = await authenticate(['username', 'payments', 'wallet_address']);
      } catch (authError: any) {
        return {
          success: false,
          message: authError.message || 'Please authenticate with Pi Network first'
        };
      }
    }

    // Get Supabase UUID (not Pi UID) for edge function calls
    const { data: { session } } = await supabase.auth.getSession();
    const supabaseUserId = session?.user?.id;
    if (!supabaseUserId) {
      return {
        success: false,
        message: 'Please log in to your account first'
      };
    }

    const normalizedFrequency = frequency === 'yearly' ? 'annual' : frequency;
    const memo = `${hooks?.planName ?? tier} plan (${frequency})`;
    const metadata = {
      subscriptionTier: tier,
      frequency: normalizedFrequency,
    };

    // Single lifecycle ID for the full approve → complete → status flow.
    const lifecycleId = generateLifecycleId('subpay');
    const FN_LC = 'client.executeSubscriptionPayment';
    const lcEmit = (
      level: 'info' | 'warn' | 'error',
      event: string,
      stage: string,
      extra?: Record<string, unknown>
    ) => {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        fn: FN_LC,
        stage,
        lifecycleId,
        tier,
        frequency: normalizedFrequency,
        ...(extra ?? {}),
      });
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    };
    lcEmit('info', `${FN_LC}.lifecycle.start`, 'validation');

    return new Promise<PaymentResult>((resolve) => {
      const callbacks: PaymentCallbacks = {
        onReadyForServerApproval: async (paymentId: string) => {
          lcEmit('info', `${FN_LC}.approve.start`, 'pi_api', { paymentId });
          try {
            hooks?.onPaymentId?.(paymentId);
            const approvalResult = await approvePayment(
              { paymentId, userId: supabaseUserId, amount: amountPi, memo, metadata },
              { lifecycleId }
            );
            lcEmit('info', `${FN_LC}.approve.result`, 'pi_api', {
              paymentId,
              success: approvalResult.success,
            });
            if (!approvalResult.success) {
              resolve({
                success: false,
                message: approvalResult.message,
                paymentId,
                ...(approvalResult.error_code ? { errorCode: approvalResult.error_code } : {}),
              });
            }
          } catch (error) {
            lcEmit('error', `${FN_LC}.approve.exception`, 'error', {
              paymentId,
              terminalReason: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
            resolve({
              success: false,
              message: 'Failed to approve payment on server',
            });
          }
        },
        onReadyForServerCompletion: async (paymentId: string, txid: string) => {
          lcEmit('info', `${FN_LC}.complete.start`, 'pi_api', { paymentId, txid });
          try {
            const completionResult = await completePayment(
              { paymentId, userId: supabaseUserId, amount: amountPi, memo, metadata, txid },
              { lifecycleId }
            );
            lcEmit('info', `${FN_LC}.complete.result`, 'pi_api', {
              paymentId,
              txid,
              success: completionResult.success,
              terminalReason: completionResult.success ? 'completed' : 'error',
            });
            if (!completionResult.success) {
              resolve({
                success: false,
                message: completionResult.message,
                paymentId,
                ...(completionResult.error_code ? { errorCode: completionResult.error_code } : {}),
              });
              return;
            }
            resolve({
              success: true,
              message: `Successfully subscribed to ${tier} plan!`,
              shouldRefreshUser: true,
              paymentId,
            });
          } catch (error) {
            lcEmit('error', `${FN_LC}.complete.exception`, 'error', {
              paymentId,
              txid,
              terminalReason: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
            resolve({
              success: false,
              message: 'Payment completed but failed to update subscription',
            });
          }
        },
        onCancel: (paymentId: string) => {
          lcEmit('info', `${FN_LC}.cancel`, 'transition', {
            paymentId,
            terminalReason: 'cancelled',
          });
          resolve({
            success: false,
            message: 'Payment was cancelled',
          });
        },
        onError: (error: Error) => {
          lcEmit('error', `${FN_LC}.error`, 'error', {
            terminalReason: 'error',
            message: error.message,
          });
          resolve({
            success: false,
            message: error.message || 'Payment failed',
          });
        },
      };

      createPiPayment({ amount: amountPi, memo, metadata }, callbacks)
        .catch((error) => {
          console.error('Failed to create payment:', error);
          resolve({
            success: false,
            message: error.message || 'Failed to create payment'
          });
        });
    });
  } catch (error: any) {
    return {
      success: false,
      message: error.message || 'Payment failed'
    };
  } finally {
    paymentInProgress = false;
  }
}

/**
 * Check if a payment is currently in progress
 */
export function isPaymentInProgress(): boolean {
  return paymentInProgress;
}

/**
 * Reset the payment state
 */
export function resetPaymentState(): void {
  paymentInProgress = false;
}

/**
 * Fetches the latest Pi Auth payload from localStorage (if any).
 * Useful for restoring sessions after reload.
 */
export { getPiAuthResult };

/**
 * Registers the cross-session handler for unfinished payments.
 */
export { setIncompletePaymentHandler };

/**
 * Execute a wallet top-up payment.
 *
 * Mirrors executeSubscriptionPayment's structure (SDK init → cached auth or
 * re-auth → fresh Supabase UUID → lifecycle logging → approve/complete
 * callbacks), simplified for a metadata `kind: 'wallet_topup'` payment.
 *
 * Uses its own lock: a wallet top-up and a subscription purchase are separate
 * flows and shouldn't block each other, but two concurrent top-ups should not
 * be possible.
 */
export async function executeWalletTopUp(
  amountPi: number,
  hooks?: { onPaymentId?: (paymentId: string) => void }
): Promise<PaymentResult> {
  if (walletTopUpInProgress) {
    return {
      success: false,
      message: 'A wallet top-up is already in progress'
    };
  }

  walletTopUpInProgress = true;

  try {
    await initPiForPayments();

    // Try cached auth first; if missing, re-authenticate with Pi SDK
    let authResult = getPiAuthResult();
    if (!authResult) {
      try {
        const { authenticate } = await import('../piNetwork/core');
        authResult = await authenticate(['username', 'payments', 'wallet_address']);
      } catch (authError) {
        return {
          success: false,
          message: authError instanceof Error
            ? authError.message
            : 'Please authenticate with Pi Network first'
        };
      }
    }

    // Get Supabase UUID (not Pi UID) for edge function calls
    const { data: { session } } = await supabase.auth.getSession();
    const supabaseUserId = session?.user?.id;
    if (!supabaseUserId) {
      return {
        success: false,
        message: 'Please log in to your account first'
      };
    }

    const memo = `Wallet top-up (${amountPi} Pi)`;
    const metadata = { kind: 'wallet_topup' as const };

    const lifecycleId = generateLifecycleId('wallettopup');
    const FN_LC = 'client.executeWalletTopUp';
    const lcEmit = (
      level: 'info' | 'warn' | 'error',
      event: string,
      stage: string,
      extra?: Record<string, unknown>
    ) => {
      const line = JSON.stringify({
        ts: new Date().toISOString(),
        level,
        event,
        fn: FN_LC,
        stage,
        lifecycleId,
        amountPi,
        ...(extra ?? {}),
      });
      if (level === 'error') console.error(line);
      else if (level === 'warn') console.warn(line);
      else console.log(line);
    };
    lcEmit('info', `${FN_LC}.lifecycle.start`, 'validation');

    // Awaited, so the lock is held until the payment finishes (not just until it starts)
    return await new Promise<PaymentResult>((resolve) => {
      const callbacks: PaymentCallbacks = {
        onReadyForServerApproval: async (paymentId: string) => {
          lcEmit('info', `${FN_LC}.approve.start`, 'pi_api', { paymentId });
          try {
            hooks?.onPaymentId?.(paymentId);
            const approvalResult = await approvePayment(
              { paymentId, userId: supabaseUserId, amount: amountPi, memo, metadata },
              { lifecycleId }
            );
            lcEmit('info', `${FN_LC}.approve.result`, 'pi_api', {
              paymentId,
              success: approvalResult.success,
            });
            // Refused (e.g. payment_user_mismatch): the server's message, not a silent wait
            if (!approvalResult.success) {
              resolve({
                success: false,
                message: approvalResult.message || 'The payment could not be approved',
                paymentId,
                ...(approvalResult.error_code ? { errorCode: approvalResult.error_code } : {}),
              });
            }
          } catch (error) {
            lcEmit('error', `${FN_LC}.approve.exception`, 'error', {
              paymentId,
              terminalReason: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
            resolve({
              success: false,
              message: 'Failed to approve payment on server',
            });
          }
        },
        onReadyForServerCompletion: async (paymentId: string, txid: string) => {
          lcEmit('info', `${FN_LC}.complete.start`, 'pi_api', { paymentId, txid });
          try {
            const completionResult = await completePayment(
              { paymentId, userId: supabaseUserId, amount: amountPi, memo, metadata, txid },
              { lifecycleId }
            );
            lcEmit('info', `${FN_LC}.complete.result`, 'pi_api', {
              paymentId,
              txid,
              success: completionResult.success,
              terminalReason: completionResult.success ? 'completed' : 'error',
            });
            // Only a completion the server confirms is a success: a 403, 500 or 502 shows its message
            if (!completionResult.success) {
              resolve({
                success: false,
                message: completionResult.message || 'The top up could not be completed',
                paymentId,
                ...(completionResult.error_code ? { errorCode: completionResult.error_code } : {}),
              });
              return;
            }
            // The authoritative balance is refetched by the UI via
            // get_wallet_balance — we deliberately ignore any inline balance
            // value returned by the completion response.
            resolve({
              success: true,
              message: 'Wallet topped up successfully!',
              shouldRefreshUser: false,
              paymentId,
            });
          } catch (error) {
            lcEmit('error', `${FN_LC}.complete.exception`, 'error', {
              paymentId,
              txid,
              terminalReason: 'error',
              message: error instanceof Error ? error.message : String(error),
            });
            resolve({
              success: false,
              message: 'Payment completed but failed to credit your wallet',
            });
          }
        },
        onCancel: (paymentId: string) => {
          lcEmit('info', `${FN_LC}.cancel`, 'transition', {
            paymentId,
            terminalReason: 'cancelled',
          });
          resolve({
            success: false,
            message: 'Payment was cancelled',
          });
        },
        onError: (error: Error) => {
          lcEmit('error', `${FN_LC}.error`, 'error', {
            terminalReason: 'error',
            message: error.message,
          });
          resolve({
            success: false,
            message: error.message || 'Payment failed',
          });
        },
      };

      createPiPayment({ amount: amountPi, memo, metadata }, callbacks)
        .catch((error) => {
          console.error('Failed to create wallet top-up payment:', error);
          resolve({
            success: false,
            message: error.message || 'Failed to create payment'
          });
        });
    });
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : 'Payment failed'
    };
  } finally {
    walletTopUpInProgress = false;
  }
}
