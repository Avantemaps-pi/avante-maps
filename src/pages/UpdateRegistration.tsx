
import React, { useEffect, useState, useRef } from 'react';
import { useLocation, useNavigate, useParams } from '@/lib/router-compat';
import { Loader2 } from 'lucide-react';
import { motion } from '@/components/ui/motion';
import { useIsMobile } from '@/hooks/use-mobile';
import { BusinessUpdateForm, BusinessUpdateFormRef } from '@/components/business/BusinessUpdateForm';
import { Business } from '@/types/business';
import { toast } from 'sonner';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth';
import { getSessionUserId } from '@/lib/sessionUserId';
import { secureLog } from '@/utils/secureLogger';
import { OWNED_BUSINESS_COLUMNS, isBusinessComplete, toOwnedBusiness, type OwnedBusinessRow } from '@/utils/ownedBusiness';
import AppLayout from '@/components/layout/AppLayout';

const UpdateRegistration = () => {
  const location = useLocation();
  const navigate = useNavigate();
  const { businessId } = useParams();
  const { user, isLoading: authLoading } = useAuth();
  const isMobile = useIsMobile();
  const [isLoading, setIsLoading] = useState(true);
  const [business, setBusiness] = useState<Business | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const businessUpdateFormRef = useRef<BusinessUpdateFormRef>(null);
  
  useEffect(() => {
    if (business) return;
    const stateBusiness = (location.state as { business?: Business } | null)?.business;
    const routeId = businessId && /^\d+$/.test(businessId) ? Number(businessId) : null;

    // From Your businesses, when it brought everything the form saves back
    if (stateBusiness && isBusinessComplete(stateBusiness) && (routeId === null || stateBusiness.id === routeId)) {
      setBusiness(stateBusiness);
      setIsLoading(false);
      return;
    }
    if (routeId === null) {
      setLoadError('No business data found. Please select a business to edit.');
      setIsLoading(false);
      return;
    }

    // A direct load or reload, or incomplete data: load it by the route's id
    let cancelled = false;
    (async () => {
      const sessionUserId = await getSessionUserId();
      if (cancelled) return;
      if (!sessionUserId) {
        // The session may still be restoring; this runs again when it settles
        if (authLoading) return;
        setLoadError('Please log in to edit your business.');
        setIsLoading(false);
        return;
      }
      setLoadError(null);
      const { data, error } = await supabase
        .from('businesses')
        .select(OWNED_BUSINESS_COLUMNS)
        .eq('id', routeId)
        .eq('owner_id', sessionUserId)
        .maybeSingle();
      if (cancelled) return;
      if (error) {
        secureLog.error('Error loading business to edit', { error });
        setLoadError('Failed to load business information. Please try again.');
      } else if (!data) {
        setLoadError("We couldn't find this business on your account.");
      } else {
        setBusiness(toOwnedBusiness(data as OwnedBusinessRow));
      }
      setIsLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [business, businessId, location.state, authLoading, user?.uid]);

  const handleGoBack = () => {
    if (businessUpdateFormRef.current) {
      businessUpdateFormRef.current.checkAndHandleBackNavigation();
    } else {
      navigate('/registered-business');
    }
  };

  const handleSuccess = () => {
    toast.success('Business information updated successfully!');
    navigate('/registered-business');
  };
  
  return (
    <AppLayout 
      title="Update Business" 
      backButton={true}
      hideBottomNav={true}
      onBackClick={handleGoBack}
    >
      <motion.div 
        className="w-full max-w-5xl mx-auto"
        initial={{ opacity: 0, y: 20 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.4 }}
        skipMobileAnimations={isMobile}
      >
        {isLoading ? (
          <div className="flex justify-center items-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <span className="ml-2 text-muted-foreground">Loading business information...</span>
          </div>
        ) : business ? (
          <BusinessUpdateForm 
            ref={businessUpdateFormRef}
            business={business} 
            onSuccess={handleSuccess}
          />
        ) : (
          <div className="bg-destructive/10 border border-destructive/30 text-foreground p-4 rounded-md">
            {loadError ?? 'Failed to load business information. Please try again.'}
          </div>
        )}
      </motion.div>
    </AppLayout>
  );
};

export default UpdateRegistration;
