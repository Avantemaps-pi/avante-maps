import React from 'react';
import { useLocation, useNavigate, useParams } from '@/lib/router-compat';
import { motion } from '@/components/ui/motion';
import { Skeleton } from '@/components/ui/skeleton';
import { useIsMobile } from '@/hooks/use-mobile';
import { hasInAppHistory } from '@/lib/inAppHistory';
import { useOwnedBusiness } from '@/hooks/useOwnedBusiness';
import { EditListingSection } from '@/components/business/edit/EditListingSection';
import { findListingSection } from '@/components/business/edit/listingSections';
import AppLayout from '@/components/layout/AppLayout';

// Edit listing → one section (/update-registration/$businessId/$section), with only its fields
const UpdateRegistrationSection = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { businessId, section: sectionId } = useParams();
  const isMobile = useIsMobile();
  const section = findListingSection(sectionId);
  const { business, isLoading, error } = useOwnedBusiness(businessId);
  const state = location.state as {
    fromOverview?: boolean;
    focusField?: string;
  } | null;

  // Opened from the overview: back to it. Otherwise back where we came from (e.g. Wallet), or to
  // the overview on a direct load
  const leave = () => {
    if (state?.fromOverview || hasInAppHistory()) {
      navigate(-1);
    } else {
      navigate(`/update-registration/${businessId}`, { replace: true });
    }
  };

  // After a save: always to the overview, with its summary updated
  const leaveAfterSave = () => {
    if (state?.fromOverview) {
      navigate(-1);
    } else {
      navigate(`/update-registration/${businessId}`, { replace: true });
    }
  };

  return (
    <AppLayout
      title="Edit listing"
      backButton={true}
      hideBottomNav={true}
      onBackClick={leave}
    >
      <motion.div
        className="w-full max-w-2xl mx-auto px-4"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        skipMobileAnimations={isMobile}
      >
        {!section ? (
          <div className="bg-destructive/10 border border-destructive/30 text-foreground p-4 rounded-md">
            This part of the listing doesn't exist.
          </div>
        ) : isLoading ? (
          <div
            className="w-full space-y-4 py-2"
            aria-busy="true"
            aria-label="Loading business information"
          >
            <Skeleton className="h-6 w-1/2" />
            <Skeleton className="h-11 w-full" />
            <Skeleton className="h-11 w-full" />
          </div>
        ) : business ? (
          <EditListingSection
            business={business}
            section={section}
            focusField={state?.focusField}
            onLeave={leaveAfterSave}
          />
        ) : (
          <div className="bg-destructive/10 border border-destructive/30 text-foreground p-4 rounded-md">
            {error ?? 'Failed to load business information. Please try again.'}
          </div>
        )}
      </motion.div>
    </AppLayout>
  );
};

export default UpdateRegistrationSection;
