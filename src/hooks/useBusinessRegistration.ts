import { useState, useEffect } from 'react';
import { useForm, type Resolver } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { formSchema, FormValues } from '@/components/business/registration/formSchema';
import { useNavigate } from '@/lib/router-compat';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth';
import { containsInappropriateContent } from '@/utils/contentFilter';
import type { BusinessInsertPayload } from '@/types/businessPayload';
import { useImageUpload } from '@/hooks/useImageUpload';
import { getBusinessLimit } from '@/hooks/useBusinessLimit';
import { getSupabaseFunctionsUrl } from '@/config/supabase';
import { formatFullAddress, geocodeAddress } from '@/components/business/registration/utils/addressUtils';

export const useBusinessRegistration = (onSuccess?: () => void) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [showAddressVerification, setShowAddressVerification] = useState(false);
  const [verifiedAddress, setVerifiedAddress] = useState<any>(null);
  const [showDuplicateWarning, setShowDuplicateWarning] = useState(false);
  const [similarBusinesses, setSimilarBusinesses] = useState<any[]>([]);
  const [pendingSubmission, setPendingSubmission] = useState<any>(null);
  const { user } = useAuth();
  const navigate = useNavigate();

  // Use the new image upload hook
  const imageUpload = useImageUpload({ maxImages: 3, bucketName: 'business-images' });

  const [piWalletAddress, setPiWalletAddress] = useState(user?.walletAddress || '');

  useEffect(() => {
    if (user?.walletAddress) setPiWalletAddress(user.walletAddress);
  }, [user]);

  const form = useForm<FormValues>({
    resolver: zodResolver(formSchema) as unknown as Resolver<FormValues>,
    defaultValues: {
      firstName: '',
      lastName: '',
      businessName: '',
      phone: '',
      email: '',
      website: '',
      streetAddress: '',
      apartment: '',
      city: '',
      state: '',
      zipCode: '',
      country: '',
      businessTypes: [],
      businessDescription: '',
      piWalletAddress,
      mondayOpen: '09:00',
      mondayClose: '17:00',
      mondayClosed: false,
      tuesdayOpen: '09:00',
      tuesdayClose: '17:00',
      tuesdayClosed: false,
      wednesdayOpen: '09:00',
      wednesdayClose: '17:00',
      wednesdayClosed: false,
      thursdayOpen: '09:00',
      thursdayClose: '17:00',
      thursdayClosed: false,
      fridayOpen: '09:00',
      fridayClose: '17:00',
      fridayClosed: false,
      saturdayOpen: '10:00',
      saturdayClose: '16:00',
      saturdayClosed: false,
      sundayOpen: '10:00',
      sundayClose: '16:00',
      sundayClosed: false,
    },
  });

  // ---------------------------
  // FORM SUBMISSION
  // ---------------------------
  const onSubmit = async (values: FormValues) => {
    try {
      if (!user?.uid) {
        toast.error('You must be logged in via Pi to register a business.');
        return;
      }

      // Check business count limit
      const { data: { session: countSession } } = await supabase.auth.getSession();
      const sessionOwnerId = countSession?.user?.id;

      if (!sessionOwnerId) {
        toast.error('Authentication required. Please log in and try again.');
        return;
      }

      const { count: businessCount } = await supabase
        .from('businesses')
        .select('*', { count: 'exact', head: true })
        .eq('owner_id', sessionOwnerId);

      const BUSINESS_LIMITS: Record<string, number> = {
        'individual': 1,
        'small-business': 3,
        'organization': 5,
      };

      const limit = BUSINESS_LIMITS[user.subscriptionTier] || 1;
      const currentCount = businessCount || 0;

      if (currentCount >= limit) {
        toast.error(`Business limit reached`, {
          description: `Your ${user.subscriptionTier} plan allows up to ${limit} business${limit > 1 ? 'es' : ''}. Please upgrade to register more.`,
          action: { label: "Upgrade Now", onClick: () => navigate('/pricing') }
        });
        return;
      }

      setIsSubmitting(true);

      // ✅ Validation of inappropriate content
      if (containsInappropriateContent(values.businessName)) {
        toast.error('Business name contains inappropriate content.');
        setIsSubmitting(false);
        return;
      }
      if (values.businessDescription && containsInappropriateContent(values.businessDescription)) {
        toast.error('Business description contains inappropriate content.');
        setIsSubmitting(false);
        return;
      }

      // ✅ Check if business name is already taken
      const { data: existingName, error: nameCheckError } = await supabase
        .from('businesses')
        .select('id, business_name')
        .ilike('business_name', values.businessName.trim())
        .limit(1)
        .maybeSingle();

      if (nameCheckError) {
        console.error('Error checking business name:', nameCheckError);
      }

      if (existingName) {
        toast.error('Business name unavailable', {
          description: 'A business with this name already exists. Please choose a different name.',
        });
        setIsSubmitting(false);
        return;
      }

      // ✅ Geocode address and verify
      const fullAddress = formatFullAddress(values);
      const geocodedData = await geocodeAddress(fullAddress);
      if (!geocodedData?.lat || !geocodedData?.lng) {
        toast.error('Address could not be located.');
        setIsSubmitting(false);
        return;
      }

      // Show address verification dialog
      const addressForVerification = {
        street: values.streetAddress,
        apartment: values.apartment,
        city: values.city,
        state: values.state,
        zipCode: values.zipCode,
        country: values.country,
        lat: geocodedData.lat,
        lng: geocodedData.lng,
      };
      
      setVerifiedAddress(addressForVerification);
      setPendingSubmission({ values, geocodedData });
      setShowAddressVerification(true);
      setIsSubmitting(false);
      return; // Wait for user confirmation
    } catch (error: any) {
      console.error('Error submitting business:', error);
      toast.error(error?.message || 'An error occurred while registering your business.');
      setIsSubmitting(false);
    }
  };

  const handleAddressConfirmed = async () => {
    setShowAddressVerification(false);
    if (!pendingSubmission) return;

    try {
      setIsSubmitting(true);
      const { values, geocodedData } = pendingSubmission;

      // ✅ Check for duplicate businesses
      const { data: existingBusinesses, error: duplicateError } = await supabase
        .from('businesses')
        .select('id, business_name, street_address, city, state')
        .ilike('business_name', values.businessName)
        .ilike('street_address', `%${values.streetAddress}%`)
        .limit(5);

      if (duplicateError) {
        console.error('Error checking duplicates:', duplicateError);
      }

      // If similar businesses found, show warning
      if (existingBusinesses && existingBusinesses.length > 0) {
        setSimilarBusinesses(existingBusinesses.map(b => ({
          id: b.id,
          name: b.business_name,
          address: b.street_address,
          city: b.city,
          state: b.state,
        })));
        setShowDuplicateWarning(true);
        setIsSubmitting(false);
        return; // Wait for user decision
      }

      // No duplicates, proceed with submission
      await finalizeSubmission(values, geocodedData);
    } catch (error: any) {
      console.error('Error during address confirmation:', error);
      toast.error(error?.message || 'An error occurred.');
      setIsSubmitting(false);
    }
  };

  const handleDuplicateConfirmed = async () => {
    setShowDuplicateWarning(false);
    if (!pendingSubmission) return;

    try {
      setIsSubmitting(true);
      const { values, geocodedData } = pendingSubmission;
      await finalizeSubmission(values, geocodedData);
    } catch (error: any) {
      console.error('Error during duplicate confirmation:', error);
      toast.error(error?.message || 'An error occurred.');
      setIsSubmitting(false);
    }
  };

  const finalizeSubmission = async (values: FormValues, geocodedData: any) => {
    try {

      // ---------------------------
      // BUILD TYPED PAYLOAD
      // ---------------------------
      const payload: BusinessInsertPayload = {
        user_id: user!.uid,
        subscription: user!.subscriptionTier,
        business_name: values.businessName,
        business_description: values.businessDescription,
        business_types: values.businessTypes,
        contact_email: values.email,
        phone_number: `${values.countryCode}${values.phone}`,
        website: values.website || null,
        pi_wallet_address: values.piWalletAddress,
        address: {
          street: values.streetAddress,
          apartment: values.apartment || null,
          city: values.city,
          state: values.state,
          zip_code: values.zipCode,
          country: values.country,
          lat: geocodedData.lat,
          lng: geocodedData.lng,
        },
        hours: {
          monday: { open: values.mondayOpen, close: values.mondayClose, closed: values.mondayClosed },
          tuesday: { open: values.tuesdayOpen, close: values.tuesdayClose, closed: values.tuesdayClosed },
          wednesday: { open: values.wednesdayOpen, close: values.wednesdayClose, closed: values.wednesdayClosed },
          thursday: { open: values.thursdayOpen, close: values.thursdayClose, closed: values.thursdayClosed },
          friday: { open: values.fridayOpen, close: values.fridayClose, closed: values.fridayClosed },
          saturday: { open: values.saturdayOpen, close: values.saturdayClose, closed: values.saturdayClosed },
          sunday: { open: values.sundayOpen, close: values.sundayClose, closed: values.sundayClosed },
        },
        owner: {
          first_name: user!.username,
          last_name: '',
        },
      };

      // ✅ Verify user session before calling edge function
      const { data: { session } } = await supabase.auth.getSession();
      if (!session) {
        console.error('No active Supabase session found');
        toast.error('Authentication required. Please refresh the page and try again.');
        setIsSubmitting(false);
        return;
      }
      
      console.log('📤 Calling insert-business edge function with session:', { 
        userId: session.user.id,
        hasAccessToken: !!session.access_token 
      });

      // ✅ Insert business via Edge Function with explicit Authorization header
      const response = await fetch(
        `${getSupabaseFunctionsUrl()}/insert-business`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${session.access_token}`,
          },
          body: JSON.stringify(payload),
        }
      );

      if (!response.ok) {
        const errorText = await response.text();
        console.error('❌ Edge function error:', errorText);
        
        if (response.status === 401) {
          toast.error('Authentication failed. Please refresh the page and try again.');
        } else if (response.status === 403) {
          toast.error('Permission denied. Please check your account status.');
        } else {
          toast.error(`Business registration failed: ${errorText} (${response.status})`);
        }
        setIsSubmitting(false);
        return;
      }

      const insertRes = await response.json();
      
      if (!insertRes?.success || !insertRes?.business) {
        console.error('❌ Invalid response from edge function:', insertRes);
        const errMsg = insertRes?.error || 'Invalid response from server';
        toast.error(`Business registration failed: ${errMsg}`);
        setIsSubmitting(false);
        return;
      }
      
      console.log('✅ Business registered successfully:', insertRes.business.id);

      const newBusiness = insertRes.business;

      // ---------------------------
      // UPLOAD BUSINESS IMAGES
      // ---------------------------
      if (imageUpload.hasImages && newBusiness?.id) {
        const waitForBusinessReadable = async (businessId: number, timeoutMs = 5000) => {
          const startedAt = Date.now();
          while (Date.now() - startedAt < timeoutMs) {
            const { data } = await supabase
              .from('businesses')
              .select('id')
              .eq('id', businessId)
              .maybeSingle();

            if (data?.id) return true;
            await new Promise(resolve => setTimeout(resolve, 300));
          }
          return false;
        };

        console.log('⏳ Waiting for business record to be readable before image upload...');
        await waitForBusinessReadable(newBusiness.id, 5000);

        const uploadResult = await imageUpload.uploadImages(newBusiness.id);

        if (uploadResult.successfulUrls.length > 0) {
          // Update the business record with image URLs
          const { error: updateError } = await supabase
            .from('businesses')
            .update({ images: uploadResult.successfulUrls })
            .eq('id', newBusiness.id);

          if (updateError) {
            console.error('Error saving image URLs to database:', updateError);
            toast.warning('Images uploaded but URLs could not be saved');
          } else {
            console.log(`✅ Uploaded ${uploadResult.successfulUrls.length} images and saved URLs to database`);
          }
        }

        // Show warning if some images failed
        if (uploadResult.failedCount > 0 && uploadResult.successfulUrls.length > 0) {
          toast.warning(`Business registered but ${uploadResult.failedCount} image(s) failed to upload`);
        } else if (uploadResult.failedCount > 0 && uploadResult.successfulUrls.length === 0) {
          toast.warning('Business registered but all images failed to upload');
        }
      }

      toast.success('Business registered successfully!', {
        description: 'Questions about your listing? Contact us at businesses@avantemaps.com'
      });

      // Approaching-limit notification (only for tiered plans)
      try {
        const tier = user!.subscriptionTier;
        if (tier === 'small-business' || tier === 'organization') {
          const planLimit = getBusinessLimit(tier);
          const { count: newCount } = await supabase
            .from('businesses')
            .select('*', { count: 'exact', head: true })
            .eq('owner_id', session.user.id);
          if ((newCount || 0) === planLimit - 1) {
            toast.info(`You've used ${newCount} of ${planLimit} listings on your plan.`, {
              description: 'Upgrade to add more.',
              action: { label: 'Upgrade', onClick: () => navigate('/pricing') }
            });
          }
        }
      } catch (e) {
        console.warn('Approaching limit check failed:', e);
      }

      if (onSuccess) onSuccess();

      navigate('/registered-business', {
        state: { newBusinessId: newBusiness.id }
      });

    } catch (err) {
      console.error('Registration error:', err);
      toast.error('Failed to register business.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    form,
    // New image upload interface
    imageUpload,
    onSubmit,
    isSubmitting,
    showAddressVerification,
    verifiedAddress,
    handleAddressConfirmed,
    setShowAddressVerification,
    showDuplicateWarning,
    similarBusinesses,
    handleDuplicateConfirmed,
    setShowDuplicateWarning,
  };
};
