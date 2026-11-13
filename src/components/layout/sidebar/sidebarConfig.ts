
import {
  BadgeCheck,
  Building,
  MessageSquare,
  Info,
  Bell,
  Wallet,
} from 'lucide-react';

import { getUnreadNotificationsCount } from '@/utils/notificationUtils';

export const navItems = [
  {
    to: '/notifications',
    icon: Bell,
    label: 'Notifications',
  },
  {
    to: '/registered-business',
    icon: Building,
    label: 'Registered Business',
  },
  // Plans are upgraded from the Wallet, so it sits with the business items
  {
    to: '/wallet',
    icon: Wallet,
    label: 'Wallet',
  },
  {
    to: '/pricing',
    icon: BadgeCheck,
    label: 'Plans and pricing',
  },
  // On phones CommuniCon is in the bottom nav; the desktop side menu still lists it
  {
    to: '/communicon',
    icon: MessageSquare,
    label: 'CommuniCon',
    desktopOnly: true,
  },
  {
    to: '/about',
    icon: Info,
    label: 'About Us',
  },
  {
    to: '/notification-admin',
    icon: Bell,
    label: 'Notification Admin',
    adminOnly: true,
  },
];
