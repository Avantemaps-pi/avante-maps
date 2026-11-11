import React, { useRef } from 'react';
import { FormField, FormItem, FormLabel, FormControl, FormMessage } from '@/components/ui/form';
import { Textarea, type TextareaProps } from '@/components/ui/textarea';
import { useFormContext, type ControllerRenderProps } from 'react-hook-form';
import { useAutoGrow } from '@/hooks/useAutoGrow';
import { FormValues } from '../formSchema';
import { STEP_LABEL_CLASS } from './stepLabel';

interface WalletAddressFieldProps {
  disabled?: boolean | undefined;
  /** Registration steps: sentence-case label in the steps' label style */
  stepLabels?: boolean | undefined;
}

// A Pi address has no spaces: any typed or pasted whitespace (and newlines) is dropped
const stripWhitespace = (value: string) => value.replace(/\s+/g, '');

// The whole 56-character address, wrapping onto a second line on a narrow screen. Other props
// (FormControl's aria-invalid and aria-describedby) pass through to the textarea
const WalletAddressInput = ({
  field,
  disabled,
  ...rest
}: TextareaProps & {
  field: ControllerRenderProps<FormValues, 'piWalletAddress'>;
  disabled?: boolean | undefined;
}) => {
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrow(textareaRef, field.value);

  return (
    <Textarea
      {...rest}
      id="piWalletAddress"
      placeholder="Your Pi wallet address"
      rows={1}
      name={field.name}
      value={field.value ?? ''}
      onBlur={field.onBlur}
      onChange={(e) => field.onChange(stripWhitespace(e.target.value))}
      // Enter never adds a line
      onKeyDown={(e) => {
        if (e.key === 'Enter') e.preventDefault();
      }}
      ref={(el) => {
        textareaRef.current = el;
        field.ref(el);
      }}
      disabled={disabled}
      autoComplete="off"
      autoCapitalize="characters"
      spellCheck={false}
      className="min-h-0 resize-none overflow-hidden break-all font-mono text-sm sm:text-sm"
    />
  );
};

const WalletAddressField: React.FC<WalletAddressFieldProps> = ({ disabled, stepLabels }) => {
  const form = useFormContext<FormValues>();
  
  return (
    <FormField
      control={form.control}
      name="piWalletAddress"
      render={({ field }) => (
        <FormItem>
          <FormLabel className={stepLabels ? STEP_LABEL_CLASS : "text-base mb-1.5"}>{stepLabels ? 'Pi wallet address (business)' : 'Pi Wallet Address (Business)'}</FormLabel>
          <FormControl>
            <WalletAddressInput field={field} disabled={disabled} />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
};

export default WalletAddressField;
