import React, { useRef } from 'react';
import {
  NotificationCategory,
  categoryConfig,
} from '@/utils/notificationCategories';

interface NotificationCategoryTabsProps {
  activeCategory: NotificationCategory;
  onCategoryChange: (category: NotificationCategory) => void;
}

const categories: NotificationCategory[] = ['all', 'account', 'activity'];

// All · Account · Activity, styled like CommuniCon's Messages | Bot switch
const NotificationCategoryTabs: React.FC<NotificationCategoryTabsProps> = ({
  activeCategory,
  onCategoryChange,
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
        return (
          <button
            key={category}
            ref={(el) => {
              tabRefs.current[index] = el;
            }}
            type="button"
            role="tab"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onCategoryChange(category)}
            onKeyDown={(e) => handleKeyDown(e, index)}
            className={`flex h-11 flex-1 items-center justify-center rounded-full text-sm transition-colors focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-muted ${
              active
                ? 'bg-background font-semibold text-primary shadow-sm dark:bg-accent dark:shadow-none'
                : 'font-medium text-muted-foreground hover:text-foreground'
            }`}
          >
            {categoryConfig[category].label}
          </button>
        );
      })}
    </div>
  );
};

export default NotificationCategoryTabs;
