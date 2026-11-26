-- STEP 3 of 4. Paste into the Supabase SQL Editor and click Run.
-- Copy of supabase/migrations/20261119000000_voting_functions_and_indexes.sql, wrapped in a transaction (if anything
-- fails, nothing is changed) and followed by a line that records it as applied.
-- Run step 2 first.

begin;

-- ===== start of supabase/migrations/20261119000000_voting_functions_and_indexes.sql =====
-- Voting and poll closing (task 5).
-- A poll row is the serialization point for both functions. A vote that obtains
-- this lock first commits before closing counts it; a close that obtains it
-- first changes status before any waiting vote can proceed.

create index if not exists votes_poll_option_idx
  on public.votes (poll_id, option_id) include (id);

create or replace function public.cast_vote(p_poll_id uuid, p_option_id uuid)
returns void
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_group_id uuid;
  v_status text;
begin
  if v_user_id is null then
    raise exception 'Sign in to vote.' using errcode = '42501';
  end if;

  select p.group_id, p.status into v_group_id, v_status
  from public.polls p
  where p.id = p_poll_id
  for update;

  if not found then
    raise exception 'Poll not found.' using errcode = 'P0002';
  end if;

  if not exists (
    select 1 from public.group_members m
    where m.group_id = v_group_id and m.user_id = v_user_id
  ) then
    raise exception 'Join this group before voting.' using errcode = '42501';
  end if;

  if v_status <> 'open' then
    raise exception 'Poll is closed.' using errcode = '55000';
  end if;

  if not exists (
    select 1 from public.options o
    where o.id = p_option_id and o.poll_id = p_poll_id
  ) then
    raise exception 'That option does not belong to this poll.' using errcode = '22023';
  end if;

  insert into public.votes (poll_id, option_id, user_id)
  values (p_poll_id, p_option_id, v_user_id)
  on conflict (poll_id, user_id)
  do update set option_id = excluded.option_id, created_at = pg_catalog.now();
end;
$$;

create or replace function public.close_poll(p_poll_id uuid)
returns uuid
language plpgsql
volatile
security definer
set search_path = ''
as $$
declare
  v_user_id uuid := auth.uid();
  v_creator_id uuid;
  v_status text;
  v_winner_id uuid;
begin
  if v_user_id is null then
    raise exception 'Sign in to close this poll.' using errcode = '42501';
  end if;

  select p.created_by, p.status, p.saved_outcome_option_id
    into v_creator_id, v_status, v_winner_id
  from public.polls p
  where p.id = p_poll_id
  for update;

  if not found then
    raise exception 'Poll not found.' using errcode = 'P0002';
  end if;

  if v_creator_id <> v_user_id then
    raise exception 'Only the poll creator can close it.' using errcode = '42501';
  end if;

  -- Retrying a successful close is harmless and returns the persisted outcome.
  if v_status = 'closed' then
    return v_winner_id;
  end if;

  -- Ties are resolved by the oldest suggestion, then by UUID for a stable,
  -- deterministic result. With no votes there is no winner.
  select o.id into v_winner_id
  from public.options o
  left join public.votes v on v.poll_id = o.poll_id and v.option_id = o.id
  where o.poll_id = p_poll_id
  group by o.id, o.created_at
  having pg_catalog.count(v.id) > 0
  order by pg_catalog.count(v.id) desc, o.created_at asc, o.id asc
  limit 1;

  update public.polls
  set status = 'closed', saved_outcome_option_id = v_winner_id
  where id = p_poll_id;

  return v_winner_id;
end;
$$;

create or replace function public.get_vote_totals(p_poll_id uuid)
returns table (option_id uuid, restaurant_name text, vote_count bigint)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if auth.uid() is null then
    raise exception 'Sign in to view vote totals.' using errcode = '42501';
  end if;

  if not exists (
    select 1 from public.polls p
    join public.group_members m on m.group_id = p.group_id
    where p.id = p_poll_id and m.user_id = auth.uid()
  ) then
    raise exception 'Poll not found.' using errcode = '42501';
  end if;

  return query
  select o.id, o.restaurant_name, pg_catalog.count(v.id)
  from public.options o
  left join public.votes v on v.poll_id = o.poll_id and v.option_id = o.id
  where o.poll_id = p_poll_id
  group by o.id, o.restaurant_name, o.created_at
  order by o.created_at, o.id;
end;
$$;

-- All vote writes go through the locking RPC. Keep authenticated reads under RLS.
revoke insert, update, delete on public.votes from authenticated;
grant select on public.votes to authenticated;
revoke all on function public.cast_vote(uuid, uuid), public.close_poll(uuid),
  public.get_vote_totals(uuid) from public, anon;
grant execute on function public.cast_vote(uuid, uuid), public.close_poll(uuid),
  public.get_vote_totals(uuid) to authenticated;
-- ===== end of supabase/migrations/20261119000000_voting_functions_and_indexes.sql =====

insert into supabase_migrations.schema_migrations (version, name)
values ('20261119000000', 'voting_functions_and_indexes')
on conflict (version) do nothing;

commit;
