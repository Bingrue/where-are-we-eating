-- Make sure every Supabase Auth user has a profile.
--
-- groups.created_by, polls.created_by, group_members.user_id and votes.user_id all
-- reference public.profiles. A user without a profile row can sign in but cannot
-- create or join a group: the insert fails its foreign key. That happens to accounts
-- created before the on_auth_user_created trigger existed, and to every account if a
-- project never got the trigger (the core schema migration is marked as applied on the
-- hosted project instead of being run there).
--
-- This migration is safe to run more than once.

-- 1. Re-assert the sign-up trigger, so the hosted project matches the repository.
create or replace function public.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, username, display_name)
  values (
    new.id,
    nullif(new.raw_user_meta_data ->> 'username', ''),
    coalesce(
      nullif(new.raw_user_meta_data ->> 'display_name', ''),
      nullif(new.raw_user_meta_data ->> 'full_name', ''),
      nullif(new.raw_user_meta_data ->> 'name', '')
    )
  )
  on conflict (id) do nothing;
  return new;
end;
$$;

do $$
begin
  if not exists (
    select 1 from pg_trigger
    where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass
  ) then
    create trigger on_auth_user_created
      after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end;
$$;

-- 2. Create the missing profiles. A username is copied only if nobody has it yet
--    (usernames are unique); otherwise it is left empty and the user can pick one.
with missing as (
  select
    u.id,
    nullif(u.raw_user_meta_data ->> 'username', '') as username,
    coalesce(
      nullif(u.raw_user_meta_data ->> 'display_name', ''),
      nullif(u.raw_user_meta_data ->> 'full_name', ''),
      nullif(u.raw_user_meta_data ->> 'name', '')
    ) as display_name,
    row_number() over (
      partition by nullif(u.raw_user_meta_data ->> 'username', '')
      order by u.created_at, u.id
    ) as username_rank
  from auth.users u
  where not exists (select 1 from public.profiles p where p.id = u.id)
)
insert into public.profiles (id, username, display_name)
select
  m.id,
  case
    when m.username_rank = 1
      and not exists (select 1 from public.profiles p where p.username = m.username)
    then m.username
  end,
  m.display_name
from missing m
on conflict (id) do nothing;
