import React from 'react';
import { Bell } from 'lucide-react';
import { StateBlock } from '@/components/ui/state-block';
import { NotificationCategory } from '@/utils/notificationCategories';

const BODY: Record<NotificationCategory, string> = {
  all: "We'll let you know about messages, reviews, your plan and your businesses.",
  account: 'Updates about your businesses, plan and payments show here.',
  activity: 'Messages and reviews show here.',
};

const EmptyNotifications: React.FC<{ category?: NotificationCategory }> = ({
  category = 'all',
}) => (
  <StateBlock
    kind="empty"
    icon={Bell}
    title="No notifications yet"
    body={BODY[category]}
    className="py-14"
  />
);

export default EmptyNotifications;
