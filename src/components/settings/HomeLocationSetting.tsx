import React, { useState } from 'react';
import { Home } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import HomeLocationSheet from '@/components/map/HomeLocationSheet';
import { useAuth } from '@/context/auth';
import { useHomeLocation } from '@/hooks/useHomeLocation';

// "Home location" in App Preferences: Set / Not set, opening the same sheet as after sign-in
const HomeLocationSetting = () => {
  const { isAuthenticated } = useAuth();
  const { home, isLoading, isError, saveHomeLocation, isSaving } =
    useHomeLocation();
  const [open, setOpen] = useState(false);

  if (!isAuthenticated || isError) return null;
  const isSet = !!home?.position;

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="space-y-0.5">
        <Label htmlFor="home-location" className="flex items-center gap-2">
          <Home className="h-4 w-4" />
          Home location
        </Label>
        <p className="text-muted-foreground text-sm">
          The map opens here when your device's location isn't used.
        </p>
      </div>
      <Button
        id="home-location"
        type="button"
        variant="outline"
        className="h-11 shrink-0"
        disabled={isLoading}
        onClick={() => setOpen(true)}
        aria-label={`Home location: ${isSet ? 'Set' : 'Not set'}`}
      >
        {isLoading ? '…' : isSet ? 'Set' : 'Not set'}
      </Button>
      <HomeLocationSheet
        open={open}
        onOpenChange={setOpen}
        variant="settings"
        home={home}
        onSave={async (position) => {
          await saveHomeLocation(position);
        }}
        isSaving={isSaving}
      />
    </div>
  );
};

export default HomeLocationSetting;
