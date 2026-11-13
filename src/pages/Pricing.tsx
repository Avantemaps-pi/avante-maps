
import React, { useState, useEffect, useRef } from 'react';
import { useLocation, useNavigate } from '@/lib/router-compat';
import { AlertDialog, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import AppLayout from '@/components/layout/AppLayout';
import { PricingSection } from '@/components/ui/pricing-section';

import { toast } from 'sonner';
import { TIERS } from '@/components/pricing/pricingTiers';
import { useAuth } from '@/context/auth';
import { useSubscriptionPayment } from '@/components/pricing/useSubscriptionPayment';
import { PaymentOutcomeBanner } from '@/components/pricing/PaymentOutcomeBanner';
import PlanCheckoutSheet from '@/components/pricing/PlanCheckoutSheet';
import MetaTags from '@/components/seo/MetaTags';
import { getOrigin } from '@/utils/browserEnv';
import { cleanupStalePaymentsThrottled } from '@/utils/piPayment/cleanup';
import { secureLog } from '@/utils/secureLogger';

interface PricingLocationState {
  upgradeNeeded?: boolean;
  fromLiveChat?: boolean;
  focusTier?: string;
}

const Pricing = () => {
  const { user, isAuthenticated } = useAuth();
  const location = useLocation();
  const locationState = location.state as PricingLocationState | null;
  const navigate = useNavigate();
  const [previousPlan, setPreviousPlan] = useState("");
  const [showDialog, setShowDialog] = useState(false);
  const lastAttemptedTier = useRef<string | null>(null);
  const [checkoutOpen, setCheckoutOpen] = useState(false);
  const [checkoutTier, setCheckoutTier] = useState<string | null>(null);
  // Get subscription payment utilities
  const {
    userSubscriptionTier,
    selectedFrequency,
    handleFrequencyChange,
    prepareCheckout,
    handleSubscribe,
    updateUserSubscription,
    isProcessingPayment,
    isPaymentLocked,
    paymentPolling,
    paymentOutcome,
    dismissPaymentOutcome,
  } = useSubscriptionPayment();
  const outcomeRef = useRef<HTMLDivElement>(null);

  // The banner is above the plans, so after tapping a plan lower down it is off screen: bring it
  // into view, and move focus to its heading so screen readers announce it
  const revealOutcome = () => {
    const wrapper = outcomeRef.current;
    if (!wrapper) return;
    const reduceMotion = window.matchMedia?.(
      '(prefers-reduced-motion: reduce)',
    ).matches;
    wrapper.scrollIntoView({
      behavior: reduceMotion ? 'auto' : 'smooth',
      block: 'start',
    });
    wrapper.querySelector<HTMLElement>('h3')?.focus({ preventScroll: true });
  };
  useEffect(() => {
    if (paymentOutcome) revealOutcome();
  }, [paymentOutcome]);
  
  // Handle frequency change
  const handleBillingChange = (frequency: string) => {
    handleFrequencyChange(frequency);
  };

  // Payments left unfinished earlier are cancelled before a new one starts (at most every 5 minutes
  // per tab, shared with the app start). Errors are only logged
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

  // Check if user was directed here from another page for subscription upgrade
  useEffect(() => {
    if (locationState && locationState.upgradeNeeded) {
      toast("Premium subscription required for this feature", {
        description: "Please subscribe to a paid plan to access this feature.",
        action: {
          label: "Dismiss",
          onClick: () => console.log("Dismissed"),
        },
      });
    }
    if (locationState?.fromLiveChat || locationState?.focusTier === 'organization') {
      setTimeout(() => {
        document.getElementById('tier-organization')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }, 250);
    }
  }, [locationState]);

  // Handle individual plan selection
  const handleIndividualPlanClick = async () => {
    if (userSubscriptionTier && userSubscriptionTier !== 'individual') {
      setPreviousPlan(userSubscriptionTier);
      setShowDialog(true);
    } else if (userSubscriptionTier !== 'individual') {
      // Update the subscription tier and refresh the UI
      await updateUserSubscription('individual');
    }
  };

  // A paid plan opens the checkout sheet, which offers the balance and the Pi Wallet
  const handlePaidPlanClick = async (tierId: string) => {
    if (!(await prepareCheckout(tierId))) return;
    setCheckoutTier(tierId);
    setCheckoutOpen(true);
  };

  const handlePayWithPi = async (tierId: string, amountPi: number) => {
    lastAttemptedTier.current = tierId;
    if ((await handleSubscribe(tierId, amountPi)) === 'amount_mismatch') {
      setCheckoutTier(tierId);
      setCheckoutOpen(true);
    }
  };

  // Focus returns to the plan's button, also on browsers where a tap doesn't focus it
  // If the payment already ended while the sheet was closing, the outcome banner gets focus instead
  const handleCheckoutCloseAutoFocus = (event: Event) => {
    event.preventDefault();
    if (paymentOutcome) {
      revealOutcome();
      return;
    }
    document.querySelector<HTMLElement>(`[data-plan-button="${checkoutTier}"]`)?.focus();
  };

  // Handle dialog confirmation
  const handleConfirmDowngrade = async () => {
    // Update the subscription tier and refresh the UI
    await updateUserSubscription('individual');
    toast.success('Your subscription has been updated to the Individual plan.');
    setShowDialog(false);
  };

  return (
    <AppLayout title="Pricing" hideBottomNav={true} backButton={true}>
      <MetaTags
        title="Pricing & Subscriptions"
        description="Choose the perfect subscription plan for your needs. Pay with Pi Network cryptocurrency. Individual, small business, and organization tiers available."
        keywords={['pi network pricing', 'subscription plans', 'pi payment', 'business subscription', 'cryptocurrency pricing']}
        ogType="website"
        ogTitle="Avante Maps Pricing - Pay with Pi"
        ogDescription="Flexible subscription plans powered by Pi Network"
        ogImage={{
          url: `${getOrigin()}/og-image.png`,
          width: 1200,
          height: 630,
          alt: 'Avante Maps Pricing'
        }}
        twitter={{
          card: 'summary_large_image',
          title: 'Pricing - Avante Maps',
          description: 'Choose your plan and pay with Pi cryptocurrency'
        }}
      />
      {/* scroll-mt-16: clear of the sticky header (h-16) when scrolled into view */}
      <div ref={outcomeRef} className="scroll-mt-16">
        <PaymentOutcomeBanner
          isPolling={paymentPolling.isPolling}
          // The row says completed before the plan is activated: no outcome until the payment has finished
          isTerminal={paymentPolling.isTerminal && !isProcessingPayment}
          terminalReason={paymentPolling.terminalReason}
          paymentId={paymentPolling.paymentId}
          retryDisabled={isPaymentLocked}
          {...(lastAttemptedTier.current
            ? {
                onRetry: () => {
                  paymentPolling.reset();
                  handlePaidPlanClick(lastAttemptedTier.current!);
                },
              }
            : {})}
          outcome={paymentOutcome}
          onDismiss={() => {
            paymentPolling.reset();
            dismissPaymentOutcome();
          }}
        />
      </div>
      <PricingSection
        title="Simple, transparent pricing"
        subtitle="Choose the plan that's right for you and explore Avante Maps with premium features."
        {...(userSubscriptionTier !== undefined ? { currentUserTier: userSubscriptionTier } : {})}
        tiers={TIERS.map(tier => ({
          ...tier,
          onSubscribe: () => {
            if (tier.id === 'individual') {
              handleIndividualPlanClick();
            } else {
              handlePaidPlanClick(tier.id);
            }
          },
          isLoading: isProcessingPayment || (paymentPolling.isPolling && !paymentPolling.isTerminal),
          disabled: isPaymentLocked,
        }))}
        frequencies={["monthly", "yearly"]}
        {...((locationState?.focusTier === 'organization' || locationState?.fromLiveChat) ? { organizationTierId: 'organization' } : {})}
        onFrequencyChange={handleBillingChange}
      />
      
      <PlanCheckoutSheet
        open={checkoutOpen}
        onOpenChange={setCheckoutOpen}
        tierId={checkoutTier}
        frequency={selectedFrequency}
        onPayWithPi={handlePayWithPi}
        onCloseAutoFocus={handleCheckoutCloseAutoFocus}
      />

      {/* Downgrade Confirmation Dialog */}
      <AlertDialog open={showDialog} onOpenChange={setShowDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Confirm Plan Change</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to change from your current {previousPlan ? previousPlan.charAt(0).toUpperCase() + previousPlan.slice(1).replace('-', ' ') : ''} plan to the Individual plan? 
              You'll lose access to premium features.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setShowDialog(false)}>Cancel</Button>
            <Button onClick={handleConfirmDowngrade}>Confirm Change</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </AppLayout>
  );
};

export default Pricing;
