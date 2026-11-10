import React, { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Loader2, Plus } from 'lucide-react';
import { toast } from 'sonner';
import { executeWalletTopUp } from '@/utils/piPayment';

// Client-side minimum is UX only — the real enforcement lives server-side in
// approve-payment's Zod schema (positive amount, capped at 1,000,000).
const MIN_TOP_UP_PI = 1;

interface TopUpDialogProps {
  /** After any result: refreshes the balance and activity */
  onDone: () => void;
}

const TopUpDialog: React.FC<TopUpDialogProps> = ({ onDone }) => {
  const [open, setOpen] = useState(false);
  const [amount, setAmount] = useState('10');
  const [isProcessing, setIsProcessing] = useState(false);

  const parsedAmount = Number(amount);
  const isValidAmount =
    Number.isFinite(parsedAmount) && parsedAmount >= MIN_TOP_UP_PI;

  const handleConfirm = async () => {
    if (!isValidAmount || isProcessing) return;

    setIsProcessing(true);
    try {
      const result = await executeWalletTopUp(parsedAmount, {
        onPaymentId: () => {
          // Payment created and awaiting Pi Browser approval — keep the button
          // locked; the awaited promise resolves on the terminal state.
          setIsProcessing(true);
        },
      });

      // The server's own message either way: a refused or failed top up never reads as a success
      if (result.success) {
        toast.success(result.message);
        setOpen(false);
      } else {
        toast.error(result.message);
      }
    } catch (error) {
      toast.error(
        error instanceof Error
          ? `Failed to top up wallet: ${error.message}`
          : 'Failed to top up wallet'
      );
    } finally {
      setIsProcessing(false);
      // The balance may have changed whatever the result (a credit can land after an error)
      onDone();
    }
  };

  return (
    <>
      <Button
        className="w-full mb-4"
        onClick={() => setOpen(true)}
      >
        <Plus className="h-4 w-4 mr-2" />
        Top up
      </Button>

      <Dialog open={open} onOpenChange={(next) => !isProcessing && setOpen(next)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Top up your wallet</DialogTitle>
            <DialogDescription>
              Add Pi to your Avante Maps wallet. You'll confirm the payment in
              the Pi Browser.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="topup-amount">Amount (Pi)</Label>
            <Input
              id="topup-amount"
              type="number"
              inputMode="decimal"
              min={MIN_TOP_UP_PI}
              step="1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
              disabled={isProcessing}
              className="h-11 sm:h-10"
            />
            {!isValidAmount && amount !== '' && (
              <p className="text-xs text-destructive">
                Enter at least {MIN_TOP_UP_PI} Pi.
              </p>
            )}
          </div>

          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setOpen(false)}
              disabled={isProcessing}
            >
              Cancel
            </Button>
            <Button onClick={handleConfirm} disabled={!isValidAmount || isProcessing}>
              {isProcessing ? (
                <>
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                  Processing…
                </>
              ) : (
                'Confirm'
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
};

export default TopUpDialog;
