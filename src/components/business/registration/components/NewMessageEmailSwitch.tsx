import React from 'react';
import { useFormContext } from 'react-hook-form';
import {
  FormField,
  FormItem,
  FormLabel,
  FormControl,
  FormDescription,
} from '@/components/ui/form';
import { Switch } from '@/components/ui/switch';
import { FormValues } from '../formSchema';

interface NewMessageEmailSwitchProps {
  /** The contact email confirmed through CommuniCon, lower-cased (null when none) */
  confirmedEmail: string | null | undefined;
  disabled?: boolean | undefined;
}

// Update business > Contact: the owner's on/off switch for new-message emails
const NewMessageEmailSwitch: React.FC<NewMessageEmailSwitchProps> = ({
  confirmedEmail,
  disabled,
}) => {
  const form = useFormContext<FormValues>();
  // Changing the email in the form undoes the confirmation (once saved), so compare with what's typed
  const email = (form.watch('email') || '').trim().toLowerCase();
  const confirmed = !!confirmedEmail && confirmedEmail === email;

  return (
    <FormField
      control={form.control}
      name="notifyNewMessageEmail"
      render={({ field }) => (
        <FormItem className="flex items-center justify-between gap-4 space-y-0">
          <div className="space-y-1">
            <FormLabel className="text-base">
              Email me when a customer messages this business
            </FormLabel>
            <FormDescription>
              {confirmed
                ? 'Sent to your confirmed contact email.'
                : 'Confirm your contact email in CommuniCon to get these emails.'}
            </FormDescription>
          </div>
          <FormControl>
            <Switch
              checked={field.value ?? true}
              onCheckedChange={field.onChange}
              disabled={disabled}
            />
          </FormControl>
        </FormItem>
      )}
    />
  );
};

export default NewMessageEmailSwitch;
