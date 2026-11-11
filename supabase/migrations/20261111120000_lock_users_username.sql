-- users.username is what the payer check (#173) compares with Pi's /v2/me username, so a user
-- must not be able to change their own. It is set by verify-pi-auth (service role) when an account
-- is created, from the username Pi verified.
--
-- Same function as 20260824231800, plus the username check, raised like pi_uid's. The exemption
-- is unchanged: the elevated roles (including service_role and a SECURITY DEFINER function owned
-- by postgres) may still change any of these columns.
--
-- Existing rows are left as they are: no rows changed, merged or deduplicated, and no unique
-- constraint (one person can have an account per Pi app, with the same username).

CREATE OR REPLACE FUNCTION public.protect_user_privileged_columns()
RETURNS trigger
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public
AS $$
DECLARE
  v_elevated boolean;
BEGIN
  v_elevated := current_user IN ('postgres', 'supabase_admin', 'service_role', 'supabase_auth_admin')
                OR coalesce(current_setting('request.jwt.claim.role', true), '') = 'service_role';

  IF v_elevated THEN
    RETURN NEW;
  END IF;

  IF NEW.subscription IS DISTINCT FROM OLD.subscription THEN
    RAISE EXCEPTION 'subscription cannot be changed directly; it is set by the server after payment validation';
  END IF;

  IF NEW.pi_uid IS DISTINCT FROM OLD.pi_uid THEN
    RAISE EXCEPTION 'pi_uid cannot be changed directly';
  END IF;

  IF NEW.username IS DISTINCT FROM OLD.username THEN
    RAISE EXCEPTION 'username cannot be changed directly; it comes from Pi Network';
  END IF;

  RETURN NEW;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.protect_user_privileged_columns() FROM PUBLIC;
