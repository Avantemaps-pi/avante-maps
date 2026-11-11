
/**
 * Payment API types
 */

export interface PaymentRequest {
  paymentId: string;
  userId: string;
  amount: number;
  memo: string;
  metadata: Record<string, any>;
  /** This visit's Pi access token: the server asks Pi who holds it (Pi uids are per app) */
  piAccessToken: string | undefined;
}

export interface PaymentResponse {
  success: boolean;
  message: string;
  paymentId?: string;
  txid?: string;
  status?: PaymentStatus;
  /** End-to-end lifecycle ID linking client + server logs for this attempt. */
  lifecycleId?: string;
  /** Backwards-compatible alias for lifecycleId. */
  correlationId?: string;
  /** Why the server refused, when it says: amount_mismatch, plan_not_activated, amount_mismatch_after_completion */
  error_code?: string;
  /** Canonical terminal outcome when known. */
  terminalReason?: 'completed' | 'cancelled' | 'voided' | 'error' | 'timeout' | null;
}

export interface PaymentStatus {
  paymentId: string;
  txid?: string;
  verified: boolean;
  completed: boolean;
  cancelled: boolean;
  error?: string;
}

export interface StoredPayment {
  id: string;
  userId: string;
  amount: number;
  memo: string;
  metadata: Record<string, any>;
  txid?: string;
  status: {
    verified: boolean;
    completed: boolean;
    cancelled: boolean;
    error?: string;
  };
  createdAt: number;
  updatedAt: number;
}

// In-memory store kept for backward compatibility during transition
// Will be deprecated once database integration is complete
export const paymentStore: Record<string, StoredPayment> = {};
