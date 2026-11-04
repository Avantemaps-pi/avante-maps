
import React, { useState, useEffect, useRef } from 'react';
import AppLayout from '@/components/layout/AppLayout';
import BusinessCard from '@/components/business/BusinessCard';
import BusinessSelector from '@/components/business/BusinessSelector';
import EmptyBusinessState from '@/components/business/EmptyBusinessState';
import BusinessHeader from '@/components/business/BusinessHeader';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { useNavigate, useLocation } from '@/lib/router-compat';
import { useAuth } from '@/context/auth';
import { Business } from '@/types/business';
import { supabase } from '@/integrations/supabase/client';
import { Skeleton } from '@/components/ui/skeleton';
import { toast } from 'sonner';
import { useBusinessLimit } from '@/hooks/useBusinessLimit';
import { AlertTriangle } from 'lucide-react';
import { secureLog } from '@/utils/secureLogger';
import { OWNED_BUSINESS_COLUMNS, toOwnedBusiness, type OwnedBusinessRow } from '@/utils/ownedBusiness';

const RegisteredBusiness = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isAuthenticated, login, user, refreshUserData } = useAuth();
  const { currentCount, limit, hasReachedLimit, isApproachingLimit } = useBusinessLimit();
  const [businesses, setBusinesses] = useState<Business[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [selectedBusinessId, setSelectedBusinessId] = useState<string>('all');
  const toastShownRef = useRef(false);
  const hasFetchedRef = useRef(false);
  
  // Get newly registered business ID from navigation state
  const newBusinessId = (location.state as { newBusinessId?: number })?.newBusinessId;

  // Fetch user's businesses from database
  useEffect(() => {
    const fetchUserBusinesses = async () => {
      if (!user?.uid) {
        secureLog.info('No user UID, skipping business fetch');
        setIsLoading(false);
        return;
      }

      // Prevent duplicate fetches
      if (hasFetchedRef.current) {
        secureLog.info('Skipping duplicate fetch');
        return;
      }
      hasFetchedRef.current = true;

      try {
        secureLog.info('Fetching businesses for user', { uid: user.uid });

        // ✅ SECURITY: Get Supabase session and use session.user.id for consistency
        const getSessionUserId = async () => {
          const { data: sessionResp } = await supabase.auth.getSession();
          return sessionResp?.session?.user?.id;
        };

        let sessionUserId = await getSessionUserId();
        secureLog.info('Supabase session user (initial)', { sessionUserId: sessionUserId || 'none' });

        // As a last resort, try a full login once if still missing and online
        if (!sessionUserId && navigator.onLine) {
          try {
            secureLog.info('No session after refresh — attempting login() to restore session');
            await login();
            sessionUserId = await getSessionUserId();
            secureLog.info('Supabase session user (after login)', { sessionUserId: sessionUserId || 'none' });
          } catch (e) {
            secureLog.warn('Login attempt failed', { error: e });
          }
        }

        if (!sessionUserId) {
          secureLog.error('No valid Supabase session found');
          if (!toastShownRef.current) {
            toast.error('Please log in to view your businesses');
            toastShownRef.current = true;
          }
          hasFetchedRef.current = false;
          setIsLoading(false);
          return;
        }

        // Use direct Supabase query with RLS (most secure approach)
        const { data, error } = await supabase
          .from('businesses')
          .select(OWNED_BUSINESS_COLUMNS)
          .eq('owner_id', sessionUserId)
          .eq('is_active', true)
          .order('created_at', { ascending: false });

        if (error) {
          secureLog.error('Error fetching businesses', { error });
          throw error;
        }

        const rows = data ?? [];
        secureLog.info('Businesses fetched', { count: rows.length });

        // ✅ SECURITY: Runtime validation - filter out any businesses not owned by user
        const validRows = rows.filter((b: any) => {
          if (b.owner_id !== sessionUserId) {
            secureLog.error('Security warning: Business owner mismatch detected', {
              businessId: b.id,
              businessOwnerId: b.owner_id,
              sessionUserId
            });
            return false;
          }
          return true;
        });

        if (validRows.length !== rows.length) {
          secureLog.warn('Filtered out invalid businesses', { count: rows.length - validRows.length });
        }

        const transformedBusinesses = (validRows as OwnedBusinessRow[]).map(toOwnedBusiness);

        setBusinesses(transformedBusinesses);

        // Auto-select newly registered business if present in state
        if (newBusinessId && transformedBusinesses.some(b => b.id === newBusinessId)) {
          setSelectedBusinessId(String(newBusinessId));
          toast.success('Your business has been registered successfully!');
          navigate('.', { replace: true, state: {} });
        }
      } catch (error) {
        secureLog.error('Error in fetchUserBusinesses', { error });
        toast.error('Failed to load your businesses');
        hasFetchedRef.current = false;
      } finally {
        setIsLoading(false);
      }
    };

    if (isAuthenticated) {
      fetchUserBusinesses();
    } else {
      secureLog.info('User not authenticated, skipping business fetch');
      hasFetchedRef.current = false;
      setIsLoading(false);
    }
  }, [user?.uid, isAuthenticated]);

  // Filter businesses by selected business ID - default to showing all
  const filteredBusinesses = selectedBusinessId === 'all'
    ? businesses
    : businesses.filter(business => business.id.toString() === selectedBusinessId);

  const handleEditBusiness = (businessId: number) => {
    const business = businesses.find(b => b.id === businessId);
    if (business) {
      navigate(`/update-registration/${businessId}`, { 
        state: { business }
      });
    }
  };

  const handleBusinessDeleted = (businessId: number) => {
    setBusinesses(prev => prev.filter(b => b.id !== businessId));
    if (selectedBusinessId === String(businessId)) {
      setSelectedBusinessId('all');
    }
  };

  // Handle login button click
  const handleLoginClick = () => {
    login();
  };

  if (!isAuthenticated) {
    return (
      <AppLayout title="Avante Maps">
        <div className="max-w-5xl mx-auto py-12 px-4 sm:px-6 lg:px-8">
          <div className="text-center">
            <h2 className="text-4xl font-bold tracking-tight text-foreground">
              Sign In to View Your Businesses
            </h2>
            <p className="mt-6 text-xl text-muted-foreground">
              Please log in to view and manage your registered businesses on Avante Maps.
            </p>
            <div className="mt-8">
              <Button 
                onClick={handleLoginClick}
                className="bg-primary hover:bg-primary/90 text-primary-foreground text-xl py-6 px-12 rounded-md"
                size="lg"
              >
                Login
              </Button>
            </div>
          </div>
        </div>
      </AppLayout>
    );
  }

  // Show loading state
  if (isLoading) {
    return (
      <AppLayout title="Avante Maps">
        <div className="max-w-5xl mx-auto py-6 px-4 sm:px-6 lg:px-8 bg-muted">
          <BusinessHeader 
            title="My Businesses" 
            subtitle="Add and manage your businesses listed on Avante Maps."
            showButton={false}
          />
          <div className="space-y-6 mt-6">
            {[1, 2].map((i) => (
              <div key={i} className="rounded-xl border border-border bg-card p-4 space-y-4 animate-pulse">
                {/* Image skeleton */}
                <Skeleton className="h-44 w-full rounded-lg" />
                {/* Title row */}
                <div className="flex items-center gap-3">
                  <Skeleton className="h-5 w-2/5 rounded" />
                  <Skeleton className="h-4 w-16 rounded-full" />
                </div>
                {/* Address */}
                <Skeleton className="h-4 w-3/5 rounded" />
                {/* Rating + category row */}
                <div className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <Skeleton className="h-4 w-20 rounded" />
                    <Skeleton className="h-6 w-24 rounded-full" />
                  </div>
                  <Skeleton className="h-8 w-24 rounded-md" />
                </div>
              </div>
            ))}
          </div>
        </div>
      </AppLayout>
    );
  }

  return (
    <AppLayout title="Avante Maps">
      <div className="max-w-5xl mx-auto py-6 px-4 sm:px-6 lg:px-8 bg-muted">
        <BusinessHeader 
          title="My Businesses" 
          subtitle="Add and manage your businesses listed on Avante Maps."
          showButton={false}
        />

        {/* Limit indicator */}
        <div className="flex items-center justify-between mt-4 mb-2 text-sm">
          <span className="text-muted-foreground">
            {currentCount} / {limit} businesses used
          </span>
          {hasReachedLimit && (
            <button
              onClick={() => navigate('/pricing')}
              className="text-primary hover:text-brand-navy hover:underline font-medium"
            >
              Upgrade Plan
            </button>
          )}
        </div>

        {/* Approaching limit warning */}
        {isApproachingLimit && (
          <div className="mb-4 flex items-start gap-2 rounded-md border border-input bg-muted p-3 text-sm text-foreground">
            <AlertTriangle className="h-4 w-4 mt-0.5 flex-shrink-0 text-muted-foreground" />
            <span>You're approaching your plan limit. <button onClick={() => navigate('/pricing')} className="underline font-medium">Upgrade</button> to add more businesses.</span>
          </div>
        )}

        <div className="flex flex-col md:flex-row justify-between gap-4 mb-6">
          <div>
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <span className={hasReachedLimit ? 'inline-block cursor-not-allowed' : 'inline-block'}>
                    <Button
                      onClick={() => navigate('/registration')}
                      disabled={hasReachedLimit}
                      className={hasReachedLimit ? 'pointer-events-none' : ''}
                    >
                      Register New Business
                    </Button>
                  </span>
                </TooltipTrigger>
                {hasReachedLimit && (
                  <TooltipContent>
                    <p>Upgrade your plan to register more businesses</p>
                  </TooltipContent>
                )}
              </Tooltip>
            </TooltipProvider>
            
            {businesses.length > 0 && (
              <div className="mt-4">
                <BusinessSelector 
                  businesses={businesses} 
                  selectedBusinessId={selectedBusinessId} 
                  onSelect={setSelectedBusinessId} 
                />
              </div>
            )}
          </div>
        </div>

        {businesses.length === 0 ? (
          <EmptyBusinessState />
        ) : filteredBusinesses.length === 0 ? (
          <div className="p-6 text-center text-muted-foreground bg-card rounded-md shadow-xs">
            <p>Select a business from the dropdown to view its details</p>
          </div>
        ) : (
          <div className="space-y-6">
            {filteredBusinesses.map((business) => (
              <BusinessCard 
                key={business.id} 
                business={business}
                onEdit={() => handleEditBusiness(business.id)}
                onDeleted={() => handleBusinessDeleted(business.id)}
              />
            ))}
          </div>
        )}
      </div>
    </AppLayout>
  );
};

export default RegisteredBusiness;
