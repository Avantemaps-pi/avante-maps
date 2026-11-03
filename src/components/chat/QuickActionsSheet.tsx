import React from 'react';
import type { LucideIcon } from 'lucide-react';
import { X } from 'lucide-react';
import { Sheet, SheetClose, SheetContent, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';

export interface QuickAction {
  icon: LucideIcon;
  label: string;
  description: string;
  /** Left out for an action that isn't available yet: the row is greyed, with "Coming soon" */
  onSelect?: () => void;
}

interface QuickActionsSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  actions: QuickAction[];
  /** Tapping an enabled row: the sheet closes, then the action runs */
  onAction: (action: QuickAction) => void;
  /** Where focus goes when the sheet closes without an action (the + button) */
  onCloseAutoFocus?: (event: Event) => void;
}

// A gentler open than the shared sheet's defaults: 650ms in, 350ms out. With reduced motion,
// no slide, just a 150ms fade
const SHEET_MOTION =
  'data-[state=open]:duration-[650ms] data-[state=open]:ease-[cubic-bezier(0.32,0.72,0,1)] data-[state=closed]:duration-[350ms] data-[state=closed]:ease-in ' +
  'motion-reduce:data-[state=open]:duration-150 motion-reduce:data-[state=closed]:duration-150 ' +
  'motion-reduce:data-[state=open]:slide-in-from-bottom-0 motion-reduce:data-[state=closed]:slide-out-to-bottom-0 ' +
  'motion-reduce:data-[state=open]:fade-in-0 motion-reduce:data-[state=closed]:fade-out-0';
const OVERLAY_MOTION =
  'data-[state=open]:duration-[650ms] data-[state=closed]:duration-[350ms] motion-reduce:data-[state=open]:duration-150 motion-reduce:data-[state=closed]:duration-150';

/** CommuniCon's "Quick actions" bottom sheet, opened from the + in the message box */
const QuickActionsSheet: React.FC<QuickActionsSheetProps> = ({ open, onOpenChange, actions, onAction, onCloseAutoFocus }) => (
  <Sheet open={open} onOpenChange={onOpenChange}>
    <SheetContent
      side="bottom"
      hideClose
      aria-describedby={undefined}
      onCloseAutoFocus={onCloseAutoFocus}
      overlayClassName={`bg-slate-900/45 ${OVERLAY_MOTION}`}
      className={`gap-0 rounded-t-2xl bg-card px-4 pt-2.5 pb-[max(1.75rem,env(safe-area-inset-bottom))] text-card-foreground ${SHEET_MOTION}`}
    >
      <div className="mx-auto mb-3.5 h-1 w-9 rounded-full bg-input" aria-hidden="true" />
      <div className="mb-1.5 flex items-center justify-between">
        <SheetTitle className="text-lg font-bold">Quick actions</SheetTitle>
        <SheetClose
          aria-label="Close"
          className="-mr-2.5 flex h-11 w-11 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <X className="h-5 w-5" aria-hidden="true" />
        </SheetClose>
      </div>
      <ul>
        {actions.map(action => {
          const Icon = action.icon;
          const enabled = !!action.onSelect;
          return (
            <li key={action.label} className="border-t">
              <button
                type="button"
                disabled={!enabled}
                aria-disabled={!enabled}
                onClick={() => onAction(action)}
                className={cn(
                  'flex min-h-16 w-full items-center gap-3.5 py-2 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring',
                  !enabled && 'cursor-not-allowed opacity-60'
                )}
              >
                <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-accent text-primary" aria-hidden="true">
                  <Icon className="h-5 w-5" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-2 text-[15px] font-semibold">
                    {action.label}
                    {!enabled && (
                      <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-medium text-muted-foreground">Coming soon</span>
                    )}
                  </span>
                  <span className="block truncate text-[13px] leading-[18px] text-muted-foreground">{action.description}</span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </SheetContent>
  </Sheet>
);

export default QuickActionsSheet;
