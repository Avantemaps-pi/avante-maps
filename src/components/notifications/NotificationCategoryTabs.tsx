import React, { useRef } from 'react';
import {
  NotificationCategory,
  categoryConfig,
} from '@/utils/notificationCategories';

interface NotificationCategoryTabsProps {
  activeCategory: NotificationCategory;
  onCategoryChange: (category: NotificationCategory) => void;
  /** Unread notifications per tab (getAllCategoryCounts) */
  counts: Record<NotificationCategory, number>;
}

const categories: NotificationCategory[] = ['all', 'account', 'activity'];

const formatTabCount = (count: number) => (count > 99 ? '99+' : String(count));

// All · Account · Activity, styled like CommuniCon's Messages | Bot switch
const NotificationCategoryTabs: React.FC<NotificationCategoryTabsProps> = ({
  activeCategory,
  onCategoryChange,
  counts,
}) => {
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  // Left/Right move between the tabs (and switch); the active tab is the one Tab stop
  const handleKeyDown = (
    e: React.KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
    e.preventDefault();
    const next =
      (index + (e.key === 'ArrowRight' ? 1 : -1) + categories.length) %
      categories.length;
    const category = categories[next];
    if (!category) return;
    onCategoryChange(category);
    tabRefs.current[next]?.focus();
  };

  return (
    <div
      role="tablist"
      aria-label="Notifications"
      className="flex w-full rounded-full bg-muted p-[3px]"
    >
      {categories.map((category, index) => {
        const active = activeCategory === category;
        const unread = counts[category];
        return (
          <button
            key={category}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            // Read as "Account, 2 unread"; with nothing unread, the label alone
            aria-label={
              unread > 0
                ? `${categoryConfig[category].label}, ${unread} unread`
                : undefined
            }
            tabIndex={active ? 0 : -1}
            onClick={() => onCategoryChange(category)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`flex h-11 min-w-0 flex-1 items-center justify-center gap-1.5 rounded-full text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted ${
              active
                ? 'bg-background font-semibold text-primary shadow-sm dark:bg-accent dark:shadow-none'
                : 'font-medium text-muted-foreground hover:text-foreground'
            }`}
          >
            {categoryConfig[category].label}
            {/* The unread count, hidden at 0 */}
            {unread > 0 && (
              <span
                data-tab-unread
                aria-hidden="true"
                className={`flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-[11px] font-semibold leading-none tabular-nums ${
                  active
                    ? 'bg-primary text-primary-foreground'
                    : 'bg-muted-foreground/15 text-foreground'
                }`}
              >
                {formatTabCount(unread)}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
};

export default NotificationCategoryTabs;
