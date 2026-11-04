import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useNavigate } from '@/lib/router-compat';
import { supabase } from '@/integrations/supabase/client';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth';
import { containsInappropriateContent } from '@/utils/contentFilter';
import { useImageUpload } from '@/hooks/useImageUpload';
import { FormValues } from '@/components/business/registration/formSchema';
import { Business } from '@/types/business';
import { secureLog } from '@/utils/secureLogger';
import { formatFullAddress, geocodeAddress } from '@/components/business/registration/utils/addressUtils';

export const useBusinessUpdate = (business: Business, onSuccess?: () => void) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [removedExistingImages, setRemovedExistingImages] = useState<number[]>([]);
  const { user } = useAuth();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  // Use the image upload hook
  const imageUpload = useImageUpload({ maxImages: 3, bucketName: 'business-images' });

  // Get existing images that haven't been removed
  const existingImages = business.images || [];
  const activeExistingImages = existingImages.filter((_, i) => !removedExistingImages.includes(i));

  // Handle removing an existing image
  const removeExistingImage = useCallback((index: number) => {
    setRemovedExistingImages(prev => [...prev, index]);
  }, []);

  // Check if there are any changes (new images or removed images)
  const hasImageChanges = imageUpload.hasImages || removedExistingImages.length > 0;

  const onSubmit = async (values: FormValues) => {
    try {
      // Get the actual Supabase session user ID (not the Pi auth user ID)
      const { data: { session }, error: sessionError } = await supabase.auth.getSession();
      
      if (sessionError || !session?.user?.id) {
        console.error('No valid Supabase session:', sessionError?.message);
        toast.error('Session expired. Please log in again to update your business.');
        return;
      }
      
      const sessionUserId = session.user.id;
      console.log('Updating business with session user ID:', sessionUserId);

      setIsSubmitting(true);

      // Validate content
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

      // Build update payload
      const updatePayload: Record<string, any> = {
        business_name: values.businessName,
        business_description: values.businessDescription || null,
        business_types: values.businessTypes,
      };

      // Safety net: a field that was never loaded holds the form's blanks and defaults, not the
      // business's data, so it isn't saved (undefined only: a loaded, empty value is a real edit)
      const notLoaded: string[] = [];
      if (business.piWalletAddress !== undefined) {
        updatePayload['pi_wallet_address'] = values.piWalletAddress || null;
      } else {
        notLoaded.push('pi_wallet_address');
      }
      if (business.contactInfo !== undefined) {
        updatePayload['contact_info'] = {
          first_name: values.firstName || null,
          last_name: values.lastName || null,
          email: values.email,
          phone: values.phone ? `${values.countryCode || ''}${values.phone}` : null,
          website: values.website || null,
        };
      } else {
        notLoaded.push('contact_info');
      }
      if (business.hours !== undefined) {
        updatePayload['hours'] = {
          monday: { open: values.mondayOpen, close: values.mondayClose, closed: values.mondayClosed },
          tuesday: { open: values.tuesdayOpen, close: values.tuesdayClose, closed: values.tuesdayClosed },
          wednesday: { open: values.wednesdayOpen, close: values.wednesdayClose, closed: values.wednesdayClosed },
          thursday: { open: values.thursdayOpen, close: values.thursdayClose, closed: values.thursdayClosed },
          friday: { open: values.fridayOpen, close: values.fridayClose, closed: values.fridayClosed },
          saturday: { open: values.saturdayOpen, close: values.saturdayClose, closed: values.saturdayClosed },
          sunday: { open: values.sundayOpen, close: values.sundayClose, closed: values.sundayClosed },
        };
      } else {
        notLoaded.push('hours');
      }

      // On this page the apartment is part of the street, as it's stored: there's no Apartment box
      const addressFields: Array<[column: string, stored: string | null | undefined, value: string]> = [
        ['street_address', business.streetAddress, values.streetAddress.trim()],
        ['city', business.city, values.city],
        ['state', business.state, values.state],
        ['zip_code', business.zipCode, values.zipCode],
        ['country', business.country, values.country],
      ];
      let addressChanged = false;
      for (const [column, stored, value] of addressFields) {
        if (stored === undefined) {
          notLoaded.push(column);
          continue;
        }
        updatePayload[column] = value;
        if ((stored ?? '').trim() !== value.trim()) addressChanged = true;
      }

      // A new address moves the map pin. If it can't be located the address is still saved,
      // and the pin stays where it was
      let pinNotMoved = false;
      if (addressChanged && !addressFields.some(([column]) => notLoaded.includes(column))) {
        const position = await geocodeAddress(formatFullAddress(values));
        if (position?.lat && position?.lng) {
          updatePayload['lat'] = position.lat;
          updatePayload['lng'] = position.lng;
          updatePayload['coordinates'] = JSON.stringify({ lat: position.lat, lng: position.lng });
        } else {
          pinNotMoved = true;
        }
      }

      if (notLoaded.length > 0) {
        secureLog.warn('Business update skipped fields that were not loaded', { businessId: business.id, notLoaded });
        toast.warning("Some details couldn't be loaded, so they weren't changed. Reopen the business to edit them.");
      }

      // Handle new image uploads if any
      let newImageUrls: string[] = [];
      if (imageUpload.hasImages) {
        toast.info('Uploading images...');
        const uploadResult = await imageUpload.uploadImages(business.id);
        
        if (uploadResult.successfulUrls.length > 0) {
          newImageUrls = uploadResult.successfulUrls;
        }

        if (uploadResult.failedCount > 0) {
          toast.warning(`${uploadResult.failedCount} image(s) failed to upload`);
        }
      }

      // Combine active existing images and new images (max 3 total)
      const combinedImages = [...activeExistingImages, ...newImageUrls].slice(0, 3);
      
      // Always update images if there are any changes
      if (hasImageChanges || newImageUrls.length > 0) {
        updatePayload['images'] = combinedImages.length > 0 ? combinedImages : null;
      }

      // Update business in database using Supabase session user ID
      const { error: updateError } = await supabase
        .from('businesses')
        .update(updatePayload as any)
        .eq('id', business.id)
        .eq('owner_id', sessionUserId); // Use session user ID, not Pi auth user ID

      if (updateError) {
        console.error('Error updating business:', updateError);
        toast.error(`Failed to update business: ${updateError.message}`);
        setIsSubmitting(false);
        return;
      }

      console.log('✅ Business updated successfully:', business.id);
      await queryClient.invalidateQueries({ queryKey: ['businesses'] });
      toast.success('Business information updated successfully!');
      if (pinNotMoved) {
        secureLog.warn('Business address saved without a new position', { businessId: business.id });
        toast.warning("Address saved, but we couldn't update the map pin");
      }
      
      // Clear uploaded images and reset removed images
      imageUpload.clearImages();
      setRemovedExistingImages([]);
      
      if (onSuccess) {
        onSuccess();
      } else {
        navigate('/registered-business');
      }
    } catch (error: any) {
      console.error('Update error:', error);
      toast.error(error?.message || 'An error occurred while updating your business.');
    } finally {
      setIsSubmitting(false);
    }
  };

  return {
    imageUpload,
    existingImages,
    activeExistingImages,
    removeExistingImage,
    hasImageChanges,
    onSubmit,
    isSubmitting,
  };
};
