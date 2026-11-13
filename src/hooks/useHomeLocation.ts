import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/integrations/supabase/client';
import { useAuth } from '@/context/auth';
import { getSessionUserId } from '@/lib/sessionUserId';

// The prefix: each user's home is cached under it with their id, so switching accounts on one device
// never shows the previous account's home. Invalidating the prefix covers every user
export const HOME_LOCATION_QUERY_KEY = ['home-location'];

export interface HomeLocation {
  /** null when the user skipped, or removed it */
  position: { lat: number; lng: number } | null;
  /** When the user saved or skipped it; null until then (the first-sign-in sheet shows) */
  setAt: string | null;
}

// The signed-in user's home location, from users (RLS: their own row). null when signed out
const fetchHomeLocation = async (): Promise<HomeLocation | null> => {
  // The Supabase ID from the session, never user.uid
  const userId = await getSessionUserId();
  if (!userId) return null;
  const { data, error } = await supabase
    .from('users')
    .select('home_lat, home_lng, home_set_at')
    .eq('id', userId)
    .maybeSingle();
  if (error) throw error;
  // No row, or no home columns in it: unknown, so the sheet doesn't show
  if (!data || data.home_set_at === undefined) return null;
  const hasPosition =
    typeof data.home_lat === 'number' && typeof data.home_lng === 'number';
  return {
    position: hasPosition
      ? { lat: data.home_lat as number, lng: data.home_lng as number }
      : null,
    setAt: data.home_set_at,
  };
};

// Writes the user's own row; an update RLS lets through as a no-op (0 rows) is an error
const writeHomeLocation = async (
  position: { lat: number; lng: number } | null,
) => {
  const userId = await getSessionUserId();
  if (!userId) throw new Error('Please sign in again.');
  const { data, error } = await supabase
    .from('users')
    .update({
      home_lat: position ? position.lat : null,
      home_lng: position ? position.lng : null,
      home_set_at: new Date().toISOString(),
    })
    .eq('id', userId)
    .select('id');
  if (error) throw error;
  if (!data || data.length === 0)
    throw new Error('Your home location could not be saved.');
};

export const useHomeLocation = () => {
  const { isAuthenticated, user } = useAuth();
  const queryClient = useQueryClient();

  const query = useQuery({
    // Only a cache key: the read itself uses the session's user id
    queryKey: [...HOME_LOCATION_QUERY_KEY, user?.uid ?? null],
    queryFn: fetchHomeLocation,
    enabled: isAuthenticated,
    staleTime: 5 * 60 * 1000,
    // A failed read (e.g. the columns aren't there yet) never shows the sheet
    retry: false,
  });

  const mutation = useMutation({
    mutationFn: writeHomeLocation,
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: HOME_LOCATION_QUERY_KEY }),
  });

  return {
    home: query.data ?? null,
    isLoading: query.isLoading,
    isError: query.isError,
    /** Saves the position (null: skip or remove), and sets home_set_at */
    saveHomeLocation: mutation.mutateAsync,
    isSaving: mutation.isPending,
  };
};
