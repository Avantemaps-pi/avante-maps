
import React from 'react';
import { TabsContent } from '@/components/ui/tabs';
import BusinessOwnerTab from '../BusinessOwnerTab';
import ContactTab from '../ContactTab';
import AddressTab from '../AddressTab';
import HoursTab from '../HoursTab';
import DetailsTab from '../DetailsTab';
import PreviewTab from '../PreviewTab';
import { ImageUploadStatus } from '@/hooks/useImageUpload';

interface TabContentProps {
  images: ImageUploadStatus[];
  onAddImage: (e: React.ChangeEvent<HTMLInputElement>) => void;
  onAddCroppedImage: (file: File) => void;
  onRemoveImage: (id: string) => void;
  onRetryImage?: (id: string) => void;
  isProcessing?: boolean;
  setSelectedTab: (tab: string) => void;
  isSubmitting?: boolean;
  existingImages?: string[];
  onRemoveExistingImage?: (index: number) => void;
  /** The contact email confirmed through CommuniCon, lower-cased (null when none) */
  confirmedEmail?: string | null | undefined;
}

const TabContent: React.FC<TabContentProps> = ({ 
  images, 
  onAddImage,
  onAddCroppedImage,
  onRemoveImage,
  onRetryImage,
  isProcessing,
  setSelectedTab,
  isSubmitting,
  existingImages = [],
  onRemoveExistingImage,
  confirmedEmail,
}) => {
  return (
    <div className="w-full min-h-[500px]">
      <TabsContent value="business-owner" className="space-y-4 w-full">
        <BusinessOwnerTab 
          onNext={() => setSelectedTab('address')}
          {...(isSubmitting !== undefined ? { disabled: isSubmitting } : {})}
        />
      </TabsContent>

      <TabsContent value="address" className="space-y-4 w-full">
        <AddressTab 
          onNext={() => setSelectedTab('contact')} 
          onPrevious={() => setSelectedTab('business-owner')} 
          {...(isSubmitting !== undefined ? { disabled: isSubmitting } : {})}
        />
      </TabsContent>

      <TabsContent value="contact" className="space-y-4 w-full">
        <ContactTab 
          onNext={() => setSelectedTab('hours')} 
          onPrevious={() => setSelectedTab('address')} 
          confirmedEmail={confirmedEmail}
          {...(isSubmitting !== undefined ? { disabled: isSubmitting } : {})}
        />
      </TabsContent>

      <TabsContent value="hours" className="space-y-4 w-full">
        <HoursTab 
          onNext={() => setSelectedTab('details')} 
          onPrevious={() => setSelectedTab('contact')} 
          {...(isSubmitting !== undefined ? { disabled: isSubmitting } : {})}
        />
      </TabsContent>

      <TabsContent value="details" className="space-y-4 w-full">
        <DetailsTab 
          onNext={() => setSelectedTab('preview')}
          onPrevious={() => setSelectedTab('hours')}
          images={images}
          onAddImage={onAddImage}
          onAddCroppedImage={onAddCroppedImage}
          onRemoveImage={onRemoveImage}
          existingImages={existingImages}
          {...(onRetryImage !== undefined ? { onRetryImage } : {})}
          {...(isProcessing !== undefined ? { isProcessing } : {})}
          {...(isSubmitting !== undefined ? { disabled: isSubmitting } : {})}
          {...(onRemoveExistingImage !== undefined ? { onRemoveExistingImage } : {})}
        />
      </TabsContent>

      <TabsContent value="preview" className="space-y-4 w-full">
        <PreviewTab 
          onNext={() => {}}
          onPrevious={() => setSelectedTab('details')}
          images={images}
          existingImages={existingImages}
          {...(isSubmitting !== undefined ? { disabled: isSubmitting } : {})}
        />
      </TabsContent>
    </div>
  );
};

export default TabContent;
