
import React, { useState, useEffect, useRef, forwardRef, useImperativeHandle } from 'react';
import { hasInAppHistory } from '@/lib/inAppHistory';
import { FormProvider, type SubmitErrorHandler } from 'react-hook-form';
import { Form } from '@/components/ui/form';
import { Tabs } from '@/components/ui/tabs';
import { useIsMobile } from '@/hooks/use-mobile';
import { useNavigate } from '@/lib/router-compat';
import { Business } from '@/types/business';
import { useBusinessFormInit } from '@/hooks/useBusinessFormInit';
import { useBusinessUpdate } from '@/hooks/useBusinessUpdate';
import FormHeader from './registration/components/FormHeader';
import TabNavigation from './registration/components/TabNavigation';
import TabContent from './registration/components/TabContent';
import { Loader2 } from 'lucide-react';
import { toast } from 'sonner';
import { FormValues, daysOfWeek } from './registration/formSchema';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';

// Which tab shows each field, in tab order
const TAB_FIELDS: Array<{ tab: string; fields: Array<keyof FormValues> }> = [
  { tab: 'business-owner', fields: ['firstName', 'lastName', 'businessName'] },
  { tab: 'address', fields: ['country', 'streetAddress', 'city', 'state', 'zipCode'] },
  { tab: 'contact', fields: ['countryCode', 'phone', 'email', 'website'] },
  { tab: 'hours', fields: daysOfWeek.flatMap((day) => [day.open, day.close, day.closed] as Array<keyof FormValues>) },
  { tab: 'details', fields: ['businessTypes', 'businessDescription', 'piWalletAddress'] },
];

interface BusinessUpdateFormProps {
  business: Business;
  onSuccess?: () => void;
}

export interface BusinessUpdateFormRef {
  checkAndHandleBackNavigation: () => void;
}

export const BusinessUpdateForm = forwardRef<BusinessUpdateFormRef, BusinessUpdateFormProps>(
  ({ business, onSuccess }, ref) => {
  const isMobile = useIsMobile();
  const navigate = useNavigate();
  const [selectedTab, setSelectedTab] = useState('business-owner');
  const formRef = useRef<HTMLFormElement>(null);
  // Set when an invalid submit jumps to another tab: focus its field once the tab has rendered
  const pendingInvalidFocusRef = useRef(false);
  const [showUnsavedChangesDialog, setShowUnsavedChangesDialog] = useState(false);
  
  // Initialize form with business data
  const form = useBusinessFormInit(business);
  
  // Use the business update hook
  const { 
    imageUpload, 
    existingImages,
    removeExistingImage,
    hasImageChanges,
    onSubmit, 
    isSubmitting 
  } = useBusinessUpdate(business, onSuccess);

  // Track if form has unsaved changes
  const hasUnsavedChanges = form.formState.isDirty || imageUpload.hasImages || hasImageChanges;

  // Listen for navigation attempts (back button in header)
  useEffect(() => {
    const handleBeforeUnload = (e: BeforeUnloadEvent) => {
      if (hasUnsavedChanges && !isSubmitting) {
        e.preventDefault();
        e.returnValue = '';
      }
    };

    window.addEventListener('beforeunload', handleBeforeUnload);
    return () => window.removeEventListener('beforeunload', handleBeforeUnload);
  }, [hasUnsavedChanges, isSubmitting]);

  // Override browser back button
  useEffect(() => {
    const handlePopState = (e: PopStateEvent) => {
      if (hasUnsavedChanges && !isSubmitting) {
        e.preventDefault();
        setShowUnsavedChangesDialog(true);
        window.history.pushState(null, '', window.location.pathname);
      }
    };

    if (hasUnsavedChanges && !isSubmitting) {
      window.history.pushState(null, '', window.location.pathname);
      window.addEventListener('popstate', handlePopState);
    }

    return () => {
      window.removeEventListener('popstate', handlePopState);
    };
  }, [hasUnsavedChanges, isSubmitting]);

  // Back, or to the list when there's no earlier page in the app (a direct load or a link)
  const leavePage = () => {
    if (hasInAppHistory()) {
      navigate(-1);
    } else {
      navigate('/registered-business', { replace: true });
    }
  };

  const handleDiscardChanges = () => {
    // Reset form to clear dirty state
    form.reset();
    // Clear selected images
    imageUpload.clearImages();
    // Close dialog
    setShowUnsavedChangesDialog(false);
    // Navigate back immediately
    leavePage();
  };

  // First invalid control on screen; a chip group focuses its first chip
  const focusInvalidField = () => {
    requestAnimationFrame(() => {
      const invalid = formRef.current?.querySelector<HTMLElement>('[aria-invalid="true"]');
      const target = invalid?.matches('[role="group"]') ? invalid.querySelector<HTMLElement>('button') : invalid;
      target?.focus();
      target?.scrollIntoView({ block: 'center' });
    });
  };

  useEffect(() => {
    if (!pendingInvalidFocusRef.current) return;
    pendingInvalidFocusRef.current = false;
    focusInvalidField();
  }, [selectedTab]);

  // Submit with errors: go to the earliest tab with one, where the field shows its message
  const handleInvalid: SubmitErrorHandler<FormValues> = (errors) => {
    toast.error('Fix the highlighted field to save');
    const tab = TAB_FIELDS.find(({ fields }) => fields.some((field) => errors[field]))?.tab;
    if (!tab) return;
    if (tab === selectedTab) {
      focusInvalidField();
    } else {
      pendingInvalidFocusRef.current = true;
      setSelectedTab(tab);
    }
  };

  const handleSubmit = async (values: any) => {
    await onSubmit(values);
    // Reset form state after successful submission
    form.reset(values);
  };

  // Expose method to parent via ref
  useImperativeHandle(ref, () => ({
    checkAndHandleBackNavigation: () => {
      if (hasUnsavedChanges && !isSubmitting) {
        setShowUnsavedChangesDialog(true);
      } else if (!isSubmitting) {
        leavePage();
      }
    }
  }));

  return (
    <div className="w-full py-2">
      <FormHeader 
        title="Update Information"
        description="Make changes to your business listing on Avante Maps."
      />

      <FormProvider {...form}>
        <Form {...form}>
          <form ref={formRef} onSubmit={form.handleSubmit(handleSubmit, handleInvalid)} className="space-y-6 w-full">
            <Tabs value={selectedTab} onValueChange={setSelectedTab} className="w-full">
              <TabNavigation 
                isMobile={isMobile}
                disabled={isSubmitting}
              />
              <TabContent 
                images={imageUpload.images}
                onAddImage={imageUpload.addImage}
                onAddCroppedImage={imageUpload.addCroppedImage}
                onRemoveImage={imageUpload.removeImage}
                onRetryImage={imageUpload.retryImage}
                isProcessing={imageUpload.isProcessing}
                setSelectedTab={setSelectedTab}
                isSubmitting={isSubmitting}
                existingImages={existingImages}
                onRemoveExistingImage={removeExistingImage}
              />
            </Tabs>
          </form>
        </Form>
      </FormProvider>

      {/* Loading overlay during submission */}
      {isSubmitting && (
        <div className="fixed inset-0 bg-background/80 backdrop-blur-xs flex items-center justify-center z-50">
          <div className="bg-card p-6 rounded-lg shadow-lg flex flex-col items-center space-y-4">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
            <p className="text-lg font-medium">Updating your business...</p>
          </div>
        </div>
      )}

      <AlertDialog open={showUnsavedChangesDialog} onOpenChange={setShowUnsavedChangesDialog}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Unsaved Changes</AlertDialogTitle>
            <AlertDialogDescription>
              You have unsaved changes. Do you want to save them before leaving?
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={handleDiscardChanges}>
              Don't Save
            </AlertDialogCancel>
            <AlertDialogAction onClick={() => {
              setShowUnsavedChangesDialog(false);
              form.handleSubmit(handleSubmit, handleInvalid)();
            }}>
              Save Changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
