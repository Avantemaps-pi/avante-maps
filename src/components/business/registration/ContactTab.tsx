import React from 'react';
import { Card, CardHeader, CardTitle, CardDescription, CardContent, CardFooter } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import ContactFields from './components/ContactFields';
import NewMessageEmailSwitch from './components/NewMessageEmailSwitch';

interface ContactTabProps {
  onNext: () => void;
  onPrevious: () => void;
  disabled?: boolean;
  /** The contact email confirmed through CommuniCon, lower-cased (null when none) */
  confirmedEmail?: string | null | undefined;
}

const ContactTab: React.FC<ContactTabProps> = ({ onNext, onPrevious, disabled, confirmedEmail }) => {
  return (
    <div className="w-full">
      <Card className="border shadow-xs">
        <CardHeader className="pb-4 space-y-2">
          <CardTitle className="text-2xl sm:text-xl">Contact Details</CardTitle>
          <CardDescription className="text-base sm:text-sm">
            How customers can reach your business.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <ContactFields
            disabled={disabled}
            afterEmail={<NewMessageEmailSwitch confirmedEmail={confirmedEmail} disabled={disabled} />}
          />
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

export default ContactTab;
