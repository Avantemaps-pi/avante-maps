import { useQuery } from '@tanstack/react-query';
import { useLocation } from '@/lib/router-compat';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth';
import { getSessionUserId } from '@/lib/sessionUserId';
import { secureLog } from '@/utils/secureLogger';
import { Business } from '@/types/business';
import {
  OWNED_BUSINESS_COLUMNS,
  isBusinessComplete,
  toOwnedBusiness,
  type OwnedBusinessRow,
} from '@/utils/ownedBusiness';

// Kept apart from ['businesses'] so a save's invalidation of the lists doesn't refetch it:
// a section save writes its new values in here itself
export const ownedBusinessQueryKey = (businessId: number) =>
  ['owned-business', businessId] as const;

export const parseBusinessId = (businessId: string | undefined) =>
  businessId && /^\d+$/.test(businessId) ? Number(businessId) : null;

/**
 * The business being edited, for its owner only (owner_id = the session user, as RLS checks).
 * From Your businesses it starts with the business the list passed, when that has everything
 * the sections save back; a direct load or reload loads it by the route's id.
 */
export const useOwnedBusiness = (businessId: string | undefined) => {
  const location = useLocation();
  const { isLoading: authLoading } = useAuth();
  const routeId = parseBusinessId(businessId);
  const stateBusiness = (location.state as { business?: Business } | null)
    ?.business;
  const seed =
    stateBusiness &&
    routeId !== null &&
    stateBusiness.id === routeId &&
    isBusinessComplete(stateBusiness)
      ? stateBusiness
      : undefined;

  const query = useQuery({
    queryKey: ownedBusinessQueryKey(routeId ?? -1),
    queryFn: async (): Promise<Business> => {
      const sessionUserId = await getSessionUserId();
      if (!sessionUserId)
        throw new Error('Please log in to edit your business.');
      const { data, error } = await supabase
        .from('businesses')
        .select(OWNED_BUSINESS_COLUMNS)
        .eq('id', routeId as number)
        .eq('owner_id', sessionUserId)
        .maybeSingle();
      if (error) {
        secureLog.error('Error loading business to edit', { error });
        throw new Error(
          'Failed to load business information. Please try again.',
        );
      }
      if (!data)
        throw new Error("We couldn't find this business on your account.");
      return toOwnedBusiness(data as OwnedBusinessRow);
    },
    // The session may still be restoring: wait for it rather than say "log in"
    enabled: routeId !== null && (!!seed || !authLoading),
    ...(seed ? { initialData: seed } : {}),
    staleTime: 5 * 60 * 1000,
    retry: false,
    refetchOnWindowFocus: false,
  });

  const error =
    routeId === null
      ? 'No business data found. Please select a business to edit.'
      : query.error
        ? query.error.message
        : null;

  return {
    business: routeId === null ? undefined : query.data,
    isLoading: routeId !== null && !query.data && !query.error,
    error,
    businessId: routeId,
  };
};
