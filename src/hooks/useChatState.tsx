
import { useState, useCallback, useEffect } from 'react';
import { useNavigate } from '@/lib/router-compat';
import { filterInappropriateContent, isSafeForAI } from '@/utils/contentFilter';
import { VerificationMetrics } from '@/components/chat/VerificationResultCard';
import type { ContactOTPResult } from '@/components/chat/ContactOTPVerification';
import { verificationProgress } from '@/components/chat/verificationProgress';
import { useToast } from '@/hooks/use-toast';
import { ChatMode } from '@/components/chat/ChatInterface';
import { supabase } from '@/integrations/supabase/client';
import { SUPABASE_CONFIG, getSupabaseFunctionsUrl } from '@/config/supabase';
import { useAuth } from '@/context/auth';

const CHAT_STORAGE_PREFIX = 'avante-chat-messages-v2';
const GUEST_CHAT_KEY = `${CHAT_STORAGE_PREFIX}:guest`;
const getChatStorageKey = (uid?: string | null) =>
  uid ? `${CHAT_STORAGE_PREFIX}:${uid}` : GUEST_CHAT_KEY;

type ChatMessage = {
  id: number;
  text: string;
  sender: string;
  timestamp: string;
  businesses?: Array<{ id: number; business_name: string; verification_status?: string | null; is_verified?: boolean }>;
  verificationMetrics?: VerificationMetrics | undefined;
  contactVerification?: { email: string; businessId: number };
  animateVerification?: boolean;
};

const getDefaultMessages = (): ChatMessage[] => [
  {
    id: 1,
    text: "Hi! I can help you check your business verification status, certification status, or answer questions about your listing. What would you like to know?",
    sender: "ai",
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
  },
];

// The saved bot chat keeps only its newest messages, so it can't grow forever
const MAX_SAVED_MESSAGES = 50;

const loadMessagesFromStorage = (key: string): ChatMessage[] => {
  try {
    const stored = localStorage.getItem(key);
    if (stored) {
      const parsed = JSON.parse(stored);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return parsed.slice(-MAX_SAVED_MESSAGES);
      }
    }
  } catch (error) {
    console.error('Error loading chat messages from storage:', error);
  }
  return getDefaultMessages();
};

const saveMessagesToStorage = (key: string, messages: ChatMessage[]) => {
  try {
    localStorage.setItem(key, JSON.stringify(messages.slice(-MAX_SAVED_MESSAGES)));
  } catch (error) {
    console.error('Error saving chat messages to storage:', error);
  }
};

export function useChatState(initialChatMode: ChatMode = "ai") {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { user } = useAuth();
  const [message, setMessage] = useState("");
  const storageKey = getChatStorageKey(user?.uid);
  // SSR-safe: start empty and hydrate from localStorage in the mount effect
  // below (the default greeting's timestamp is nondeterministic, so building
  // it during render would mismatch between server and client).
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [chatMode, setChatMode] = useState<ChatMode>(initialChatMode);
  const [awaitingVerificationConfirmation, setAwaitingVerificationConfirmation] = useState(false);
  const [awaitingBusinessSelection, setAwaitingBusinessSelection] = useState(false);
  const [awaitingVerificationBusinessSelection, setAwaitingVerificationBusinessSelection] = useState(false);
  const [selectedBusinessForVerification, setSelectedBusinessForVerification] = useState<any>(null);
  const [userBusinesses, setUserBusinesses] = useState<any[]>([]);
  const [isValidatingConversation, setIsValidatingConversation] = useState(false);
  const [conversationValidated, setConversationValidated] = useState<boolean | null>(null);

  const validateConversation = useCallback(async (conversationId: string): Promise<'valid' | 'not_found' | 'access_denied' | 'missing'> => {
    if (!conversationId || conversationId.trim() === '') return 'missing';
    setIsValidatingConversation(true);
    setConversationValidated(null);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const userId = session?.user?.id;
      if (!userId) {
        setConversationValidated(false);
        return 'access_denied';
      }
      const { data: convData, error: convError } = await supabase
        .from('conversations')
        .select('id, customer_id, business_id')
        .eq('id', conversationId)
        .maybeSingle();
      if (convError || convData === null) {
        setConversationValidated(false);
        return 'not_found';
      }
      if (convData.customer_id === userId) {
        setConversationValidated(true);
        return 'valid';
      }
      const { data: bizData } = await supabase
        .from('businesses')
        .select('id')
        .eq('id', convData.business_id)
        .eq('owner_id', userId)
        .maybeSingle();
      if (bizData) {
        setConversationValidated(true);
        return 'valid';
      }
      setConversationValidated(false);
      return 'access_denied';
    } catch {
      setConversationValidated(false);
      return 'not_found';
    } finally {
      setIsValidatingConversation(false);
    }
  }, []);

  // Reload messages when the active user changes (login/logout/switch account)
  useEffect(() => {
    setMessages(loadMessagesFromStorage(storageKey));
  }, [storageKey]);

  // Persist messages to localStorage whenever they change.
  // Skip the initial empty state so we never clobber stored messages
  // before the hydration effect above has loaded them.
  useEffect(() => {
    if (messages.length === 0) return;
    saveMessagesToStorage(storageKey, messages);
  }, [messages, storageKey]);

  // Fetch user's businesses from Supabase
  const fetchUserBusinesses = useCallback(async () => {
    if (!user?.uid) return [];

    try {
      // Ownership must use the Supabase user ID (RLS: owner_id = auth.uid()), never the Pi ID
      const { data: { session } } = await supabase.auth.getSession();
      const ownerId = session?.user?.id;
      if (!ownerId) return [];

      const { data, error } = await supabase
        .from('businesses')
        .select('id, business_name, verification_status, is_verified, created_at')
        .eq('owner_id', ownerId)
        .order('created_at', { ascending: true });

      if (error) throw error;
      return data || [];
    } catch (error) {
      console.error('Error fetching businesses:', error);
      toast({
        title: "Error",
        description: "Failed to fetch your businesses. Please try again.",
        variant: "destructive",
      });
      return [];
    }
  }, [user?.uid, toast]);

  // Update verification status in database
  const updateVerificationStatus = async (businessId: number, status: string) => {
    try {
      const { error } = await supabase
        .from('businesses')
        .update({ verification_status: status })
        .eq('id', businessId);

      if (error) throw error;
      return true;
    } catch (error) {
      console.error('Error updating verification status:', error);
      return false;
    }
  };

  const streamAIResponse = async (conversationMessages: typeof messages) => {
    try {
      const aiMessageId = conversationMessages.length + 1;
      const aiMessage = {
        id: aiMessageId,
        text: "",
        sender: "ai",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      setMessages(prev => [...prev, aiMessage]);

      const apiMessages = conversationMessages
        .filter(msg => msg.sender === 'user' || msg.sender === 'ai')
        .map(msg => ({
          role: msg.sender === 'user' ? 'user' : 'assistant',
          content: msg.text
        }));

      const CHAT_URL = `${getSupabaseFunctionsUrl()}/chat-ai`;

      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      const response = await fetch(CHAT_URL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          apikey: SUPABASE_CONFIG.anonKey,
          ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
        },
        body: JSON.stringify({ messages: apiMessages }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || 'AI service error');
      }

      if (!response.body) {
        throw new Error('No response body');
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let textBuffer = '';
      let streamDone = false;
      let accumulatedText = '';

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) break;
        
        textBuffer += decoder.decode(value, { stream: true });

        let newlineIndex: number;
        while ((newlineIndex = textBuffer.indexOf('\n')) !== -1) {
          let line = textBuffer.slice(0, newlineIndex);
          textBuffer = textBuffer.slice(newlineIndex + 1);

          if (line.endsWith('\r')) line = line.slice(0, -1);
          if (line.startsWith(':') || line.trim() === '') continue;
          if (!line.startsWith('data: ')) continue;

          const jsonStr = line.slice(6).trim();
          if (jsonStr === '[DONE]') {
            streamDone = true;
            break;
          }

          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              accumulatedText += content;
              
              setMessages(prev => 
                prev.map(msg => 
                  msg.id === aiMessageId 
                    ? { ...msg, text: accumulatedText }
                    : msg
                )
              );
            }
          } catch {
            textBuffer = line + '\n' + textBuffer;
            break;
          }
        }
      }

      if (textBuffer.trim()) {
        for (let raw of textBuffer.split('\n')) {
          if (!raw) continue;
          if (raw.endsWith('\r')) raw = raw.slice(0, -1);
          if (raw.startsWith(':') || raw.trim() === '') continue;
          if (!raw.startsWith('data: ')) continue;
          const jsonStr = raw.slice(6).trim();
          if (jsonStr === '[DONE]') continue;
          try {
            const parsed = JSON.parse(jsonStr);
            const content = parsed.choices?.[0]?.delta?.content as string | undefined;
            if (content) {
              accumulatedText += content;
              setMessages(prev => 
                prev.map(msg => 
                  msg.id === aiMessageId 
                    ? { ...msg, text: accumulatedText }
                    : msg
                )
              );
            }
          } catch { /* ignore */ }
        }
      }
    } catch (error) {
      console.error('Error streaming AI response:', error);
      toast({
        title: "AI Error",
        description: error instanceof Error ? error.message : "Failed to get AI response. Please try again.",
        variant: "destructive",
      });
      
      setMessages(prev => prev.filter(msg => !(msg.sender === 'ai' && msg.text === '')));
    }
  };

  const handleSendMessage = async (e?: React.FormEvent | null, textOverride?: string) => {
    if (e && typeof (e as any).preventDefault === 'function') e.preventDefault();
    const rawText = (textOverride ?? message).trim();
    if (rawText) {
      // Filter and validate message for AI mode
      if (chatMode === "ai" && !isSafeForAI(rawText)) {
        toast({
          title: "Message blocked",
          description: "Your message contains inappropriate content or patterns. Please rephrase.",
          variant: "destructive",
        });
        return;
      }

      const filteredMessage = chatMode === "ai" ? filterInappropriateContent(rawText) : rawText;

      // Handle business selection for verification - now handled by button clicks
      if (awaitingVerificationBusinessSelection) {
        const errorMessage = {
          id: messages.length + 1,
          text: "Please click one of the business buttons above to select.",
          sender: "support",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages([...messages, errorMessage]);
        setMessage("");
        return;
      }

      // Handle verification confirmation responses
      if (awaitingVerificationConfirmation) {
        if (rawText.toLowerCase().includes('yes') || rawText.toLowerCase() === 'y') {
          sendVerificationRequest('verification');
          setAwaitingVerificationConfirmation(false);
          setMessage("");
          return;
        } else if (rawText.toLowerCase().includes('no') || rawText.toLowerCase() === 'n') {
          const cancelMessage = {
            id: messages.length + 1,
            text: "Verification request cancelled.",
            sender: "support",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          setMessages([...messages, cancelMessage]);
          setAwaitingVerificationConfirmation(false);
          setMessage("");
          return;
        }
      }

      // Handle business selection for certification
      if (awaitingBusinessSelection) {
        // Mock business selection logic
        const businessName = rawText;
        const selectionMessage = {
          id: messages.length + 1,
          text: `Selected business: ${businessName}`,
          sender: "user",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        setMessages([...messages, selectionMessage]);
        
        setTimeout(() => {
          const responseMessage = {
            id: messages.length + 2,
            text: `Certification request for "${businessName}" has been received. Our team will review your application and get back to you shortly.`,
            sender: "support",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          setMessages(prev => [...prev, responseMessage]);
        }, 1000);
        
        setAwaitingBusinessSelection(false);
        setMessage("");
        return;
      }
      
      // Check for special commands
      if (rawText.includes('/verification')) {
        await triggerVerificationFlow('verification');
        setMessage("");
        return;
      }
      
      if (rawText.includes('/certification')) {
        // Show business selection for certification
        const businesses = await fetchUserBusinesses();
        
        if (businesses.length === 0) {
          const noBusinessMessage = {
            id: messages.length + 1,
            text: "You don't have any registered businesses yet. Please register a business first.",
            sender: "support",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          setMessages([...messages, noBusinessMessage]);
          setMessage("");
          return;
        }
        
        const businessSelectionMessage = {
          id: messages.length + 1,
          text: "Please select which business you'd like to certify:",
          sender: "support",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        const businessList = businesses.map(b => `• ${b.business_name}`).join('\n');
        const businessOptionsMessage = {
          id: messages.length + 2,
          text: `Available businesses:\n${businessList}\n\nPlease type the name of the business you want to certify:`,
          sender: "support",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        setMessages([...messages, businessSelectionMessage, businessOptionsMessage]);
        setAwaitingBusinessSelection(true);
        setMessage("");
        return;
      }
      
      if (rawText.includes('/attach')) {
        // Handle attachment request - show options
        const systemMessage = {
          id: messages.length + 1,
          text: "Please select an attachment type:",
          sender: "system",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        const optionsMessage = {
          id: messages.length + 2,
          text: "Choose your attachment type:",
          sender: "attachment-options",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        
        setMessages([...messages, systemMessage, optionsMessage]);
        setMessage("");
        return;
      }
      
      const newMessage = {
        id: messages.length + 1,
        text: filteredMessage,
        sender: "user",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      const updatedMessages = [...messages, newMessage];
      setMessages(updatedMessages);
      setMessage("");
      
      // Handle AI mode with streaming
      if (chatMode === "ai") {
        await streamAIResponse(updatedMessages);
      } else {
        // LIVE mode - placeholder
        setTimeout(() => {
          const responseMessage = {
            id: updatedMessages.length + 1,
            text: "A live agent has received your message. We'll respond as soon as possible.",
            sender: "live-support",
            timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
          };
          setMessages(prev => [...prev, responseMessage]);
        }, 1000);
      }
    }
  };

  const handleChatModeChange = (value: string) => {
    if (value && value !== chatMode) {
      setChatMode(value as ChatMode);
    }
  };

  const handleAttachmentOption = (type: string) => {
    console.log(`Attachment type selected: ${type}`);
    // Implement actual attachment handling logic here
    
    const requestMessage = {
      id: messages.length + 1,
      text: "Requesting to attach a file",
      sender: "user",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    
    setMessages([...messages, requestMessage]);
    
    // Add a response
    setTimeout(() => {
      const responseMessage = {
        id: messages.length + 2,
        text: "File attachment is currently unavailable in the demo version.",
        sender: "support",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, responseMessage]);
    }, 1000);
  };

  const sendVerificationRequest = (type: 'verification' | 'certification') => {
    const requestMessage = {
      id: messages.length + 1,
      text: type === 'verification' ? "Requesting Verification" : "Requesting Certification",
      sender: "user",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    
    setMessages([...messages, requestMessage]);
    
    // Add a response
    setTimeout(() => {
      const responseMessage = {
        id: messages.length + 2,
        text: `Your ${type} request has been received. Our team will review your application and get back to you shortly.`,
        sender: "support",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, responseMessage]);
    }, 1000);
  };

  // Trigger verification flow
  const triggerVerificationFlow = useCallback(async (type: 'verification' | 'certification') => {
    // Add user's message to chat
    const userMessage = {
      id: Date.now(),
      text: `/verification`,
      sender: "user",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    
    setMessages(prev => [...prev, userMessage]);

    // Fetch user's businesses
    const businesses = await fetchUserBusinesses();
    setUserBusinesses(businesses);

    if (businesses.length === 0) {
      // No businesses registered
      const noBusinessMessage = {
        id: Date.now() + 1,
        text: "You don't have any registered businesses yet. Please register a business first to request verification.",
        sender: "support",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, noBusinessMessage]);

      setTimeout(() => {
        navigate('/registration');
      }, 2000);
      return;
    }

    // Show business selection
    const businessSelectionMessage = {
      id: Date.now() + 2,
      text: "Please select which business you'd like to verify:",
      sender: "support",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    };
    
    const businessOptionsMessage = {
      id: Date.now() + 3,
      text: "Select your business:",
      sender: "business-selection",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      businesses: businesses // Pass businesses data
    };
    
    setMessages(prev => [...prev, businessSelectionMessage, businessOptionsMessage]);
    setAwaitingVerificationBusinessSelection(true);
  }, [fetchUserBusinesses, navigate]);

  // Runs verify-business for one business and posts the result card (after a business is
  // picked, and from the card's "Check again")
  // With a target message ("Check again"), its card updates in place; otherwise a new one is added
  const runVerification = useCallback(async (business: { id: number; business_name: string }, targetMessageId?: number) => {
    if (targetMessageId === undefined) {
      const processingMessage = {
        id: Date.now() + 1,
        text: `Processing verification request for "${business.business_name}"...`,
        sender: "support",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, processingMessage]);
    }

    try {
      // Get current session for auth token
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;

      if (!accessToken) {
        throw new Error('Not authenticated. Please log in and try again.');
      }

      // Call the verify-business edge function
      const response = await fetch(
        `${getSupabaseFunctionsUrl()}/verify-business`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_CONFIG.anonKey,
            'Authorization': `Bearer ${accessToken}`,
          },
          body: JSON.stringify({
            business_id: business.id,
            verification_type: 'verification'
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || 'Verification request failed');
      }

      // Audit trail belongs in the verify-business edge function (service role); RLS blocks client inserts and it doesn't log it today.

      // Handle blockchain verification results
      const bizResult = result.results?.[0];

      // The business's contact email (the code only goes there) and its server-recorded
      // confirmation: it counts only while it matches the current email, as in verify-business
      const { data: bizData, error: bizError } = await supabase
        .from('businesses')
        .select('contact_info, contact_email_verified_for')
        .eq('id', business.id)
        .single();
      // Before the contact_email_confirmation migration is applied the column doesn't exist:
      // still read the contact email, and leave confirmation to verify-business's answer
      const { data: contactOnly } = bizError
        ? await supabase.from('businesses').select('contact_info').eq('id', business.id).single()
        : { data: null };

      const contactInfo = (bizData ?? contactOnly)?.contact_info as { email?: unknown } | null | undefined;
      const contactEmail = typeof contactInfo?.email === 'string' ? contactInfo.email.trim() : '';
      const confirmedFor = bizData?.contact_email_verified_for ?? null;
      const contactInfoConfirmed = typeof bizResult?.contactConfirmed === 'boolean'
        ? bizResult.contactConfirmed
        : !!contactEmail && confirmedFor === contactEmail.toLowerCase();

      const metrics: VerificationMetrics = {
        contactInfoConfirmed,
        reason: bizResult?.reason ?? null,
        totalTransactions: bizResult?.totalTransactions ?? 0,
        creditedTransactions: bizResult?.creditedTransactions ?? 0,
        uniqueWallets: bizResult?.uniqueWallets ?? 0,
        verified: bizResult?.verified ?? false,
        businessName: business.business_name,
        walletMissing: !bizResult?.totalTransactions && !bizResult?.uniqueWallets && bizResult?.reason?.includes('wallet'),
        businessId: business.id,
        checkedAt: new Date().toISOString(),
      };

      if (targetMessageId !== undefined) {
        setMessages(prev => prev.map(msg =>
          msg.id === targetMessageId
            ? {
                ...msg,
                verificationMetrics: metrics,
                contactVerification: { email: contactEmail, businessId: business.id },
                animateVerification: false,
              }
            : msg
        ));
      }

      if (bizResult?.verified) {
        const successMessage: ChatMessage = {
          id: Date.now() + 2,
          // The card is the message: no bubble text
          text: '',
          sender: "support",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          verificationMetrics: metrics,
          animateVerification: true,
          contactVerification: { email: contactEmail, businessId: business.id },
        };
        if (targetMessageId === undefined) setMessages(prev => [...prev, successMessage]);

        toast({
          title: "Verified!",
          description: `"${business.business_name}" is now verified.`,
        });
      } else {
        const failMessage: ChatMessage = {
          id: Date.now() + 2,
          // The card is the message: no bubble text. It shows the masked contact email and,
          // while it isn't confirmed, offers the code (or asks for a contact email first)
          text: '',
          sender: "support",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
          verificationMetrics: metrics,
          animateVerification: true,
          contactVerification: { email: contactEmail, businessId: business.id },
        };
        if (targetMessageId === undefined) setMessages(prev => [...prev, failMessage]);

        const { done, total } = verificationProgress(metrics);
        toast({
          title: "Not verified yet",
          description: `${done} of ${total} done. Check the card for what's left.`,
        });
      }

    } catch (error: any) {
      console.error('Verification request error:', error);

      // Check again: the card stays as it was
      if (targetMessageId !== undefined) {
        toast({
          title: "Couldn't check again",
          description: error.message || 'Please try again.',
          variant: 'destructive',
        });
        return;
      }

      const errorMessage = {
        id: Date.now() + 2,
        text: `Verification failed for "${business.business_name}". ${error.message || 'Please try again.'}`,
        sender: "support",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      setMessages(prev => [...prev, errorMessage]);
    }
  }, [toast]);

  // Handle business selection from buttons
  const handleBusinessSelection = useCallback(async (business: any) => {
    if (awaitingVerificationBusinessSelection) {
      setSelectedBusinessForVerification(business);
      
      const selectionMessage = {
        id: Date.now(),
        text: `Selected business: ${business.business_name}`,
        sender: "user",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      
      setMessages(prev => [...prev, selectionMessage]);
      
      // Check verification status
      if (business.is_verified || business.verification_status === 'verified') {
        const alreadyVerifiedMessage = {
          id: Date.now() + 1,
          text: `"${business.business_name}" is already verified! ✓`,
          sender: "support",
          timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
        };
        setMessages(prev => [...prev, alreadyVerifiedMessage]);
        setAwaitingVerificationBusinessSelection(false);
        return;
      }
      
      // If pending from a previous attempt, allow re-triggering verification
      await runVerification(business);
      setAwaitingVerificationBusinessSelection(false);
    }
  }, [awaitingVerificationBusinessSelection, updateVerificationStatus, toast, runVerification]);

  // "Check again" on a result card: the same business, no picker
  const checkVerificationAgain = useCallback(
    (businessId: number, businessName: string, messageId?: number) =>
      runVerification({ id: businessId, business_name: businessName }, messageId),
    [runVerification]
  );

  // Show certification "coming soon" message
  const triggerCertificationFlow = useCallback(() => {
    const userMessage: ChatMessage = {
      id: Date.now(),
      text: "Check certification status",
      sender: "user",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const replyMessage: ChatMessage = {
      id: Date.now() + 1,
      text: "Business certification is coming soon. Once it launches, you'll be able to request and check certification status right here in CommuniCon.",
      sender: "support",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userMessage, replyMessage]);
  }, []);

  // Show user's listings with statuses
  const showMyListings = useCallback(async () => {
    const userMessage: ChatMessage = {
      id: Date.now(),
      text: "My listings",
      sender: "user",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    setMessages(prev => [...prev, userMessage]);

    const businesses = await fetchUserBusinesses();

    if (businesses.length === 0) {
      const noneMessage: ChatMessage = {
        id: Date.now() + 1,
        text: "You don't have any registered businesses yet. Tap below to register one.",
        sender: "support",
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      };
      setMessages(prev => [...prev, noneMessage]);
      setTimeout(() => navigate('/registration'), 1500);
      return;
    }

    const lines = businesses.map(b => {
      const verified = b.is_verified || b.verification_status === 'verified';
      const status = verified ? '✓ Verified' : (b.verification_status ? `• ${b.verification_status}` : '• Not verified');
      return `• ${b.business_name} — ${status}`;
    }).join('\n');

    const summaryMessage: ChatMessage = {
      id: Date.now() + 1,
      text: `Here are your listings:\n${lines}\n\nSelect one below to request or recheck verification:`,
      sender: "support",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
    };
    const selectionMessage: ChatMessage = {
      id: Date.now() + 2,
      text: "Select your business:",
      sender: "business-selection",
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
      businesses,
    };
    setMessages(prev => [...prev, summaryMessage, selectionMessage]);
    setAwaitingVerificationBusinessSelection(true);
  }, [fetchUserBusinesses, navigate]);

  // contact-otp: { ok } or the error_code it returned, for the card to explain
  const callContactOTP = useCallback(async (body: Record<string, unknown>): Promise<ContactOTPResult> => {
    try {
      const { data: sessionData } = await supabase.auth.getSession();
      const accessToken = sessionData?.session?.access_token;
      const response = await fetch(
        `${getSupabaseFunctionsUrl()}/contact-otp`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            apikey: SUPABASE_CONFIG.anonKey,
            ...(accessToken ? { 'Authorization': `Bearer ${accessToken}` } : {}),
          },
          body: JSON.stringify(body),
        }
      );
      if (response.ok) return { ok: true, errorCode: null };
      const data = (await response.json().catch(() => null)) as { error_code?: unknown } | null;
      return { ok: false, errorCode: typeof data?.error_code === 'string' ? data.error_code : null };
    } catch {
      return { ok: false, errorCode: null };
    }
  }, []);

  const sendContactOTP = useCallback(
    (email: string, businessId: number) => callContactOTP({ action: 'send', email, business_id: businessId }),
    [callContactOTP]
  );

  // A business the signed-in user owns, with its contact email (for the email's confirm link).
  // null if it isn't theirs (RLS and the owner filter) or there's no session.
  const loadOwnedBusinessContact = useCallback(async (businessId: number) => {
    const { data: { session } } = await supabase.auth.getSession();
    const userId = session?.user?.id;
    if (!userId) return null;
    const { data, error } = await supabase
      .from('businesses')
      .select('id, business_name, contact_info, contact_email_verified_for')
      .eq('id', businessId)
      .eq('owner_id', userId)
      .maybeSingle();
    if (error || !data) return null;
    const contactInfo = data.contact_info as { email?: unknown } | null;
    const email = typeof contactInfo?.email === 'string' ? contactInfo.email.trim() : '';
    return {
      businessId: data.id,
      businessName: data.business_name,
      email,
      confirmedFor: data.contact_email_verified_for ?? null,
    };
  }, []);

  // Marks the latest card for this email and business as confirmed. Older cards are a record
  // of their own check, so they keep what they showed
  const markContactConfirmed = useCallback((email: string, businessId: number) => {
    setMessages(prev => {
      const latest = [...prev].reverse().find(msg => msg.verificationMetrics && msg.contactVerification?.businessId === businessId);
      if (!latest?.verificationMetrics || latest.contactVerification?.email.toLowerCase() !== email.toLowerCase()) return prev;
      const confirmed = { ...latest, verificationMetrics: { ...latest.verificationMetrics, contactInfoConfirmed: true } };
      return prev.map(msg => (msg === latest ? confirmed : msg));
    });
  }, []);

  const verifyContactOTP = useCallback(async (email: string, otp: string, businessId: number): Promise<ContactOTPResult> => {
    const result = await callContactOTP({ action: 'verify', email, otp, business_id: businessId });
    if (result.ok) markContactConfirmed(email, businessId);
    return result;
  }, [callContactOTP, markContactConfirmed]);

  return {
    message,
    setMessage,
    messages,
    setMessages,
    chatMode,
    setChatMode,
    handleSendMessage,
    handleChatModeChange,
    handleAttachmentOption,
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
  };
}

