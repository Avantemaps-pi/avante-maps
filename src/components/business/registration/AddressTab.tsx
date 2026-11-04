import React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import AddressFormFields from './components/AddressFormFields';
interface AddressTabProps {
  onNext: () => void;
  onPrevious: () => void;
  disabled?: boolean;
}
const AddressTab: React.FC<AddressTabProps> = ({
  onNext,
  onPrevious,
  disabled
}) => {
  return (
    <div className="w-full">
      <Card className="border shadow-xs">
        <CardHeader className="pb-4 space-y-2">
          <CardTitle className="text-2xl sm:text-xl">Business Location</CardTitle>
          <CardDescription className="text-base sm:text-sm">
            Help customers find you by providing your business address.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <AddressFormFields disabled={disabled} hideApartment />
        </CardContent>
        <CardFooter className="flex justify-between pt-2">
          <Button 
            type="button" 
            variant="outline" 
            onClick={onPrevious} 
            disabled={disabled}
          >
            Back
          </Button>
          <Button 
            type="button" 
            onClick={onNext} 
            disabled={disabled}
          >
            Next
          </Button>
        </CardFooter>
      </Card>
    </div>
  );
};
export default AddressTab;