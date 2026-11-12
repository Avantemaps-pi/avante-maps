
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';
import { corsHeaders } from '../_shared/cors.ts';
import { createPiPayments, type PiPayments } from '../_shared/piPaymentsClient.ts';
import { z } from 'https://deno.land/x/zod@v3.22.4/mod.ts';

// Validation schema for cleanup request. paymentId: only that payment, at any age (the wallet
// closed without signing it). Without it: every stale payment of the user
const CleanupRequestSchema = z.object({
  // Not used: the user comes from the token
  userId: z.string().optional(),
  paymentId: z.string().trim().min(1).max(200).optional(),
});

type CleanupRequest = z.infer<typeof CleanupRequestSchema>;

const supabaseClient = createClient(
  Deno.env.get('SUPABASE_URL') ?? '',
  Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? '',
);

// Check if a payment is stale (older than 10 minutes and not completed)
function isStalePayment(payment: any): boolean {
  const createdAt = new Date(payment.created_at).getTime();
  const now = Date.now();
  const tenMinutesInMs = 10 * 60 * 1000; // 10 minutes
  
  return (
    !payment.status.completed && 
    !payment.status.cancelled && 
    (now - createdAt) > tenMinutesInMs
  );
}

const UNSIGNED_CANCEL_ERROR = 'Cancelled: not signed in the Pi wallet';

// One payment the wallet closed without signing (not enough funds, or the user cancelled): cancelled
// at Pi and in its row at once, but only when it's the caller's, still open, and Pi confirms nothing
// was signed. If Pi shows a transaction it's left alone: { signed: true } (with the txid) lets the
// client complete it the usual way
async function cancelUnsignedPayment(
  piPayments: PiPayments,
  userId: string,
  paymentId: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const { data: row, error: rowError } = await supabaseClient
    .from('payments')
    .select('payment_id, user_id, status, txid')
    .eq('payment_id', paymentId)
    .maybeSingle();
  if (rowError) {
    console.error(`Error reading payment ${paymentId}:`, rowError);
    return { status: 500, body: { success: false, message: 'Service temporarily unavailable' } };
  }
  if (!row) {
    return { status: 404, body: { success: false, message: 'Payment not found', cleanedCount: 0 } };
  }
  if (row.user_id !== userId) {
    console.warn(`Payment ${paymentId} does not belong to the caller: not changed`);
    return { status: 403, body: { success: false, message: 'Not your payment', cleanedCount: 0 } };
  }
  if (row.status?.completed || row.status?.cancelled) {
    return { status: 200, body: { success: true, message: 'Payment already finished', cleanedCount: 0 } };
  }

  // Pi decides whether anything was signed, with the key of the app that has the payment
  const found = await piPayments.getPayment(paymentId);
  if (!found.ok) {
    console.log(`Pi Network lookup failed for ${paymentId} (pi_app ${found.app}):`, found.status ?? found.reason);
    return { status: 502, body: { success: false, message: 'Could not check the payment with Pi', cleanedCount: 0 } };
  }
  const piStatus = (found.payment['status'] ?? {}) as Record<string, unknown>;
  const transaction = found.payment['transaction'] as { txid?: unknown } | null | undefined;
  if (transaction || piStatus['transaction_verified'] || piStatus['developer_completed']) {
    const txid = typeof transaction?.txid === 'string' ? transaction.txid : null;
    console.log(`Payment ${paymentId} has a transaction at Pi (pi_app ${found.app}): not cancelled`);
    return { status: 200, body: { success: true, signed: true, txid, message: 'Payment was signed', cleanedCount: 0 } };
  }

  // Already cancelled at Pi: only our row is left to mark
  if (!piStatus['cancelled']) {
    const cancelResponse = await found.client.cancel(paymentId);
    console.log(`Pi Network cancel response for ${paymentId} (pi_app ${found.client.app}):`, cancelResponse.status);
    if (!cancelResponse.ok) {
      // Signed in the moment between, or Pi refused: the row stays for the stale cleanup
      return { status: 502, body: { success: false, message: 'Pi did not cancel the payment', cleanedCount: 0 } };
    }
  }

  // Only while the row isn't completed: a completion can still arrive for this payment
  const { data: changed, error: updateError } = await supabaseClient
    .from('payments')
    .update({
      status: {
        approved: false,
        verified: false,
        completed: false,
        cancelled: true,
        error: UNSIGNED_CANCEL_ERROR,
      },
      updated_at: new Date().toISOString(),
    })
    .eq('payment_id', paymentId)
    .eq('user_id', userId)
    .eq('status->completed', false)
    .select('payment_id');
  if (updateError) {
    console.error(`Error updating payment ${paymentId}:`, updateError);
    return { status: 500, body: { success: false, message: 'Service temporarily unavailable' } };
  }
  const cleanedCount = changed?.length ?? 0;
  return {
    status: 200,
    body: { success: true, cancelled: cleanedCount > 0, message: `Cancelled ${cleanedCount} unsigned payment`, cleanedCount },
  };
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    // Authenticate user via JWT
    const authHeader = req.headers.get('authorization');
    if (!authHeader) {
      return new Response(
        JSON.stringify({ success: false, message: 'Authentication required' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error: authError } = await supabaseClient.auth.getUser(token);
    
    if (authError || !user) {
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid authentication' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 401 }
      );
    }

    // Use authenticated user's ID
    const userId = user.id;

    const parsed = CleanupRequestSchema.safeParse(await req.json().catch(() => ({})));
    if (!parsed.success) {
      return new Response(
        JSON.stringify({ success: false, message: 'Invalid request' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 400 }
      );
    }
    const { paymentId } = parsed.data;
    console.log(paymentId
      ? `Cancelling unsigned payment ${paymentId} for authenticated user`
      : `Cleaning up stale payments for authenticated user`);

    // Testnet and Mainnet app keys: each payment is cancelled in the app that has it
    const piPayments = createPiPayments();
    if (!piPayments) {
      console.error('PI_API_KEY not configured');
      return new Response(
        JSON.stringify({ success: false, message: 'Service temporarily unavailable' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      );
    }

    if (paymentId) {
      const { status, body } = await cancelUnsignedPayment(piPayments, userId, paymentId);
      return new Response(JSON.stringify(body), {
        headers: { ...corsHeaders, 'Content-Type': 'application/json' },
        status,
      });
    }

    // Find all stale payments for this user
    const { data: payments, error: fetchError } = await supabaseClient
      .from('payments')
      .select('*')
      .eq('user_id', userId)
      .eq('status->completed', false)
      .eq('status->cancelled', false);

    if (fetchError) {
      console.error('Error fetching payments:', fetchError);
      return new Response(
        JSON.stringify({ success: false, message: 'Service temporarily unavailable' }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
      );
    }

    if (!payments || payments.length === 0) {
      return new Response(
        JSON.stringify({ success: true, message: 'No stale payments found', cleanedCount: 0 }),
        { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const stalePayments = payments.filter(isStalePayment);
    let cleanedCount = 0;

    console.log(`Found ${stalePayments.length} stale payments to clean up`);

    // Clean up each stale payment
    for (const payment of stalePayments) {
      try {
        console.log(`Cleaning up stale payment: ${payment.payment_id}`);

        // Try to cancel with Pi Network API, with the key of the app that has the payment
        const located = await piPayments.findClient(payment.payment_id);
        if (located.ok) {
          const cancelResponse = await located.client.cancel(payment.payment_id);
          console.log(`Pi Network cancel response for ${payment.payment_id} (pi_app ${located.client.app}):`, cancelResponse.status);
        } else {
          console.log(`Pi Network lookup failed for ${payment.payment_id} (pi_app ${located.app}):`, located.status ?? located.reason);
        }

        // Update our database regardless of Pi Network response
        const { error: updateError } = await supabaseClient
          .from('payments')
          .update({
            status: {
              approved: false,
              verified: false,
              completed: false,
              cancelled: true,
              error: 'Payment automatically cancelled due to staleness (>10 minutes old)'
            },
            updated_at: new Date().toISOString()
          })
          .eq('payment_id', payment.payment_id);

        if (!updateError) {
          cleanedCount++;
          console.log(`Successfully cleaned up payment: ${payment.payment_id}`);
        } else {
          console.error(`Error updating payment ${payment.payment_id}:`, updateError);
        }

      } catch (error) {
        console.error(`Error cleaning up payment ${payment.payment_id}:`, error);
        // Continue with other payments even if one fails
      }
    }

    console.log(`Cleanup completed. Cleaned ${cleanedCount} stale payments.`);

    return new Response(
      JSON.stringify({ 
        success: true, 
        message: `Cleaned up ${cleanedCount} stale payments`, 
        cleanedCount 
      }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
    );

  } catch (error) {
    console.error('Error in cleanup-stale-payments function:', error);
    return new Response(
      JSON.stringify({ success: false, message: 'Service temporarily unavailable' }),
      { headers: { ...corsHeaders, 'Content-Type': 'application/json' }, status: 500 }
    );
  }
});
