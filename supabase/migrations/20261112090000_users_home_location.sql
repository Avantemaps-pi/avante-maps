-- A home location the user sets once (or skips): the map centres on it when GPS isn't used.
-- home_set_at is set by either choice, so the "Set your home location" sheet shows once per
-- account. Skipping sets home_set_at with home_lat / home_lng left null.
--
-- Users update their own row through the existing "Users can update their own profile" policy
-- and the table-level UPDATE grant; protect_user_privileged_columns doesn't touch these columns.

ALTER TABLE public.users
  ADD COLUMN IF NOT EXISTS home_lat double precision,
  ADD COLUMN IF NOT EXISTS home_lng double precision,
  ADD COLUMN IF NOT EXISTS home_set_at timestamptz;

ALTER TABLE public.users DROP CONSTRAINT IF EXISTS users_home_location_check;
ALTER TABLE public.users
  ADD CONSTRAINT users_home_location_check CHECK (
    (home_lat IS NULL AND home_lng IS NULL)
    OR (
      home_lat IS NOT NULL AND home_lng IS NOT NULL
      AND home_lat BETWEEN -90 AND 90
      AND home_lng BETWEEN -180 AND 180
    )
  );

COMMENT ON COLUMN public.users.home_lat IS 'Home location latitude, set by the user (null when not set)';
COMMENT ON COLUMN public.users.home_lng IS 'Home location longitude, set by the user (null when not set)';
COMMENT ON COLUMN public.users.home_set_at IS 'When the user saved or skipped their home location; null until then';
