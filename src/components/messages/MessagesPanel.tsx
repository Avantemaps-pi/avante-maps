import React, { useEffect, useMemo, useRef, useState } from 'react';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth';
import { useMessages, type Inbox } from '@/hooks/useMessages';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Badge } from '@/components/ui/badge';
import { AlertCircle, ArrowLeft, Send, MessageSquare, User as UserIcon, Store } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { StateBlock } from '@/components/ui/state-block';
import { toast } from 'sonner';
import { useLocation, useNavigate } from '@/lib/router-compat';
import { useStickToBottom } from '@/hooks/useStickToBottom';

type OwnedBusiness = { id: number; business_name: string };

// Last owned-businesses result per Supabase user, so the inbox picker shows on the
// first frame instead of popping in (and pushing the list down) after the query
const OWNED_CACHE_PREFIX = 'avante_owned_businesses:';

// Supabase user ID from the client's stored session (synchronous; never user.uid)
const readSessionUserId = (): string | null => {
  try {
    const raw = localStorage.getItem('supabase.auth.token');
    const id = raw ? (JSON.parse(raw) as { user?: { id?: unknown } })?.user?.id : null;
    return typeof id === 'string' ? id : null;
  } catch {
    return null;
  }
};

const readOwnedCache = (userId: string | null): OwnedBusiness[] => {
  if (!userId) return [];
  try {
    const raw = sessionStorage.getItem(OWNED_CACHE_PREFIX + userId);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? (parsed as OwnedBusiness[]) : [];
  } catch {
    return [];
  }
};

const writeOwnedCache = (userId: string, businesses: OwnedBusiness[]) => {
  try {
    if (businesses.length > 0) sessionStorage.setItem(OWNED_CACHE_PREFIX + userId, JSON.stringify(businesses));
    else sessionStorage.removeItem(OWNED_CACHE_PREFIX + userId);
  } catch {
    // storage unavailable — the picker just loads late
  }
};

interface MessagesPanelProps {
  initialConversationId?: string | null;
  initialInboxBusinessId?: number | null;
}

const formatTime = (iso: string) => {
  const d = new Date(iso);
  const today = new Date();
  if (d.toDateString() === today.toDateString()) {
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  }
  return d.toLocaleDateString([], { month: 'short', day: 'numeric' });
};

const MessagesPanel: React.FC<MessagesPanelProps> = ({
  initialConversationId,
  initialInboxBusinessId,
}) => {
  const { user, login } = useAuth();
  const uid = user?.uid;
  const navigate = useNavigate();
  const location = useLocation();
  // MessagesPanel renders client-side only (after CommuniCon's mount gate), so storage is readable here
  const [ownedBusinesses, setOwnedBusinesses] = useState<OwnedBusiness[]>(() =>
    typeof window === 'undefined' ? [] : readOwnedCache(readSessionUserId())
  );
  const [inboxKey, setInboxKey] = useState<string>(
    initialInboxBusinessId ? `b:${initialInboxBusinessId}` : 'customer',
  );
  const [draft, setDraft] = useState('');
  const initOpenedRef = useRef(false);

  useEffect(() => {
    if (!uid) return;
    (async () => {
      // Ownership must use the Supabase user ID (RLS: owner_id = auth.uid()), never the Pi ID
      const { data: { session } } = await supabase.auth.getSession();
      const ownerId = session?.user?.id;
      if (!ownerId) {
        setOwnedBusinesses([]);
        return;
      }
      const { data, error } = await supabase
        .from('businesses')
        .select('id,business_name')
        .eq('owner_id', ownerId)
        .order('business_name');
      // A failed refresh keeps what the cache showed
      if (error) return;
      const owned = data ?? [];
      setOwnedBusinesses(owned);
      writeOwnedCache(ownerId, owned);
    })();
  }, [uid]);

  const inbox: Inbox | null = useMemo(() => {
    if (!uid) return null;
    if (inboxKey === 'customer') return { kind: 'customer' };
    const businessId = parseInt(inboxKey.replace('b:', ''), 10);
    return { kind: 'business', businessId };
  }, [inboxKey, uid]);

  const {
    conversations,
    activeConvId,
    setActiveConvId,
    messages,
    convsLoaded,
    convsError,
    refresh,
    loadingMsgs,
    openConversation,
    sendMessage,
  } = useMessages(inbox);

  // Auto-open initial conversation once, after this inbox's conversation list has loaded
  // (before that, an empty list doesn't mean the conversation is missing).
  useEffect(() => {
    if (initOpenedRef.current) return;
    if (!initialConversationId) return;
    if (!convsLoaded) return;
    initOpenedRef.current = true;
    const match = conversations.find((c) => c.id === initialConversationId);
    if (match) {
      openConversation(initialConversationId);
    } else {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          level: 'error',
          event: 'communicon.live_open.failed',
          fn: 'MessagesPanel.autoOpenInitialConversation',
          reason: 'conversation_not_found',
          openConversationId: initialConversationId,
          initialInboxBusinessId: initialInboxBusinessId ?? null,
          userId: uid ?? null,
          inboxKind: inbox?.kind ?? null,
          inboxBusinessId: inbox?.kind === 'business' ? inbox.businessId : null,
          conversationCount: conversations.length,
          conversationIdsSample: conversations.slice(0, 5).map((c) => c.id),
        }),
      );
      toast.error("Couldn't open the conversation. Please try again.", {
        id: 'msg:open-conv-missing',
        description: 'The conversation could not be found. It may have been deleted or you may not have access.',
        duration: 5000,
      });
    }
    // Handled: drop openConversationId from the history entry so remounts and later visits
    // don't repeat it. Communicon skips its missing-conversation log when it sees the marker.
    const nextState: Record<string, unknown> = { ...((location.state as Record<string, unknown> | null) ?? {}) };
    delete nextState['openConversationId'];
    nextState['openConversationHandled'] = true;
    navigate(location.pathname, { replace: true, state: nextState });
  }, [initialConversationId, conversations, convsLoaded, openConversation]); // eslint-disable-line react-hooks/exhaustive-deps

  const messagesEndRef = useRef<HTMLDivElement>(null);
  // Keep the newest message in view when the keyboard shrinks the thread
  const threadRef = useStickToBottom();
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages.length, activeConvId]);

  const handleSend = async () => {
    const ok = await sendMessage(draft);
    if (ok) setDraft('');
  };

  const isBusinessInbox = inbox?.kind === 'business';

  const activeConv = conversations.find((c) => c.id === activeConvId);
  const selectedBusinessName =
    ownedBusinesses.find((b) => `b:${b.id}` === inboxKey)?.business_name ?? 'this business';

  if (!uid) {
    return (
      <div className="flex-1 flex flex-col items-center justify-center gap-3 p-8">
        <p className="text-sm text-muted-foreground">Sign in to use messages.</p>
        <Button type="button" className="h-11" onClick={() => void login()}>
          Sign in
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col flex-1 min-h-0">
      {/* Inbox switcher: only on the inbox list, and only when there's a business inbox to switch to */}
      {!activeConvId && ownedBusinesses.length > 0 && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-background">
          <Select value={inboxKey} onValueChange={(v) => { setInboxKey(v); setActiveConvId(null); }}>
            <SelectTrigger className="h-11 text-sm w-full" aria-label="Inbox">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="customer" className="min-h-11 text-sm">
                <span className="flex items-center gap-2">
                  <UserIcon className="h-4 w-4" /> My messages
                </span>
              </SelectItem>
              {ownedBusinesses.map((b) => (
                <SelectItem key={b.id} value={`b:${b.id}`} className="min-h-11 text-sm">
                  <span className="flex items-center gap-2">
                    <Store className="h-4 w-4" /> {b.business_name}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Body */}
      {!activeConvId ? (
        <div className="flex flex-1 min-h-0 flex-col overflow-y-auto">
          {convsLoaded ? (
            conversations.length === 0 ? (
              <StateBlock
                className="my-auto"
                kind="empty"
                icon={MessageSquare}
                title="No messages yet"
                body={
                  isBusinessInbox
                    ? `When a customer messages ${selectedBusinessName}, it shows here.`
                    : 'Message a business from its page or the map, and your chats will show here.'
                }
                {...(!isBusinessInbox ? { action: { label: 'Find a business', onClick: () => navigate('/') } } : {})}
              />
            ) : (
              <ul className="divide-y divide-border">
                {conversations.map((c) => {
                  const unread = isBusinessInbox ? c.business_unread : c.customer_unread;
                  return (
                    <li key={c.id}>
                      <button
                        type="button"
                        onClick={() => openConversation(c.id)}
                        className="w-full min-h-16 flex items-center gap-3 px-4 py-3 hover:bg-muted/50 transition-colors text-left"
                      >
                        <div className="h-10 w-10 rounded-full bg-primary/10 text-primary flex items-center justify-center flex-shrink-0">
                          {isBusinessInbox ? <UserIcon className="h-5 w-5" /> : <Store className="h-5 w-5" />}
                        </div>
                        <div className="flex-1 min-w-0">
                          <div className="flex items-baseline justify-between gap-2">
                            <p className="text-base font-semibold text-foreground truncate">
                              {isBusinessInbox
                                ? `Customer ${c.customer_id.slice(0, 6)}`
                                : c.business_name ?? 'Business no longer listed'}
                            </p>
                            <span className="text-xs text-muted-foreground flex-shrink-0">
                              {formatTime(c.last_message_at)}
                            </span>
                          </div>
                          <div className="flex items-center justify-between gap-2">
                            <p className="text-sm text-muted-foreground truncate">
                              {c.last_message_preview ?? 'No messages yet'}
                            </p>
                            {unread > 0 && (
                              <Badge
                                className="h-5 min-w-5 px-1.5 justify-center text-xs flex-shrink-0"
                                aria-label={`${unread} unread`}
                              >
                                {unread}
                              </Badge>
                            )}
                          </div>
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : convsError ? (
            <StateBlock
              className="my-auto"
              kind="error"
              icon={AlertCircle}
              title="Couldn't load conversations"
              body="Check your connection and try again."
              action={{ label: 'Try again', onClick: () => void refresh() }}
            />
          ) : (
            <ul className="divide-y divide-border" aria-busy="true" aria-label="Loading conversations">
              {[0, 1, 2].map((i) => (
                <li key={i} className="min-h-16 flex items-center gap-3 px-4 py-3">
                  <Skeleton className="h-10 w-10 rounded-full flex-shrink-0" />
                  <div className="flex-1 space-y-2">
                    <Skeleton className="h-4 w-2/5" />
                    <Skeleton className="h-3.5 w-3/4" />
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <>
          <div className="flex items-center gap-1 px-1 py-1 border-b border-border">
            <Button
              size="icon"
              variant="ghost"
              className="h-11 w-11 flex-shrink-0"
              onClick={() => setActiveConvId(null)}
              aria-label="Back to conversations"
            >
              <ArrowLeft className="h-5 w-5" />
            </Button>
            <p className="text-base font-semibold text-foreground truncate">
              {isBusinessInbox
                ? `Customer ${activeConv?.customer_id.slice(0, 6) ?? ''}`
                : activeConv?.business_name ?? 'Conversation'}
            </p>
          </div>

          <div ref={threadRef} className="flex-1 min-h-0 overflow-y-auto p-4 space-y-2">
            {loadingMsgs ? (
              <div className="space-y-3" aria-busy="true" aria-label="Loading messages">
                <Skeleton className="h-12 w-3/5 rounded-2xl" />
                <Skeleton className="h-12 w-1/2 rounded-2xl ml-auto" />
                <Skeleton className="h-12 w-2/3 rounded-2xl" />
              </div>
            ) : messages.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-6">
                Say hello to start the conversation.
              </p>
            ) : (
              messages.map((m) => {
                const mine =
                  (inbox?.kind === 'customer' && m.sender_role === 'customer') ||
                  (inbox?.kind === 'business' && m.sender_role === 'business');
                return (
                  <div key={m.id} className={`flex ${mine ? 'justify-end' : 'justify-start'}`}>
                    <div
                      className={`max-w-[80%] px-3.5 py-2 rounded-2xl text-base ${
                        mine
                          ? 'bg-primary text-primary-foreground rounded-br-md'
                          : 'bg-muted text-foreground rounded-bl-md'
                      }`}
                    >
                      <p className="whitespace-pre-wrap break-words">{m.body}</p>
                      <p className={`text-xs mt-1 ${mine ? 'text-primary-foreground' : 'text-muted-foreground'}`}>
                        {formatTime(m.created_at)}
                      </p>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </div>

          <div className="sticky bottom-0 border-t border-border bg-background px-3 pt-3 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <div className="flex items-center gap-2">
              <Input
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    handleSend();
                  }
                }}
                placeholder={isBusinessInbox ? 'Reply as your business...' : 'Type a message...'}
                aria-label="Message"
                className="flex-1 h-11 sm:h-11 rounded-full bg-muted border-0 px-4 text-base md:text-base focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-0"
              />
              <Button
                type="button"
                size="icon"
                onClick={handleSend}
                disabled={!draft.trim()}
                aria-label="Send message"
                className="h-11 w-11 rounded-full flex-shrink-0"
              >
                <Send className="h-5 w-5" />
              </Button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default MessagesPanel;
