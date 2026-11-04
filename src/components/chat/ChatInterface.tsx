import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Card } from '@/components/ui/card';
import ChatModeToggle from './ChatModeToggle';
import ChatMessage from './ChatMessage';
import BusinessSelectionButtons from './BusinessSelectionButtons';
import VerificationResultCard, { VerificationMetrics } from './VerificationResultCard';
import VerificationHistoryRow from './VerificationHistoryRow';
import type { ContactOTPResult } from './ContactOTPVerification';
import MessagesPanel from '@/components/messages/MessagesPanel';
import { useLocation } from '@/lib/router-compat';
import { Send, Image, Video, Plus, ShieldCheck, Store, MessageSquare, Award } from 'lucide-react';
import QuickActionsSheet, { type QuickAction } from './QuickActionsSheet';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { isSafeForAI } from '@/utils/contentFilter';
import { toast } from 'sonner';
import { useStickToBottom } from '@/hooks/useStickToBottom';

export type ChatMode = 'ai' | 'live';

interface ChatInterfaceProps {
  chatMode: 'ai' | 'live';
  onChatModeChange: (mode: 'ai' | 'live') => void;
  messages: Array<{
    id: number;
    text: string;
    sender: string;
    timestamp: string;
    businesses?: Array<{ id: number; business_name: string; verification_status?: string | null; is_verified?: boolean }>;
    verificationMetrics?: VerificationMetrics | undefined;
    contactVerification?: {
      email: string;
      businessId: number;
    };
    animateVerification?: boolean;
  }>;
  message: string;
  setMessage: (message: string) => void;
  handleSendMessage: () => void;
  handleQuickReply?: (text: string) => void;
  handleAttachmentOption?: () => void;
  showAttachmentIcon?: boolean;
  hasLiveChatAccess?: boolean;
  onSendContactOTP?: (email: string, businessId: number) => Promise<ContactOTPResult>;
  onVerifyContactOTP?: (email: string, otp: string, businessId: number) => Promise<ContactOTPResult>;
  /** Re-runs verification for a result card's business */
  onCheckVerificationAgain?: (businessId: number, businessName: string, messageId: number) => Promise<void>;
}

const QUICK_REPLIES = [
  'Check verification status',
  'Check certification status',
  'My listings',
];

const ChatInterface: React.FC<ChatInterfaceProps> = ({
  chatMode,
  onChatModeChange,
  messages,
  message,
  setMessage,
  handleSendMessage,
  handleQuickReply,
  hasLiveChatAccess = false,
  onSendContactOTP,
  onVerifyContactOTP,
  onCheckVerificationAgain,
}) => {
  const messagesEndRef = useRef<HTMLDivElement>(null);

  // "Check again" for a result card's business (none if the card doesn't know which)
  const checkAgainFor = (metrics: VerificationMetrics, messageId: number) => {
    const businessId = metrics.businessId;
    if (!onCheckVerificationAgain || businessId == null) return undefined;
    return () => onCheckVerificationAgain(businessId, metrics.businessName, messageId);
  };
  // Keep the newest message in view when the keyboard shrinks the list
  const stickToBottomRef = useStickToBottom();
  const listElRef = useRef<HTMLDivElement | null>(null);
  const listRef = useCallback((el: HTMLDivElement | null) => {
    listElRef.current = el;
    stickToBottomRef(el);
  }, [stickToBottomRef]);
  const isInitialMount = useRef(true);
  const location = useLocation();

  // Only for a new message: a card updating in place stays where it is
  const previousCount = useRef(0);
  useEffect(() => {
    if (messages.length > previousCount.current) {
      messagesEndRef.current?.scrollIntoView({ behavior: isInitialMount.current ? 'instant' : 'smooth' });
    }
    previousCount.current = messages.length;
    isInitialMount.current = false;
  }, [messages]);

  // The newest result for each business gets the full card; older ones fold
  const latestCardIds = useMemo(() => {
    const latest = new Map<number, number>();
    for (const msg of messages) {
      const businessId = msg.verificationMetrics && (msg.verificationMetrics.businessId ?? msg.contactVerification?.businessId);
      if (businessId != null) latest.set(businessId, msg.id);
    }
    return latest;
  }, [messages]);
  const isOlderCard = (msg: ChatInterfaceProps['messages'][number]) => {
    const businessId = msg.verificationMetrics?.businessId ?? msg.contactVerification?.businessId;
    return businessId != null && latestCardIds.get(businessId) !== msg.id;
  };

  // The bot list is unmounted on the Messages tab; coming back, open it at the newest message
  // (messages haven't changed, so the effect above doesn't run). After layout, no animation
  useEffect(() => {
    if (chatMode !== 'ai') return;
    const frame = requestAnimationFrame(() => {
      const el = listElRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [chatMode]);

  const handleValidatedSendMessage = () => {
    if (!isSafeForAI(message)) {
      toast.error('Message contains inappropriate content or suspicious patterns.', { id: 'chat:content-filter', duration: 4000 });
      return;
    }
    handleSendMessage();
  };

  const onChipClick = (text: string) => {
    if (handleQuickReply) {
      handleQuickReply(text);
    } else {
      setMessage(text);
    }
  };

  // The + in the message box: the bot's actions, one tap away after the chips have gone.
  // One row per entry (keep it to 3–5); no onSelect = "Coming soon"
  const [quickActionsOpen, setQuickActionsOpen] = useState(false);
  const plusRef = useRef<HTMLButtonElement>(null);
  const ranQuickActionRef = useRef(false);
  const quickActions: QuickAction[] = [
    { icon: ShieldCheck, label: 'Check verification status', description: "See what's done and what's left", onSelect: () => onChipClick('Check verification status') },
    { icon: Store, label: 'My listings', description: 'Your businesses and their status', onSelect: () => onChipClick('My listings') },
    { icon: MessageSquare, label: 'Message a business', description: 'Opens Messages', onSelect: () => onChatModeChange('live') },
    { icon: Award, label: 'Certification', description: 'Request it here once it launches' },
  ];
  const runQuickAction = (action: QuickAction) => {
    ranQuickActionRef.current = true;
    setQuickActionsOpen(false);
    action.onSelect?.();
  };
  // Closed without an action: focus back on the +. After an action, leave focus to it
  const handleQuickActionsCloseFocus = (event: Event) => {
    event.preventDefault();
    if (!ranQuickActionRef.current) plusRef.current?.focus();
    ranQuickActionRef.current = false;
  };

  const renderBusinessSelectionButtons = (msg: any) => {
    if (msg.sender === 'business-selection') {
      const businesses = msg.businesses || [];
      if (businesses.length === 0) return null;
      return (
        <BusinessSelectionButtons
          businesses={businesses}
          onBusinessSelect={(business) => {
            if (window.handleBusinessSelection) {
              window.handleBusinessSelection(business);
            }
          }}
        />
      );
    }
    return null;
  };

  // Show only the latest user message and all non-user messages aren't necessary;
  // alignment is handled inside ChatMessage based on sender.
  const showQuickChips = chatMode === 'ai' && messages.filter(m => m.sender === 'user').length === 0;

  return (
    <Card className="flex flex-1 min-h-0 flex-col overflow-hidden border-none rounded-none shadow-none sm:rounded-lg sm:shadow-md">
      <div className="flex flex-1 min-h-0 flex-col">
        {/* Bot/Messages switch; the page header is the only title */}
        <ChatModeToggle
          chatMode={chatMode}
          onChatModeChange={onChatModeChange}
          hasLiveChatAccess={hasLiveChatAccess}
        />

        <div className="flex-1 flex flex-col min-h-0 overflow-hidden">
          {chatMode === 'live' ? (
            <MessagesPanel
              initialConversationId={(location.state as any)?.openConversationId ?? null}
              initialInboxBusinessId={(location.state as any)?.inboxBusinessId ?? null}
            />
          ) : (
            <>
              <div ref={listRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-4">
                {messages.length === 0 ? (
                  <div className="flex h-full items-center justify-center">
                    <p className="text-center text-muted-foreground">No messages yet. Start a conversation!</p>
                  </div>
                ) : (
                  <>
                    {messages.map(msg => (
                      <div key={msg.id}>
                        {/* A verification result is just its card, no bubble */}
                        {!(msg.verificationMetrics && !msg.text) && (
                          <ChatMessage
                            id={msg.id}
                            text={msg.text}
                            sender={msg.sender}
                            timestamp={msg.timestamp}
                          />
                        )}
                        {msg.verificationMetrics && isOlderCard(msg) && (
                          <div className={msg.text ? 'mt-2' : undefined}>
                            <VerificationHistoryRow
                              metrics={msg.verificationMetrics}
                              contactEmail={msg.contactVerification?.email}
                              timestamp={msg.timestamp}
                            />
                          </div>
                        )}
                        {msg.verificationMetrics && !isOlderCard(msg) && (
                          <div className={msg.text ? 'mt-2' : undefined}>
                            <VerificationResultCard
                              metrics={msg.verificationMetrics}
                              contactEmail={msg.contactVerification?.email}
                              contactBusinessId={msg.contactVerification?.businessId}
                              onSendContactOTP={onSendContactOTP}
                              onVerifyContactOTP={onVerifyContactOTP}
                              onCheckAgain={checkAgainFor(msg.verificationMetrics, msg.id)}
                              animate={msg.animateVerification ?? false}
                            />
                            {!msg.text && !msg.verificationMetrics.checkedAt && <p className="mt-1 text-xs text-muted-foreground">{msg.timestamp}</p>}
                          </div>
                        )}
                        {renderBusinessSelectionButtons(msg)}
                      </div>
                    ))}

                    <div ref={messagesEndRef} />
                  </>
                )}
              </div>

              {/* Quick replies sit right above the input */}
              {showQuickChips && (
                <div className="flex flex-wrap gap-2 px-4 pt-2 pb-3">
                  {QUICK_REPLIES.map(text => (
                    <button
                      key={text}
                      type="button"
                      onClick={() => onChipClick(text)}
                      className="inline-flex min-h-11 items-center rounded-full border border-primary/30 bg-primary/5 px-3 text-sm font-medium text-primary hover:bg-primary/10 transition-colors"
                    >
                      {text}
                    </button>
                  ))}
                </div>
              )}

              <div className="border-t px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]" data-chat-input-bar>
                <div className="relative flex items-center">
                  <div className="flex w-full items-center gap-1 bg-muted/50 rounded-full py-1 pl-1 pr-4">
                    <button
                      ref={plusRef}
                      type="button"
                      onClick={() => setQuickActionsOpen(true)}
                      aria-label="Quick actions"
                      aria-haspopup="dialog"
                      aria-expanded={quickActionsOpen}
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-full transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring ${quickActionsOpen ? 'bg-primary text-primary-foreground' : 'bg-background text-primary'}`}
                    >
                      <Plus size={22} aria-hidden="true" />
                    </button>
                    <Input
                      value={message}
                      onChange={e => setMessage(e.target.value)}
                      className="min-w-0 flex-1 bg-transparent border-0 px-2 focus-visible:ring-0 focus-visible:ring-offset-0 placeholder:text-muted-foreground"
                      placeholder="Ask about your business..."
                      onKeyDown={e => e.key === 'Enter' && handleValidatedSendMessage()}
                    />
                    <button
                      onClick={handleValidatedSendMessage}
                      disabled={!message.trim()}
                      aria-label="Send"
                      className="shrink-0 text-primary hover:text-primary/80 ml-1 disabled:opacity-50 disabled:cursor-not-allowed"
                    >
                      <Send size={20} className="transform rotate-45" />
                    </button>
                  </div>
                </div>
              </div>
              <QuickActionsSheet
                open={quickActionsOpen}
                onOpenChange={setQuickActionsOpen}
                actions={quickActions}
                onAction={runQuickAction}
                onCloseAutoFocus={handleQuickActionsCloseFocus}
              />
            </>
          )}
        </div>
      </div>
    </Card>
  );
};

export default ChatInterface;
