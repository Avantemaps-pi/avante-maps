import React, { useEffect, useRef, useCallback, useState } from 'react';
import AppLayout from '@/components/layout/AppLayout';

import ChatInterface from '@/components/chat/ChatInterface';
import { useChatState } from '@/hooks/useChatState';
import { useNavigate, useLocation } from '@/lib/router-compat';
import { toast } from 'sonner';
import { useAuth } from '@/context/auth';
import { Loader2 } from 'lucide-react';
import { Dialog, DialogContent, DialogTitle } from '@/components/ui/dialog';
import ContactOTPVerification from '@/components/chat/ContactOTPVerification';
import { verificationProgress } from '@/components/chat/verificationProgress';
import type { ContactOTPResult } from '@/components/chat/ContactOTPVerification';
import { OPEN_PENDING_CONTACT_CODE_EVENT, loadPendingContactCode } from '@/components/chat/pendingContactCode';

// The code entry dialog: a pending code being resumed, or a code from the email's confirm link
interface CodeDialogState {
  email: string;
  businessId: number;
  businessName: string;
  /** From the link: filled in and submitted by itself */
  initialCode?: string;
  /** The address the business's contact email is already confirmed for (from the link's lookup) */
  confirmedFor?: string | null;
}

// The email's "Confirm in Avante Maps" link: ?confirm_code=<6 digits>&business=<id>
const readConfirmLink = (search: string) => {
  // Tolerates any number of leading "?"s; router-compat's search has exactly one
  const params = new URLSearchParams(search.replace(/^\?+/, ''));
  const code = params.get('confirm_code') ?? '';
  const business = params.get('business') ?? '';
  const present = params.has('confirm_code') || params.has('business');
  const businessId = /^[1-9]\d{0,15}$/.test(business) ? Number(business) : NaN;
  const valid = /^\d{6}$/.test(code) && Number.isSafeInteger(businessId);
  return { present, link: valid ? { code, businessId } : null };
};

const Communicon = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { user, isLoading: authLoading } = useAuth();
  // Always start in 'ai' so the first client render matches the server, which has no
  // history state. An incoming chatMode: 'live' is applied after mount by the effect below.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const {
    message,
    setMessage,
    messages,
    setMessages,
    chatMode,
    handleChatModeChange,
    handleSendMessage,
    sendVerificationRequest,
    handleBusinessSelection,
    triggerVerificationFlow,
    triggerCertificationFlow,
    showMyListings,
    sendContactOTP,
    verifyContactOTP,
    markContactConfirmed,
    loadOwnedBusinessContact,
    checkVerificationAgain,
    isValidatingConversation,
    conversationValidated,
    validateConversation,
  } = useChatState('ai');

  useEffect(() => {
    if (window) {
      window.sendVerificationRequest = sendVerificationRequest;
      window.handleBusinessSelection = handleBusinessSelection;
    }
    return () => {
      if (window) {
        window.sendVerificationRequest = undefined;
        window.handleBusinessSelection = undefined;
      }
    };
  }, [sendVerificationRequest, handleBusinessSelection]);

  const [codeDialog, setCodeDialog] = useState<CodeDialogState | null>(null);
  // The confirm link's code, kept until the user is signed in
  const [linkConfirm, setLinkConfirm] = useState<{ code: string; businessId: number } | null>(null);

  // On arrival: take the confirm link's values (and take them out of the address bar and history
  // right away), or else reopen a code sent before a reload, without sending a new one
  useEffect(() => {
    const { present, link } = readConfirmLink(location.search);
    if (present) navigate(location.pathname, { replace: true, state: location.state });
    if (link) {
      setLinkConfirm(link);
    } else {
      const pending = loadPendingContactCode();
      if (pending) setCodeDialog(pending);
    }
    const open = () => {
      const pending = loadPendingContactCode();
      if (pending) setCodeDialog(pending);
    };
    window.addEventListener(OPEN_PENDING_CONTACT_CODE_EVENT, open);
    return () => window.removeEventListener(OPEN_PENDING_CONTACT_CODE_EVENT, open);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Once the Pi session has restored (or the user signs in), check the link is for one of
  // their businesses and open the code entry with its code
  useEffect(() => {
    if (!linkConfirm || authLoading || !user) return;
    const { code, businessId } = linkConfirm;
    setLinkConfirm(null);
    (async () => {
      const business = await loadOwnedBusinessContact(businessId);
      if (!business || !business.email) {
        toast.error("This link isn't for your account");
        return;
      }
      setCodeDialog({ ...business, initialCode: code });
    })();
  }, [linkConfirm, authLoading, user, loadOwnedBusinessContact]);

  // A link tapped twice: the code is used up, but the email is confirmed already
  const alreadyConfirmedRef = useRef(false);
  const verifyFromDialog = async (email: string, otp: string, businessId: number): Promise<ContactOTPResult> => {
    const result = await verifyContactOTP(email, otp, businessId);
    if (!result.ok && result.errorCode === 'expired' && codeDialog?.confirmedFor === email.toLowerCase()) {
      alreadyConfirmedRef.current = true;
      markContactConfirmed(email, businessId);
      return { ok: true, errorCode: null };
    }
    return result;
  };

  // The stored cards are marked Confirmed; if that was all the latest card for the business
  // was missing, get the server's answer straight away
  const handleCodeVerified = () => {
    const confirmed = codeDialog;
    setCodeDialog(null);
    if (!confirmed) return;
    toast.success(alreadyConfirmedRef.current ? 'Email already confirmed' : 'Email confirmed');
    alreadyConfirmedRef.current = false;
    const latest = [...messages].reverse().find((m) => m.verificationMetrics?.businessId === confirmed.businessId);
    const metrics = latest?.verificationMetrics;
    if (!metrics || metrics.verified) return;
    const progress = verificationProgress({ ...metrics, contactInfoConfirmed: true });
    if (progress.done === progress.total) {
      void checkVerificationAgain(confirmed.businessId, metrics.businessName, latest.id);
    }
  };

  const hasTriggeredVerification = useRef(false);

  useEffect(() => {
    const state = location.state as any;
    if (state?.triggerVerification && !hasTriggeredVerification.current) {
      hasTriggeredVerification.current = true;
      const verificationType = state.verificationType || 'verification';
      navigate(location.pathname, { replace: true, state: {} });
      triggerVerificationFlow(verificationType);
    }
  }, [location.state, triggerVerificationFlow, navigate, location.pathname]); // eslint-disable-line

  const showConversationErrorToast = (
    result: 'not_found' | 'access_denied' | 'missing',
    onRetry: () => void,
  ) => {
    if (result === 'not_found') {
      toast.error('Conversation not found', {
        description:
          'This conversation does not exist or has been removed. Start a new one from the business listing.',
        action: { label: 'Retry', onClick: onRetry },
      });
    } else if (result === 'access_denied') {
      toast.error('Access denied', {
        description:
          "You don't have access to this conversation. Make sure you're logged into the correct account.",
        action: { label: 'Retry', onClick: onRetry },
      });
    }
  };

  const retryLiveChat = useCallback(async () => {
    const conversationId = (location.state as any)?.openConversationId;
    if (!conversationId) return;
    const result = await validateConversation(conversationId);
    if (result === 'valid') {
      handleChatModeChange('live');
      toast.success('Connected to live chat');
    } else {
      showConversationErrorToast(result, retryLiveChat);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [location.state, validateConversation, handleChatModeChange]);

  // Honor incoming chatMode (e.g. 'live' from PlaceCard "Message" button)
  useEffect(() => {
    const incomingMode = (location.state as any)?.chatMode;
    if (!incomingMode || incomingMode === chatMode) return;

    if (incomingMode === 'live') {
      const openConversationId = (location.state as any)?.openConversationId;
      // MessagesPanel already opened (or reported) this conversation and cleared its ID.
      if ((location.state as any)?.openConversationHandled === true && !openConversationId) {
        handleChatModeChange('live');
        return;
      }
      if (
        openConversationId === null ||
        openConversationId === undefined ||
        (typeof openConversationId === 'string' && openConversationId.trim() === '')
      ) {
        handleChatModeChange('ai');
        toast.error('No conversation selected', {
          description: 'Open a business listing and tap Message to start a live chat.',
          action: { label: 'Go to Map', onClick: () => navigate('/') },
        });
        return;
      }
      (async () => {
        const result = await validateConversation(openConversationId);
        if (result === 'valid') {
          handleChatModeChange('live');
        } else {
          showConversationErrorToast(result, retryLiveChat);
          handleChatModeChange('ai');
        }
      })();
      return;
    }

    handleChatModeChange(incomingMode);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [(location.state as any)?.chatMode]);

  // Structured error log for live-mode opens without a usable conversation reference
  const missingConvNotifiedRef = useRef(false);
  useEffect(() => {
    if (missingConvNotifiedRef.current) return;
    const state = location.state as any;
    if (!state) return;
    if (state.chatMode !== 'live') return;
    // MessagesPanel already opened (or reported) the conversation and cleared its ID.
    if (state.openConversationHandled === true) return;
    const openConversationId = state.openConversationId ?? null;
    const inboxBusinessId = state.inboxBusinessId ?? null;
    const hasValidConvId =
      typeof openConversationId === 'string' && openConversationId.trim().length > 0;
    const hasValidInbox =
      typeof inboxBusinessId === 'number' && Number.isFinite(inboxBusinessId);
    if (hasValidConvId || hasValidInbox) return;
    missingConvNotifiedRef.current = true;
    const reason =
      openConversationId === null && inboxBusinessId === null
        ? 'missing_conversation_reference'
        : typeof openConversationId === 'string' && openConversationId.length === 0
          ? 'empty_conversation_id'
          : 'invalid_conversation_reference';
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        level: 'error',
        event: 'communicon.live_open.failed',
        fn: 'Communicon.liveModeMissingConversationEffect',
        reason,
        openConversationId,
        inboxBusinessId,
        chatMode: state.chatMode,
        expectConversation: state.expectConversation === true,
        userId: user?.uid ?? null,
        piUid: (user as any)?.pi_uid ?? null,
        pathname: location.pathname,
      }),
    );
  }, [location.state, location.pathname, user?.uid, user]);

  const handleSendMessageWrapper = () => {
    const event = new Event('submit') as unknown as React.FormEvent;
    handleSendMessage(event);
  };

  const handleQuickReply = (text: string) => {
    if (text === 'Check verification status') {
      triggerVerificationFlow('verification');
      return;
    }
    if (text === 'Check certification status') {
      triggerCertificationFlow();
      return;
    }
    if (text === 'My listings') {
      showMyListings();
      return;
    }
    handleSendMessage(null, text);
  };

  return (
    <AppLayout title="CommuniCon" fullHeight={true} hideBottomNav={true} backButton={true}>
      <div className="max-w-4xl mx-auto flex flex-1 min-h-0 flex-col w-full">
        {!mounted ? (
          <div className="flex flex-1 items-center justify-center py-16" aria-busy="true">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" aria-hidden="true" />
          </div>
        ) : isValidatingConversation ? (
          <div className="flex flex-1 flex-col items-center justify-center py-16">
            <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
            <p className="mt-3 text-sm text-muted-foreground">Verifying conversation...</p>
          </div>
        ) : (
          <ChatInterface
            chatMode={chatMode}
            onChatModeChange={handleChatModeChange}
            messages={messages}
            message={message}
            setMessage={setMessage}
            handleSendMessage={handleSendMessageWrapper}
            handleQuickReply={handleQuickReply}
            showAttachmentIcon={false}
            hasLiveChatAccess={true}
            onSendContactOTP={sendContactOTP}
            onVerifyContactOTP={verifyContactOTP}
            onCheckVerificationAgain={checkVerificationAgain}
          />
        )}
      </div>
      {codeDialog && (
        <Dialog open onOpenChange={(open) => !open && setCodeDialog(null)}>
          <DialogContent className="sm:max-w-md">
            <DialogTitle className="sr-only">Verify Contact Information</DialogTitle>
            <ContactOTPVerification
              key={`${codeDialog.businessId}:${codeDialog.initialCode ?? 'resume'}`}
              email={codeDialog.email}
              businessId={codeDialog.businessId}
              businessName={codeDialog.businessName}
              initialCode={codeDialog.initialCode}
              onSendOTP={sendContactOTP}
              onVerifyOTP={verifyFromDialog}
              onVerified={handleCodeVerified}
            />
          </DialogContent>
        </Dialog>
      )}
    </AppLayout>
  );
};

export default Communicon;
