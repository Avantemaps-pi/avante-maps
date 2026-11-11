
import React, { useRef } from 'react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { useAutoGrow } from '@/hooks/useAutoGrow';
import { Label } from '@/components/ui/label';
import { Skeleton } from '@/components/ui/skeleton';
import { useNavigate } from '@/lib/router-compat';
import { PiUser } from '@/context/AuthContext';

interface ProfileSettingsProps {
  isMobile?: boolean;
  user: PiUser | null;
  isLoading: boolean;
}

const ProfileSettings = ({
  isMobile,
  user,
  isLoading
}: ProfileSettingsProps) => {
  const navigate = useNavigate();
  // The whole wallet address, wrapping rather than cut off
  const walletRef = useRef<HTMLTextAreaElement | null>(null);
  useAutoGrow(walletRef, `${isLoading}:${user?.walletAddress ?? ''}`);

  const formatSubscriptionTier = (tier: string = 'individual') => {
    return tier.charAt(0).toUpperCase() + tier.slice(1).replace('-', ' ');
  };

  const handleTierClick = () => {
    navigate('/pricing');
  };

  return (
    <Card className="overflow-hidden">
      <CardHeader className="p-4 sm:p-6">
        <CardTitle className="text-lg sm:text-xl">Profile Settings</CardTitle>
        <CardDescription className="text-xs sm:text-sm">Manage your personal information.</CardDescription>
      </CardHeader>
      <CardContent className="p-4 sm:p-6 pt-0 space-y-4 sm:space-y-6">
        <div className="space-y-1 sm:space-y-2">
          <Label htmlFor="username" className="text-sm">Username</Label>
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Input
              id="username"
              name="username"
              placeholder="username"
              value={user?.username || ''}
              readOnly
              autoComplete="username"
              className="bg-muted h-9"
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Username is provided by Pi Network and cannot be changed.
          </p>
        </div>

        <div className="space-y-1 sm:space-y-2">
          <Label htmlFor="wallet" className="text-sm">Pi Wallet Address</Label>
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Textarea
              ref={walletRef}
              id="wallet"
              name="wallet"
              placeholder="Not provided"
              value={user?.walletAddress || ''}
              readOnly
              rows={1}
              autoComplete="off"
              className="min-h-9 resize-none overflow-hidden break-all bg-muted py-1.5 font-mono text-sm sm:text-sm"
            />
          )}
          <p className="text-xs text-muted-foreground mt-1">
            Wallet address is provided by Pi Network and cannot be changed.
          </p>
        </div>

        <div className="space-y-1 sm:space-y-2">
          <Label htmlFor="subscription" className="text-sm">Subscription Tier</Label>
          {isLoading ? (
            <Skeleton className="h-9 w-full" />
          ) : (
            <Input
              id="subscription"
              placeholder="Individual"
              value={formatSubscriptionTier(user?.subscriptionTier)}
              readOnly
              className="bg-muted h-9 cursor-pointer hover:ring-2 hover:ring-primary/40 transition"
              onClick={handleTierClick}
              tabIndex={0}
              aria-label="Change subscription tier"
            />
          )}
        </div>
      </CardContent>
    </Card>
  );
};

export default ProfileSettings;
