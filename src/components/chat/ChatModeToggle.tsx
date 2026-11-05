import React, { useRef } from 'react';
import { Bot, MessageSquare } from 'lucide-react';
import { ChatMode } from './ChatInterface';

interface ChatModeToggleProps {
  chatMode: ChatMode;
  onChatModeChange: (value: ChatMode) => void;
  hasLiveChatAccess?: boolean;
}

const MODES: Array<{ value: ChatMode; label: string; icon: React.ElementType }> = [
  { value: 'live', label: 'Messages', icon: MessageSquare },
  { value: 'ai', label: 'Bot', icon: Bot },
];

// Slim full-width row: a segmented control with two equal 44px tabs
const ChatModeToggle: React.FC<ChatModeToggleProps> = ({
  chatMode,
  onChatModeChange,
}) => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Left/Right move between the tabs (and switch mode); the active tab is the one Tab stop
  const handleKeyDown = (e: React.KeyboardEvent<HTMLButtonElement>, index: number) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next = (index + (e.key === 'ArrowRight' ? 1 : -1) + MODES.length) % MODES.length;
    const mode = MODES[next];
    if (!mode) return;
    onChatModeChange(mode.value);
    tabRefs.current[next]?.focus();
  };

  return (
    <div className="border-b border-border bg-background px-3 py-[3px]">
      <div role="tablist" aria-label="CommuniCon mode" className="flex w-full rounded-full bg-muted p-[3px]">
        {MODES.map(({ value, label, icon: Icon }, index) => {
          const active = chatMode === value;
          return (
            <button
              key={value}
              ref={(el) => { tabRefs.current[index] = el; }}
              type="button"
              role="tab"
              aria-selected={active}
              tabIndex={active ? 0 : -1}
              onClick={() => onChatModeChange(value)}
              onKeyDown={(e) => handleKeyDown(e, index)}
              className={`flex h-11 flex-1 items-center justify-center gap-2 rounded-full text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted ${
                active
                  ? 'bg-background font-semibold text-primary shadow-sm dark:bg-accent dark:shadow-none'
                  : 'font-medium text-muted-foreground hover:text-foreground'
              }`}
            >
              <Icon className="h-4 w-4" aria-hidden="true" />
              {label}
            </button>
          );
        })}
      </div>
    </div>
  );
};

export default ChatModeToggle;
