
import React from 'react';
import { Button } from '@/components/ui/button';

interface Business {
  id: number;
  business_name: string;
  verification_status?: string | null;
  is_verified?: boolean;
}

interface BusinessSelectionButtonsProps {
  businesses: Business[];
  onBusinessSelect: (business: Business) => void;
  /** Not the question the flow is waiting on (e.g. from an old saved chat) */
  disabled?: boolean;
}

const BusinessSelectionButtons: React.FC<BusinessSelectionButtonsProps> = ({
  businesses,
  onBusinessSelect,
  disabled = false
}) => {
  return (
    <div className="flex flex-wrap gap-2 mt-2">
      {businesses.map((business) => (
        <Button 
          key={business.id}
          variant="outline" 
          size="sm"
          onClick={() => onBusinessSelect(business)}
          disabled={disabled}
          aria-disabled={disabled}
          className="h-auto min-h-11 max-w-full flex-shrink-0 whitespace-normal text-left"
        >
          {business.business_name}
        </Button>
      ))}
    </div>
  );
};

export default BusinessSelectionButtons;
