
import React, { useState, useEffect, forwardRef, useImperativeHandle } from 'react';
import { hasInAppHistory } from '@/lib/inAppHistory';
import { FormProvider } from 'react-hook-form';
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
          <form onSubmit={form.handleSubmit(handleSubmit)} className="space-y-6 w-full">
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
              form.handleSubmit(handleSubmit)();
            }}>
              Save Changes
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
});
