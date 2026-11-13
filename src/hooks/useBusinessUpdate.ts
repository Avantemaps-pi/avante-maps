import { useState, useCallback } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import type { TablesUpdate } from '@/integrations/supabase/types';
import { toast } from 'sonner';
import { containsInappropriateContent } from '@/utils/contentFilter';
import { useImageUpload } from '@/hooks/useImageUpload';
import { FormValues } from '@/components/business/registration/formSchema';
import { Business, BusinessHours } from '@/types/business';
import { secureLog } from '@/utils/secureLogger';
import { formatFullAddress, geocodeAddress } from '@/components/business/registration/utils/addressUtils';
import type { ListingSectionId } from '@/components/business/edit/listingSections';
import { ownedBusinessQueryKey } from '@/hooks/useOwnedBusiness';

const NOT_LOADED_MESSAGE = "Some details couldn't be loaded, so they weren't changed. Reopen the business to edit them.";

const hoursFromValues = (values: FormValues): BusinessHours => ({
  monday: { open: values.mondayOpen, close: values.mondayClose, closed: values.mondayClosed },
  tuesday: { open: values.tuesdayOpen, close: values.tuesdayClose, closed: values.tuesdayClosed },
  wednesday: { open: values.wednesdayOpen, close: values.wednesdayClose, closed: values.wednesdayClosed },
  thursday: { open: values.thursdayOpen, close: values.thursdayClose, closed: values.thursdayClosed },
  friday: { open: values.fridayOpen, close: values.fridayClose, closed: values.fridayClosed },
  saturday: { open: values.saturdayOpen, close: values.saturdayClose, closed: values.saturdayClosed },
  sunday: { open: values.sundayOpen, close: values.sundayClose, closed: values.sundayClosed },
});

/**
 * Edit listing: each section saves only its own columns, so saving one section can never
 * overwrite another. Returns the business with the saved values, or null when nothing was saved.
 */
export const useBusinessUpdate = (business: Business) => {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [removedExistingImages, setRemovedExistingImages] = useState<number[]>([]);
  const queryClient = useQueryClient();

  const imageUpload = useImageUpload({ maxImages: 3, bucketName: 'business-images' });

  // Existing images that haven't been removed
  const existingImages = business.images || [];
  const activeExistingImages = existingImages.filter((_, i) => !removedExistingImages.includes(i));

  const removeExistingImage = useCallback((index: number) => {
    setRemovedExistingImages(prev => [...prev, index]);
  }, []);

  const hasImageChanges = imageUpload.hasImages || removedExistingImages.length > 0;

  const saveSection = async (section: ListingSectionId, values: FormValues): Promise<Business | null> => {
    // The Supabase session user ID (RLS compares owner_id with auth.uid()), never the Pi ID
    const { data: { session }, error: sessionError } = await supabase.auth.getSession();
    if (sessionError || !session?.user?.id) {
      secureLog.error('No valid Supabase session for business update', { message: sessionError?.message });
      toast.error('Session expired. Please log in again to update your business.');
      return null;
    }
    const sessionUserId = session.user.id;

    setIsSubmitting(true);
    try {
      const payload: TablesUpdate<'businesses'> = {};
      const updated: Business = { ...business };
      let pinNotMoved = false;

      // A column that was never loaded holds the form's blanks and defaults, not the business's
      // data, so it isn't saved (undefined only: a loaded, empty value is a real edit)
      const notLoaded = (stored: unknown) => {
        if (stored !== undefined) return false;
        secureLog.warn('Business update skipped a section that was not loaded', { businessId: business.id, section });
        toast.warning(NOT_LOADED_MESSAGE);
        return true;
      };

      switch (section) {
        case 'name': {
          if (containsInappropriateContent(values.businessName)) {
            toast.error('Business name contains inappropriate content.');
            return null;
          }
          payload.business_name = values.businessName;
          payload.business_types = values.businessTypes;
          updated.name = values.businessName;
          updated.businessTypes = values.businessTypes;
          break;
        }
        case 'address': {
          // On this page the apartment is part of the street, as it's stored: there's no Apartment box
          const addressFields: Array<[column: 'street_address' | 'city' | 'state' | 'zip_code' | 'country', stored: string | null | undefined, value: string]> = [
            ['street_address', business.streetAddress, values.streetAddress.trim()],
            ['city', business.city, values.city],
            ['state', business.state, values.state],
            ['zip_code', business.zipCode, values.zipCode],
            ['country', business.country, values.country],
          ];
          let addressChanged = false;
          let anyNotLoaded = false;
          for (const [column, stored, value] of addressFields) {
            if (stored === undefined) {
              anyNotLoaded = true;
              continue;
            }
            payload[column] = value;
            if ((stored ?? '').trim() !== value.trim()) addressChanged = true;
          }
          if (anyNotLoaded) {
            secureLog.warn('Business update skipped address fields that were not loaded', { businessId: business.id });
            toast.warning(NOT_LOADED_MESSAGE);
          }
          if (payload.street_address != null) updated.streetAddress = payload.street_address;
          if (payload.city != null) updated.city = payload.city;
          if (payload.state != null) updated.state = payload.state;
          if (payload.zip_code != null) updated.zipCode = payload.zip_code;
          if (payload.country != null) updated.country = payload.country;

          // A new address moves the map pin. If it can't be located the address is still saved,
          // and the pin stays where it was
          if (addressChanged && !anyNotLoaded) {
            const position = await geocodeAddress(formatFullAddress(values));
            if (position?.lat && position?.lng) {
              payload.lat = position.lat;
              payload.lng = position.lng;
              payload.coordinates = JSON.stringify({ lat: position.lat, lng: position.lng });
              updated.lat = position.lat;
              updated.lng = position.lng;
            } else {
              pinNotMoved = true;
            }
          }
          break;
        }
        case 'contact': {
          if (!notLoaded(business.contactInfo)) {
            const contactInfo = {
              first_name: values.firstName || null,
              last_name: values.lastName || null,
              email: values.email,
              phone: values.phone ? `${values.countryCode || ''}${values.phone}` : null,
              website: values.website || null,
            };
            payload.contact_info = contactInfo;
            updated.contactInfo = {
              ...(contactInfo.first_name ? { first_name: contactInfo.first_name } : {}),
              ...(contactInfo.last_name ? { last_name: contactInfo.last_name } : {}),
              email: contactInfo.email,
              ...(contactInfo.phone ? { phone: contactInfo.phone } : {}),
              ...(contactInfo.website ? { website: contactInfo.website } : {}),
            };
          }
          if (!notLoaded(business.notifyNewMessageEmail)) {
            payload.notify_new_message_email = values.notifyNewMessageEmail;
            updated.notifyNewMessageEmail = values.notifyNewMessageEmail;
          }
          break;
        }
        case 'hours': {
          if (!notLoaded(business.hours)) {
            const hours = hoursFromValues(values);
            payload.hours = hours;
            updated.hours = hours;
          }
          break;
        }
        case 'photos': {
          if (values.businessDescription && containsInappropriateContent(values.businessDescription)) {
            toast.error('Business description contains inappropriate content.');
            return null;
          }
          payload.business_description = values.businessDescription || null;
          updated.description = values.businessDescription || '';

          let newImageUrls: string[] = [];
          if (imageUpload.hasImages) {
            toast.info('Uploading images...');
            const uploadResult = await imageUpload.uploadImages(business.id);
            newImageUrls = uploadResult.successfulUrls;
            if (uploadResult.failedCount > 0) {
              toast.warning(`${uploadResult.failedCount} image(s) failed to upload`);
            }
          }
          if (hasImageChanges || newImageUrls.length > 0) {
            // At most 3 photos in all
            const combinedImages = [...activeExistingImages, ...newImageUrls].slice(0, 3);
            payload.images = combinedImages.length > 0 ? combinedImages : null;
            updated.images = combinedImages;
          }
          break;
        }
        case 'wallet': {
          if (!notLoaded(business.piWalletAddress)) {
            payload.pi_wallet_address = values.piWalletAddress || null;
            updated.piWalletAddress = values.piWalletAddress || '';
          }
          break;
        }
      }

      if (Object.keys(payload).length === 0) return null;

      const { data: savedRows, error: updateError } = await supabase
        .from('businesses')
        .update(payload)
        .eq('id', business.id)
        .eq('owner_id', sessionUserId)
        .select('id');

      if (updateError) {
        secureLog.error('Error updating business', { businessId: business.id, section, error: updateError });
        toast.error(`Failed to update business: ${updateError.message}`);
        return null;
      }
      // An update RLS lets through as a no-op (0 rows) saved nothing
      if (!savedRows || savedRows.length === 0) {
        secureLog.warn('Business update changed no rows', { businessId: business.id, section });
        toast.error("Couldn't save. Reopen the business and try again.");
        return null;
      }

      updated.address = [updated.streetAddress, updated.city, updated.state, updated.zipCode, updated.country].filter(Boolean).join(', ') || business.address;
      queryClient.setQueryData(ownedBusinessQueryKey(business.id), updated);
      await queryClient.invalidateQueries({ queryKey: ['businesses'] });
      if (pinNotMoved) {
        secureLog.warn('Business address saved without a new position', { businessId: business.id });
        toast.warning("Address saved, but we couldn't update the map pin");
      }

      imageUpload.clearImages();
      setRemovedExistingImages([]);
      return updated;
    } catch (error: unknown) {
      secureLog.error('Business update error', { businessId: business.id, section, error });
      toast.error(error instanceof Error ? error.message : 'An error occurred while updating your business.');
      return null;
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
    saveSection,
    isSubmitting,
  };
};
