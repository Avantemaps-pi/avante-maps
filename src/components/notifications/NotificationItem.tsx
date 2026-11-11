import React, { useState, useRef, useLayoutEffect } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { NotificationProps } from '@/types/notification';
import { Checkbox } from '@/components/ui/checkbox';
import { useSwipeable } from 'react-swipeable';
import { Link } from '@/lib/router-compat';
import { cn } from '@/lib/utils';
import {
  getKindConfig,
  getNotificationAction,
  getNotificationKind,
  getNotificationName,
  wasAlsoEmailed,
  type NotificationTint,
} from '@/utils/notificationKinds';

interface NotificationItemProps {
  notification: NotificationProps;
  onReadNotification: (id: string) => void;
  /** The row or its action was opened: records the click (clicked_at) */
  onOpenNotification?: (id: string) => void;
  isSelected?: boolean;
  onToggleSelection?: (id: string) => void;
  selectionMode?: boolean;
}

const TINTS: Record<NotificationTint, string> = {
  primary: 'bg-accent text-primary',
  muted: 'bg-muted text-muted-foreground',
  destructive: 'bg-destructive/15 text-destructive',
};

// Only in-app paths are followed. The server always writes one; anything else (another site, a
// javascript: URL, or // and /\ which browsers can read as another site) gets no link at all
const isInAppPath = (url: string) => url.startsWith('/') && !url.startsWith('//') && !url.startsWith('/\\');

// The text, with the person or business name in bold where it appears (or before it)
const NotificationText = ({ content, name }: { content: string; name: string | null }) => {
  if (!name) return <>{content}</>;
  const at = content.indexOf(name);
  if (at === -1) {
    return (
      <>
        <strong className="font-semibold">{name}</strong> {content}
      </>
    );
  }
  return (
    <>
      {content.slice(0, at)}
      <strong className="font-semibold">{name}</strong>
      {content.slice(at + name.length)}
    </>
  );
};

const NotificationItem: React.FC<NotificationItemProps> = ({
  notification,
  onReadNotification,
  onOpenNotification,
  isSelected = false,
  onToggleSelection,
  selectionMode = false
}) => {
  const { content, time, read, id } = notification;
  const [swipeOffset, setSwipeOffset] = useState(0);
  const [expanded, setExpanded] = useState(false);
  // Whether the text is longer than its two collapsed lines, measured after render and on resize
  const [canExpand, setCanExpand] = useState(false);
  const [fullHeight, setFullHeight] = useState(0);
  const textRef = useRef<HTMLParagraphElement>(null);
  const [isSwiping, setIsSwiping] = useState(false);
  const hasVibratedRef = useRef(false);

  const SWIPE_THRESHOLD = 80;

  const kind = getNotificationKind(notification);
  const { icon: Icon, tint } = getKindConfig(kind);
  const name = getNotificationName(notification);
  const linked = getNotificationAction(notification);
  const action = linked && isInAppPath(linked.url) ? linked : null;
  const emailed = wasAlsoEmailed(notification);

  useLayoutEffect(() => {
    const el = textRef.current;
    if (!el) return;
    const measure = () => {
      // scrollHeight is the whole text's height, clamped or not
      const lineHeight = parseFloat(getComputedStyle(el).lineHeight) || 20;
      setFullHeight(el.scrollHeight);
      setCanExpand(el.scrollHeight > lineHeight * 2 + 1);
    };
    measure();
    const observer =
      typeof ResizeObserver === 'undefined'
        ? null
        : new ResizeObserver(measure);
    observer?.observe(el);
    window.addEventListener('resize', measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', measure);
    };
  }, [content]);

  const triggerHapticFeedback = () => {
    if ('vibrate' in navigator && !hasVibratedRef.current) {
      navigator.vibrate(50); // 50ms vibration
      hasVibratedRef.current = true;
    }
  };

  // Opening marks it read and records the click
  const recordOpen = () => {
    if (!read) onReadNotification(id);
    if (action) onOpenNotification?.(id);
  };

  // A tap marks it read and opens or closes the full text in place. Only the action link navigates
  const handleClick = () => {
    if (isSwiping) return;

    if (selectionMode && onToggleSelection) {
      onToggleSelection(id);
      return;
    }
    if (!read) onReadNotification(id);
    if (canExpand) setExpanded((open) => !open);
  };

  const handleChevronClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    handleClick();
  };

  const handleActionClick = (e: React.MouseEvent) => {
    // The link navigates by itself; the row's click would do it twice
    e.stopPropagation();
    if (selectionMode) {
      e.preventDefault();
      onToggleSelection?.(id);
      return;
    }
    recordOpen();
  };

  const handleCheckboxChange = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onToggleSelection) {
      onToggleSelection(id);
    }
  };

  const handlers = useSwipeable({
    onSwiping: (eventData) => {
      if (selectionMode) return;
      setIsSwiping(true);

      // Only allow right swipe (positive deltaX) for mark as read
      const offset = Math.max(0, Math.min(120, eventData.deltaX));
      setSwipeOffset(offset);

      // Trigger haptic feedback when crossing threshold
      if (offset > SWIPE_THRESHOLD && !read) {
        triggerHapticFeedback();
      }
    },
    onSwiped: (eventData) => {
      if (selectionMode) {
        setSwipeOffset(0);
        setIsSwiping(false);
        hasVibratedRef.current = false;
        return;
      }

      // Swipe right - mark as read
      if (eventData.deltaX > SWIPE_THRESHOLD && !read) {
        onReadNotification(id);
      }

      // Reset
      setTimeout(() => {
        setSwipeOffset(0);
        setIsSwiping(false);
        hasVibratedRef.current = false;
      }, 100);
    },
    trackMouse: false,
    trackTouch: true,
    preventScrollOnSwipe: true,
  });

  const showMarkAsReadAction = swipeOffset > SWIPE_THRESHOLD && !read;
  const actionClassName =
    'self-start inline-flex min-h-11 items-center text-sm font-semibold text-primary hover:underline focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring rounded-sm';

  return (
    <div
      data-notification-row={kind}
      data-unread={read ? undefined : 'true'}
      className={cn(
        "relative overflow-hidden border-b border-border",
        isSelected && "bg-accent/60"
      )}
    >
      {/* Left action - Mark as read */}
      <div
        className={cn(
          "absolute left-0 top-0 bottom-0 w-24 flex items-center justify-center bg-primary transition-opacity",
          showMarkAsReadAction ? "opacity-100" : "opacity-0"
        )}
      >
        <Check className="h-6 w-6 text-primary-foreground" />
      </div>

      {/* Main content: opaque, so the swipe action only shows when it's pulled aside */}
      <div
        {...handlers}
        style={{
          transform: `translateX(${swipeOffset}px)`,
          transition: isSwiping ? 'none' : 'transform 0.2s ease-out'
        }}
        className="relative bg-background cursor-pointer"
        onClick={handleClick}
      >
        <div
          className={cn(
            "flex items-start gap-3 px-4 py-3 transition-colors",
            read ? "hover:bg-muted/50" : "bg-accent/40 dark:bg-primary/[0.08]"
          )}
        >
          {selectionMode && (
            <div className="mt-2" onClick={handleCheckboxChange}>
              <Checkbox checked={isSelected} />
            </div>
          )}

          <span
            data-tint={tint}
            className={cn("flex h-9 w-9 shrink-0 items-center justify-center rounded-full", TINTS[tint])}
          >
            <Icon className="h-[18px] w-[18px]" aria-hidden="true" />
          </span>

          <div className="flex min-w-0 flex-1 flex-col gap-0.5">
            <p
              ref={textRef}
              id={`notification-text-${id}`}
              data-notification-text
              data-expanded={expanded ? 'true' : undefined}
              style={
                canExpand
                  ? { maxHeight: expanded ? fullHeight : 40 }
                  : undefined
              }
              className={cn(
                'overflow-hidden text-sm leading-5 text-foreground break-words transition-[max-height] duration-200 ease-out motion-reduce:transition-none',
                !expanded && 'line-clamp-2',
              )}
            >
              <NotificationText content={content} name={name} />
            </p>
            <p className="text-xs text-muted-foreground">
              {time}
              {emailed && <span> · Also emailed</span>}
            </p>
            {action && (
              <Link to={action.url} onClick={handleActionClick} className={actionClassName}>
                {action.label}
              </Link>
            )}
          </div>

          {!selectionMode && (!read || canExpand) && (
            <div className="flex h-6 shrink-0 items-center gap-1">
              {!read && (
                <span
                  data-unread-dot
                  className="relative h-2 w-2 shrink-0 rounded-full bg-primary"
                >
                  <span className="sr-only">Unread</span>
                </span>
              )}
              {canExpand && (
                <button
                  type="button"
                  data-notification-expand
                  aria-expanded={expanded}
                  aria-controls={`notification-text-${id}`}
                  aria-label={expanded ? 'Show less' : 'Show the full message'}
                  onClick={handleChevronClick}
                  className="-my-1.5 -mr-2 flex h-9 w-9 items-center justify-center rounded-full text-muted-foreground hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ChevronDown
                    className={cn(
                      'h-4 w-4 transition-transform duration-200 motion-reduce:transition-none',
                      expanded && 'rotate-180',
                    )}
                    aria-hidden="true"
                  />
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export default NotificationItem;
