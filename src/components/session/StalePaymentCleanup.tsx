import { useEffect } from 'react';
import { useAuth } from '@/context/auth';
import { cleanupStalePaymentsThrottled } from '@/utils/piPayment/cleanup';
import { secureLog } from '@/utils/secureLogger';

/**
 * When the app starts (and when someone signs in), quietly cancels the user's payments that never
 * completed and are over 10 minutes old, so Recent activity doesn't show them as Pending. At most
 * once every 5 minutes per tab (shared with the Pricing page). Errors are only logged.
 *
 * Mount once near the app root, inside AuthProvider.
 */
export const StalePaymentCleanup = () => {
  const { user } = useAuth();

  useEffect(() => {
    if (!user?.uid) return;
    void cleanupStalePaymentsThrottled().then((result) => {
      if (result && !result.success) {
        secureLog.warn('Stale payment cleanup failed', {
          message: result.message,
        });
      }
    });
  }, [user?.uid]);

  return null;
};

export default StalePaymentCleanup;
