import React, { useEffect, useState } from 'react';
import { Mail } from 'lucide-react';
import { useLocation, useNavigate } from '@/lib/router-compat';
import { useAuth } from '@/context/auth';
import {
  OPEN_PENDING_CONTACT_CODE_EVENT,
  PENDING_CONTACT_CODE_EVENT,
  PENDING_CONTACT_CODE_KEY,
  loadPendingContactCode,
  type PendingContactCode,
} from '@/components/chat/pendingContactCode';

// Codes last 15 minutes from the last send
const CODE_LIFETIME_MS = 15 * 60 * 1000;

/** "Finish confirming your email" while a contact email code is waiting to be entered */
const PendingContactCodeBanner: React.FC = () => {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  // Read after mount: the server has no localStorage
  const [pending, setPending] = useState<PendingContactCode | null>(null);

  useEffect(() => {
    const refresh = () => setPending(loadPendingContactCode());
    const onStorage = (e: StorageEvent) => {
      if (e.key === PENDING_CONTACT_CODE_KEY) refresh();
    };
    refresh();
    window.addEventListener(PENDING_CONTACT_CODE_EVENT, refresh);
    window.addEventListener('storage', onStorage);
    return () => {
      window.removeEventListener(PENDING_CONTACT_CODE_EVENT, refresh);
      window.removeEventListener('storage', onStorage);
    };
  }, []);

  // Goes away by itself when the code expires
  useEffect(() => {
    if (!pending) return;
    const timer = setTimeout(() => setPending(loadPendingContactCode()), pending.sentAt + CODE_LIFETIME_MS - Date.now());
    return () => clearTimeout(timer);
  }, [pending]);

  if (!pending || !user) return null;

  const openCodeEntry = () => {
    if (location.pathname === '/communicon') {
      window.dispatchEvent(new Event(OPEN_PENDING_CONTACT_CODE_EVENT));
    } else {
      navigate('/communicon', { state: { chatMode: 'ai' } });
    }
  };

  return (
    <div
      data-pending-code-banner
      className="flex shrink-0 items-center gap-2 border-b bg-accent px-4 text-sm text-accent-foreground"
    >
      <Mail className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
      <p className="min-w-0 flex-1">
        Finish confirming your email
        <span aria-hidden="true"> · </span>
        <button
          type="button"
          onClick={openCodeEntry}
          className="inline-flex min-h-[44px] items-center font-semibold text-primary underline underline-offset-2"
        >
          Enter code
        </button>
      </p>
    </div>
  );
};

export default PendingContactCodeBanner;
