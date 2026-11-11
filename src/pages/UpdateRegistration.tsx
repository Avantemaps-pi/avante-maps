
import React, { useEffect } from 'react';
import { useNavigate, useParams, useSearchParams } from '@/lib/router-compat';
import { motion } from '@/components/ui/motion';
import { useIsMobile } from '@/hooks/use-mobile';
import { hasInAppHistory } from '@/lib/inAppHistory';
import { useOwnedBusiness } from '@/hooks/useOwnedBusiness';
import EditListingOverview, { EditListingOverviewSkeleton } from '@/components/business/edit/EditListingOverview';
import { sectionForField } from '@/components/business/edit/listingSections';
import AppLayout from '@/components/layout/AppLayout';

// Edit listing: the overview of a business's sections. Each section opens on its own screen
const UpdateRegistration = () => {
  const navigate = useNavigate();
  const { businessId } = useParams();
  const [searchParams] = useSearchParams();
  const isMobile = useIsMobile();
  const { business, isLoading, error } = useOwnedBusiness(businessId);

  // An old link to a field (?field=piWalletAddress, or a notification's ?field=pi_wallet_address)
  // opens that field's section instead, focused on it. Back from there skips this overview
  const linkedField = searchParams.get('field');
  const linkedSection = sectionForField(linkedField);
  useEffect(() => {
    if (!linkedSection || !businessId) return;
    navigate(`/update-registration/${businessId}/${linkedSection}`, {
      replace: true,
      state: { focusField: linkedSection === 'wallet' ? 'piWalletAddress' : linkedField },
    });
  }, [linkedSection, linkedField, businessId, navigate]);

  // Back, or to the list when there's no earlier page in the app (a direct load or a link)
  const handleGoBack = () => {
    if (hasInAppHistory()) {
      navigate(-1);
    } else {
      navigate('/registered-business', { replace: true });
    }
  };

  return (
    <AppLayout
      title="Edit listing"
      backButton={true}
      hideBottomNav={true}
      onBackClick={handleGoBack}
    >
      <motion.div
        className="w-full max-w-2xl mx-auto px-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        skipMobileAnimations={isMobile}
      >
        {isLoading || linkedSection ? (
          <EditListingOverviewSkeleton />
        ) : business ? (
          <EditListingOverview business={business} />
        ) : (
          <div className="bg-destructive/10 border border-destructive/30 text-foreground p-4 rounded-md">
            {error ?? 'Failed to load business information. Please try again.'}
          </div>
        )}
      </motion.div>
    </AppLayout>
  );
};

export default UpdateRegistration;
