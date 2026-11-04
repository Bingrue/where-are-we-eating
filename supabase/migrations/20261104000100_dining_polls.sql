begin;

create schema app_private;
revoke all on schema app_private from public;
grant usage on schema app_private to authenticated;

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  display_name text not null check (char_length(btrim(display_name)) between 1 and 60),
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(btrim(name)) between 1 and 80),
  created_by uuid not null references public.profiles (id),
  invite_code text not null unique default replace(gen_random_uuid()::text, '-', '')
    check (invite_code ~ '^[0-9a-f]{32}$'),
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups (id),
  user_id uuid not null references public.profiles (id),
  role text not null check (role in ('owner', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);
create unique index group_members_one_owner on public.group_members (group_id)
  where role = 'owner';
create index group_members_by_user on public.group_members (user_id, group_id);

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id),
  question text not null check (char_length(btrim(question)) between 1 and 160),
  created_by uuid not null,
  status text not null default 'open' check (status in ('open', 'closed')),
  revision integer not null default 0 check (revision >= 0),
  created_at timestamptz not null default now(),
  closed_at timestamptz,
  winner_option_id uuid,
  outcome jsonb,
  foreign key (group_id, created_by) references public.group_members (group_id, user_id),
  check (
    (status = 'open' and closed_at is null and winner_option_id is null and outcome is null)
    or (status = 'closed' and closed_at is not null and outcome is not null
        and jsonb_typeof(outcome) = 'object')
  )
);
create index polls_group_created_idx on public.polls (group_id, created_at desc, id);

create table public.options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id),
  name text not null check (char_length(btrim(name)) between 1 and 100),
  category text not null check (char_length(btrim(category)) between 1 and 60),
  price_level smallint not null check (price_level between 1 and 4),
  created_by uuid not null references public.profiles (id),
  created_at timestamptz not null default now(),
  unique (poll_id, id)
);
create unique index options_name_per_poll on public.options (poll_id, lower(btrim(name)));

alter table public.polls add constraint polls_winner_in_same_poll
  foreign key (id, winner_option_id) references public.options (poll_id, id);

create table public.votes (
  poll_id uuid not null references public.polls (id),
  user_id uuid not null references public.profiles (id),
  option_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (poll_id, user_id),
  foreign key (poll_id, option_id) references public.options (poll_id, id)
);
create index votes_poll_option_idx on public.votes (poll_id, option_id);

create function app_private.create_profile() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.profiles (id, display_name)
    values (new.id, coalesce(
      nullif(left(btrim(new.raw_user_meta_data ->> 'display_name'), 60), ''),
      'Diner'
    ));
  return new;
end;
$$;
revoke all on function app_private.create_profile() from public, anon, authenticated;
create trigger eating_auth_profile after insert on auth.users
  for each row execute function app_private.create_profile();

insert into public.profiles (id, display_name)
select id, coalesce(nullif(left(btrim(raw_user_meta_data ->> 'display_name'), 60), ''), 'Diner')
from auth.users;

create function app_private.is_member(p_group uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.group_members
    where group_id = p_group and user_id = (select auth.uid())
  );
$$;
revoke all on function app_private.is_member(uuid) from public, anon, authenticated;
grant execute on function app_private.is_member(uuid) to authenticated;

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.polls enable row level security;
alter table public.options enable row level security;
alter table public.votes enable row level security;

revoke all on public.profiles, public.groups, public.group_members, public.polls,
  public.options, public.votes from public, anon, authenticated;
grant select on public.profiles, public.group_members, public.polls,
  public.options, public.votes to authenticated;
grant select (id, name, created_by, created_at) on public.groups to authenticated;

create policy profile_self on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy groups_member on public.groups for select to authenticated
  using (app_private.is_member(id));
create policy roster_member on public.group_members for select to authenticated
  using (app_private.is_member(group_id));
create policy polls_member on public.polls for select to authenticated
  using (app_private.is_member(group_id));
create policy options_member on public.options for select to authenticated
  using (exists (select 1 from public.polls where polls.id = options.poll_id));
create policy votes_self on public.votes for select to authenticated
  using (user_id = (select auth.uid())
    and exists (select 1 from public.polls where polls.id = votes.poll_id));

create function app_private.actor() returns uuid
language plpgsql stable set search_path = '' as $$
declare
  v_user uuid := auth.uid();
begin
  if v_user is null then
    raise exception using errcode = 'PT401', message = 'Sign in to continue.';
  end if;
  return v_user;
end;
$$;

create function app_private.lock_member_poll(p_poll uuid) returns public.polls
language plpgsql volatile set search_path = '' as $$
declare
  v_poll public.polls;
begin
  select * into v_poll from public.polls
  where id = p_poll and app_private.is_member(group_id)
  for update;
  if not found then
    raise exception using errcode = 'PT404', message = 'Poll not found.';
  end if;
  return v_poll;
end;
$$;

create function app_private.poll_scores(p_poll uuid) returns jsonb
language sql stable set search_path = '' as $$
  select coalesce(jsonb_agg(to_jsonb(scores) order by scores.vote_count desc,
    scores.created_at, scores.id), '[]'::jsonb)
  from (
    select o.id, o.name, o.category, o.price_level, o.created_at,
      coalesce(totals.vote_count, 0) as vote_count
    from public.options o
    left join (
      select option_id, count(*)::integer as vote_count
      from public.votes where poll_id = p_poll group by option_id
    ) totals on totals.option_id = o.id
    where o.poll_id = p_poll
  ) scores;
$$;

revoke all on function app_private.actor(), app_private.lock_member_poll(uuid),
  app_private.poll_scores(uuid) from public, anon, authenticated;

create function public.create_dining_group(p_name text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_id uuid;
begin
  if p_name is null or char_length(btrim(p_name)) not between 1 and 80 then
    raise exception using errcode = 'PT400', message = 'Enter a group name up to 80 characters.';
  end if;
  insert into public.groups (name, created_by)
    values (btrim(p_name), v_user) returning id into v_id;
  insert into public.group_members (group_id, user_id, role) values (v_id, v_user, 'owner');
  return v_id;
end;
$$;

create function public.join_dining_group(p_invite text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_id uuid;
begin
  select id into v_id from public.groups where invite_code = lower(btrim(p_invite));
  if not found then
    raise exception using errcode = 'PT404', message = 'Invitation not found.';
  end if;
  insert into public.group_members (group_id, user_id, role) values (v_id, v_user, 'member')
    on conflict (group_id, user_id) do nothing;
  return v_id;
end;
$$;

create function public.dining_group_invite(p_group uuid) returns text
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_code text;
begin
  select invite_code into v_code from public.groups where id = p_group and created_by = v_user;
  if not found then
    raise exception using errcode = 'PT404', message = 'Invitation not found.';
  end if;
  return v_code;
end;
$$;

create function public.create_dining_poll(p_group uuid, p_question text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_id uuid;
begin
  if not app_private.is_member(p_group) then
    raise exception using errcode = 'PT404', message = 'Group not found.';
  end if;
  if p_question is null or char_length(btrim(p_question)) not between 1 and 160 then
    raise exception using errcode = 'PT400', message = 'Enter a question up to 160 characters.';
  end if;
  insert into public.polls (group_id, question, created_by)
    values (p_group, btrim(p_question), v_user) returning id into v_id;
  return v_id;
end;
$$;

create function public.suggest_restaurant(
  p_poll uuid, p_name text, p_category text, p_price smallint
) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_poll public.polls := app_private.lock_member_poll(p_poll);
  v_id uuid;
begin
  if v_poll.status <> 'open' then
    raise exception using errcode = 'PT409', message = 'This poll is closed.';
  end if;
  if p_name is null or char_length(btrim(p_name)) not between 1 and 100
    or p_category is null or char_length(btrim(p_category)) not between 1 and 60
    or p_price is null or p_price not between 1 and 4 then
    raise exception using errcode = 'PT400', message = 'Enter a restaurant, category and valid price.';
  end if;
  insert into public.options (poll_id, name, category, price_level, created_by)
    values (p_poll, btrim(p_name), btrim(p_category), p_price, v_user)
    on conflict (poll_id, lower(btrim(name))) do nothing returning id into v_id;
  if v_id is null then
    raise exception using errcode = 'PT409', message = 'That restaurant is already on this poll.';
  end if;
  update public.polls set revision = revision + 1 where id = p_poll;
  return v_id;
end;
$$;

create function public.cast_dining_vote(p_poll uuid, p_option uuid) returns uuid
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_poll public.polls := app_private.lock_member_poll(p_poll);
begin
  if v_poll.status <> 'open' then
    raise exception using errcode = 'PT409', message = 'This poll is closed.';
  end if;
  if not exists (select 1 from public.options where poll_id = p_poll and id = p_option) then
    raise exception using errcode = 'PT400', message = 'Choose a restaurant from this poll.';
  end if;
  insert into public.votes (poll_id, user_id, option_id) values (p_poll, v_user, p_option)
    on conflict (poll_id, user_id) do nothing;
  if not found then
    raise exception using errcode = 'PT409', message = 'You have already voted in this poll.';
  end if;
  update public.polls set revision = revision + 1 where id = p_poll;
  return p_option;
end;
$$;

create function public.close_dining_poll(p_poll uuid) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_poll public.polls := app_private.lock_member_poll(p_poll);
  v_scores jsonb;
  v_total integer;
  v_lead integer;
  v_ties integer;
  v_winner uuid;
  v_outcome jsonb;
begin
  if v_poll.created_by <> v_user then
    raise exception using errcode = 'PT403', message = 'Only the poll creator can close this poll.';
  end if;
  if v_poll.status = 'closed' then
    return v_poll.outcome;
  end if;
  v_scores := app_private.poll_scores(p_poll);
  v_lead := coalesce((v_scores -> 0 ->> 'vote_count')::integer, 0);
  select coalesce(sum((score ->> 'vote_count')::integer), 0),
    count(*) filter (where v_lead > 0 and (score ->> 'vote_count')::integer = v_lead)
    into v_total, v_ties
  from jsonb_array_elements(v_scores) as score;
  if v_lead > 0 then
    v_winner := (v_scores -> 0 ->> 'id')::uuid;
  end if;
  v_outcome := jsonb_build_object('options', v_scores, 'total_votes', v_total,
    'tied_leaders', v_ties, 'winner_option_id', v_winner);
  update public.polls set status = 'closed', revision = revision + 1,
    closed_at = clock_timestamp(), winner_option_id = v_winner, outcome = v_outcome
    where id = p_poll;
  return v_outcome;
end;
$$;

create function public.dining_poll_snapshot(p_poll uuid) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_user uuid := app_private.actor();
  v_poll public.polls;
  v_my_option uuid;
begin
  select * into v_poll from public.polls where id = p_poll and app_private.is_member(group_id);
  if not found then
    raise exception using errcode = 'PT404', message = 'Poll not found.';
  end if;
  select option_id into v_my_option from public.votes where poll_id = p_poll and user_id = v_user;
  return jsonb_build_object(
    'poll', to_jsonb(v_poll) - 'outcome',
    'options', case when v_poll.status = 'closed' then v_poll.outcome -> 'options'
                    else app_private.poll_scores(p_poll) end,
    'my_option_id', v_my_option,
    'outcome', v_poll.outcome
  );
end;
$$;

revoke all on function public.create_dining_group(text), public.join_dining_group(text),
  public.dining_group_invite(uuid), public.create_dining_poll(uuid, text),
  public.suggest_restaurant(uuid, text, text, smallint), public.cast_dining_vote(uuid, uuid),
  public.close_dining_poll(uuid), public.dining_poll_snapshot(uuid)
  from public, anon, authenticated;
grant execute on function public.create_dining_group(text), public.join_dining_group(text),
  public.dining_group_invite(uuid), public.create_dining_poll(uuid, text),
  public.suggest_restaurant(uuid, text, text, smallint), public.cast_dining_vote(uuid, uuid),
  public.close_dining_poll(uuid), public.dining_poll_snapshot(uuid) to authenticated;

alter publication supabase_realtime add table public.polls;

commit;
