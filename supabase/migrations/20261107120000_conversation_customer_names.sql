-- The Pi username of the customer in each of a business owner's conversations.
--
-- A business inbox labelled its conversations "Customer 5627fb" (the first characters of the
-- customer's id): owners need to know who messaged them, but the users RLS policy only lets a
-- user read their own row, so the client can't look up anyone else's username.
--
-- get_conversation_customer_names returns the username only, never any other users column (no
-- email, pi_uid or wallet), and only for conversations whose business the caller owns
-- (is_business_owner(auth.uid(), business_id), the same check the conversations RLS uses). The
-- customer of a conversation gets nothing from it unless they also own its business. At most the
-- first 200 ids are looked at.

create or replace function public.get_conversation_customer_names(p_conversation_ids uuid[])
returns table (conversation_id uuid, username text)
language sql
stable
security definer
set search_path = public
as $f$
  select c.id as conversation_id, u.username
  from public.conversations c
  join public.users u on u.id = c.customer_id
  where c.id = any (p_conversation_ids[1:200])
    and public.is_business_owner(auth.uid(), c.business_id)
$f$;

revoke all on function public.get_conversation_customer_names(uuid[]) from public, anon;
grant execute on function public.get_conversation_customer_names(uuid[]) to authenticated;
