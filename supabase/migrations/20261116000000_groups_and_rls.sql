-- Groups, invitations and row level security (task 4, Albion).
--
-- Security model
--   * The browser signs in with Supabase Auth and sends its access token to Express.
--     Express forwards that token to Supabase, so every query runs as the `authenticated`
--     role with auth.uid() set to the user. Nothing in the app uses the secret key.
--   * Row level security decides which rows each user can see or change:
--     a user only sees groups they belong to, and the polls, options, votes and
--     profiles of those groups.
--   * `anon` (no sign-in) gets no table privileges at all.
--   * Joining a group requires its invite code and goes through join_group(), because
--     a non-member cannot see the group row and therefore cannot insert themselves.

-- ---------------------------------------------------------------------------
-- Helper functions
-- They live in a schema the Data API does not expose, so they cannot be called
-- over HTTP. They are SECURITY DEFINER so that policies on group_members can ask
-- "is this user a member?" without the policy recursing into itself.
-- ---------------------------------------------------------------------------
create schema if not exists private;
revoke all on schema private from public;
grant usage on schema private to authenticated;

-- Groups the current user belongs to. Used as `group_id in (select private.my_group_ids())`
-- so Postgres evaluates it once per query instead of once per row.
create function private.my_group_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select group_id from public.group_members where user_id = (select auth.uid());
$$;

-- Everyone who shares at least one group with the current user (including themselves).
create function private.my_peer_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select distinct peer.user_id
  from public.group_members me
  join public.group_members peer on peer.group_id = me.group_id
  where me.user_id = (select auth.uid());
$$;

-- Polls in the current user's groups.
create function private.my_poll_ids() returns setof uuid
language sql stable security definer set search_path = '' as $$
  select p.id
  from public.polls p
  join public.group_members m on m.group_id = p.group_id
  where m.user_id = (select auth.uid());
$$;

create function private.is_group_admin(p_group_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group_id and user_id = (select auth.uid()) and role = 'admin'
  );
$$;

-- True when the poll is open and belongs to one of the current user's groups.
create function private.is_open_poll_in_my_group(p_poll_id uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1
    from public.polls p
    join public.group_members m on m.group_id = p.group_id
    where p.id = p_poll_id and p.status = 'open' and m.user_id = (select auth.uid())
  );
$$;

revoke all on all functions in schema private from public, anon;
grant execute on all functions in schema private to authenticated;

-- ---------------------------------------------------------------------------
-- Invite codes and creator membership
-- ---------------------------------------------------------------------------
-- 32 random hex characters (122 random bits), so codes cannot be guessed.
alter table public.groups
  add column invite_code text not null unique
    default replace(gen_random_uuid()::text, '-', '')
    check (invite_code ~ '^[0-9a-f]{32}$');

-- Let Postgres fill in the signed-in user, so clients never send their own id.
alter table public.groups alter column created_by set default auth.uid();
alter table public.polls alter column created_by set default auth.uid();
alter table public.votes alter column user_id set default auth.uid();

-- Whoever creates a group becomes its admin, in the same transaction.
create function private.add_group_creator() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.group_members (group_id, user_id, role)
  values (new.id, new.created_by, 'admin');
  return new;
end;
$$;
revoke all on function private.add_group_creator() from public, anon, authenticated;

create trigger groups_add_creator
  after insert on public.groups
  for each row execute function private.add_group_creator();

-- Join a group with its invite code. Returns the group id. Joining twice is harmless.
create function public.join_group(p_invite_code text) returns uuid
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_user uuid := auth.uid();
  v_group uuid;
begin
  if v_user is null then
    raise exception 'Sign in to join a group.' using errcode = '42501';
  end if;

  select id into v_group
  from public.groups
  where invite_code = lower(trim(p_invite_code));

  if v_group is null then
    raise exception 'That invite link is not valid.' using errcode = 'P0002';
  end if;

  insert into public.group_members (group_id, user_id, role)
  values (v_group, v_user, 'member')
  on conflict (group_id, user_id) do nothing;

  return v_group;
end;
$$;

-- Replace a group's invite code so old links stop working. Admins only.
create function public.rotate_group_invite(p_group_id uuid) returns text
language plpgsql volatile security definer set search_path = '' as $$
declare
  v_code text;
begin
  if not private.is_group_admin(p_group_id) then
    raise exception 'Only a group admin can change the invite link.' using errcode = '42501';
  end if;

  update public.groups
  set invite_code = replace(gen_random_uuid()::text, '-', '')
  where id = p_group_id
  returning invite_code into v_code;

  return v_code;
end;
$$;

revoke all on function public.join_group(text), public.rotate_group_invite(uuid)
  from public, anon;
grant execute on function public.join_group(text), public.rotate_group_invite(uuid)
  to authenticated;

-- ---------------------------------------------------------------------------
-- Table privileges. RLS filters rows; grants decide which commands and columns
-- are possible at all. Both layers must allow an action.
-- ---------------------------------------------------------------------------
revoke all on public.profiles, public.groups, public.group_members,
  public.polls, public.options, public.votes from anon, authenticated;

grant select on public.profiles, public.groups, public.group_members,
  public.polls, public.options, public.votes to authenticated;

grant update (username, display_name) on public.profiles to authenticated;
grant insert (name), update (name), delete on public.groups to authenticated;
grant delete on public.group_members to authenticated;
grant insert (group_id, question), delete on public.polls to authenticated;
grant insert (poll_id, restaurant_name, price_range, food_category) on public.options
  to authenticated;
grant insert (poll_id, option_id), update (option_id), delete on public.votes to authenticated;

-- ---------------------------------------------------------------------------
-- Policies
-- auth.uid() is wrapped in (select ...) so Postgres evaluates it once per query.
-- ---------------------------------------------------------------------------

-- profiles: see yourself and people in your groups; edit only yourself.
-- Rows are created by the sign-up trigger and deleted with the auth user.
create policy "profiles: read self and group peers" on public.profiles
  for select to authenticated
  using (id = (select auth.uid()) or id in (select private.my_peer_ids()));

create policy "profiles: update self" on public.profiles
  for update to authenticated
  using (id = (select auth.uid()))
  with check (id = (select auth.uid()));

-- groups: members can read; anyone signed in can create one as themselves;
-- admins can rename or delete. The creator may also read the row, because
-- INSERT ... RETURNING checks the read policy before the trigger adds the admin row.
create policy "groups: members read" on public.groups
  for select to authenticated
  using (id in (select private.my_group_ids()) or created_by = (select auth.uid()));

create policy "groups: create as self" on public.groups
  for insert to authenticated
  with check (created_by = (select auth.uid()));

create policy "groups: admins update" on public.groups
  for update to authenticated
  using (private.is_group_admin(id))
  with check (private.is_group_admin(id));

create policy "groups: admins delete" on public.groups
  for delete to authenticated
  using (private.is_group_admin(id));

-- group_members: members see the roster. Rows are added only by the creator trigger
-- and join_group(). You can leave a group, and admins can remove members.
create policy "group_members: members read roster" on public.group_members
  for select to authenticated
  using (group_id in (select private.my_group_ids()));

create policy "group_members: leave or admin removes" on public.group_members
  for delete to authenticated
  using (user_id = (select auth.uid()) or private.is_group_admin(group_id));

-- polls: members read and create polls in their groups. The creator or an admin can
-- delete. There is no UPDATE policy: closing a poll goes through the close-poll
-- function (task 5), so status and outcome cannot be edited directly.
create policy "polls: members read" on public.polls
  for select to authenticated
  using (group_id in (select private.my_group_ids()));

create policy "polls: members create" on public.polls
  for insert to authenticated
  with check (
    created_by = (select auth.uid())
    and group_id in (select private.my_group_ids())
  );

create policy "polls: creator or admin deletes" on public.polls
  for delete to authenticated
  using (created_by = (select auth.uid()) or private.is_group_admin(group_id));

-- options: members read; members suggest restaurants while the poll is open.
create policy "options: members read" on public.options
  for select to authenticated
  using (poll_id in (select private.my_poll_ids()));

create policy "options: members suggest while open" on public.options
  for insert to authenticated
  with check (private.is_open_poll_in_my_group(poll_id));

-- votes: members read the votes in their groups' polls (Realtime uses this policy too).
-- You can cast, change or remove only your own vote, and only while the poll is open.
create policy "votes: members read" on public.votes
  for select to authenticated
  using (poll_id in (select private.my_poll_ids()));

create policy "votes: cast own while open" on public.votes
  for insert to authenticated
  with check (user_id = (select auth.uid()) and private.is_open_poll_in_my_group(poll_id));

create policy "votes: change own while open" on public.votes
  for update to authenticated
  using (user_id = (select auth.uid()) and private.is_open_poll_in_my_group(poll_id))
  with check (user_id = (select auth.uid()) and private.is_open_poll_in_my_group(poll_id));

create policy "votes: remove own while open" on public.votes
  for delete to authenticated
  using (user_id = (select auth.uid()) and private.is_open_poll_in_my_group(poll_id));

-- ---------------------------------------------------------------------------
-- Indexes the policies rely on (the primary key covers group_id-first lookups).
-- ---------------------------------------------------------------------------
create index if not exists group_members_user_id_idx on public.group_members (user_id, group_id);
create index if not exists polls_group_id_idx on public.polls (group_id);
