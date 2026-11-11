import React, { useEffect, useRef } from 'react';
import { FormProvider } from 'react-hook-form';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { Form } from '@/components/ui/form';
import { Button } from '@/components/ui/button';
import { useBlocker } from '@/lib/router-compat';
import { Business } from '@/types/business';
import { useBusinessFormInit } from '@/hooks/useBusinessFormInit';
import { useBusinessUpdate } from '@/hooks/useBusinessUpdate';
import { UnsavedChangesDialog } from '../registration/UnsavedChangesDialog';
import BusinessNameField from '../registration/components/BusinessNameField';
import BusinessTypeSelector from '../registration/components/BusinessTypeSelector';
import AddressFormFields from '../registration/components/AddressFormFields';
import ContactFields from '../registration/components/ContactFields';
import NewMessageEmailSwitch from '../registration/components/NewMessageEmailSwitch';
import HoursFields from '../registration/components/HoursFields';
import BusinessImageUpload from '../registration/components/BusinessImageUpload';
import BusinessDescriptionField from '../registration/components/BusinessDescriptionField';
import WalletAddressField from '../registration/components/WalletAddressField';
import { ListingSection } from './listingSections';

interface EditListingSectionProps {
  business: Business;
  section: ListingSection;
  /** A field to focus on opening, e.g. the wallet address from Wallet → Edit */
  focusField?: string | undefined;
  /** Leave the section: after a save, or Back */
  onLeave: () => void;
}

// One section of Edit listing: only its fields, and one Save that saves only them
export const EditListingSection = ({
  business,
  section,
  focusField,
  onLeave,
}: EditListingSectionProps) => {
  const form = useBusinessFormInit(business);
  const formRef = useRef<HTMLFormElement>(null);
  // Set once saved, so leaving afterwards isn't stopped by the unsaved-changes check
  const savedRef = useRef(false);
  const {
    imageUpload,
    existingImages,
    removeExistingImage,
    hasImageChanges,
    saveSection,
    isSubmitting,
  } = useBusinessUpdate(business);

  const hasUnsavedChanges = form.formState.isDirty || hasImageChanges;

  // Back (the header arrow, browser Back, or any link) with unsaved changes asks first
  const blocker = useBlocker({
    shouldBlockFn: () =>
      hasUnsavedChanges && !savedRef.current && !isSubmitting,
    enableBeforeUnload: () => hasUnsavedChanges && !savedRef.current,
    withResolver: true,
  });

  useEffect(() => {
    if (!focusField) return;
    requestAnimationFrame(() => {
      const target = formRef.current?.querySelector<HTMLElement>(
        `#${CSS.escape(focusField)}`,
      );
      target?.focus();
      target?.scrollIntoView({ block: 'center' });
    });
  }, [focusField]);

  // First invalid control on screen; a chip group focuses its first chip
  const focusInvalidField = () => {
    requestAnimationFrame(() => {
      const invalid = formRef.current?.querySelector<HTMLElement>(
        '[aria-invalid="true"]',
      );
      const target = invalid?.matches('[role="group"]')
        ? invalid.querySelector<HTMLElement>('button')
        : invalid;
      target?.focus();
      target?.scrollIntoView({ block: 'center' });
    });
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (isSubmitting) return;
    // Only this section's fields: another section's stored values can't stop this save
    const valid = await form.trigger(section.fields);
    if (!valid) {
      toast.error('Fix the highlighted field to save');
      focusInvalidField();
      return;
    }
    const values = form.getValues();
    const saved = await saveSection(section.id, values);
    if (!saved) return;
    toast.success(`${section.title} saved`);
    savedRef.current = true;
    form.reset(values);
    onLeave();
  };

  const disabled = isSubmitting;

  return (
    <div className="w-full py-2">
      <h2 className="mb-4 text-xl font-semibold">{section.title}</h2>
      <FormProvider {...form}>
        <Form {...form}>
          <form
            ref={formRef}
            onSubmit={handleSave}
            noValidate
            className="w-full space-y-6"
          >
            {section.id === 'name' && (
              <>
                <BusinessNameField disabled={disabled} />
                <BusinessTypeSelector disabled={disabled} />
              </>
            )}
            {section.id === 'address' && (
              <AddressFormFields disabled={disabled} hideApartment />
            )}
            {section.id === 'contact' && (
              <ContactFields
                disabled={disabled}
                afterEmail={
                  <NewMessageEmailSwitch
                    confirmedEmail={business.contactEmailVerifiedFor}
                    disabled={disabled}
                  />
                }
              />
            )}
            {section.id === 'hours' && <HoursFields disabled={disabled} />}
            {section.id === 'photos' && (
              <>
                <BusinessImageUpload
                  images={imageUpload.images}
                  onAddImage={imageUpload.addImage}
                  onAddCroppedImage={imageUpload.addCroppedImage}
                  onRemoveImage={imageUpload.removeImage}
                  onRetryImage={imageUpload.retryImage}
                  maxImages={3}
                  disabled={disabled}
                  isProcessing={imageUpload.isProcessing}
                  existingImages={existingImages}
                  onRemoveExistingImage={removeExistingImage}
                />
                <BusinessDescriptionField disabled={disabled} />
              </>
            )}
            {section.id === 'wallet' && (
              <WalletAddressField disabled={disabled} />
            )}

            <Button
              type="submit"
              className="h-12 w-full text-base"
              disabled={isSubmitting}
            >
              {isSubmitting ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Saving…
                </>
              ) : (
                'Save'
              )}
            </Button>
          </form>
        </Form>
      </FormProvider>

      <UnsavedChangesDialog
        open={blocker.status === 'blocked'}
        onOpenChange={(open) => {
          if (!open && blocker.status === 'blocked') blocker.reset();
        }}
        onConfirm={() => {
          if (blocker.status === 'blocked') blocker.proceed();
        }}
        description="You have unsaved changes. Leave without saving them?"
      />
    </div>
  );
};
