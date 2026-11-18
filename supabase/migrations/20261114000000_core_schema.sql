-- Core schema (task 2, Devon). This file records the schema that was created in the
-- hosted Supabase project, so that local Supabase and a clean clone can rebuild it.
-- It was written from a catalog report of the hosted database on Nov 16. The hosted
-- project already has these objects: mark this migration as applied there with
--   npx supabase migration repair --status applied 20261114000000
-- instead of running it again.

create table public.profiles (
  id uuid primary key references auth.users (id) on delete cascade,
  username text unique,
  display_name text,
  created_at timestamptz not null default now()
);

create table public.groups (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.group_members (
  group_id uuid not null references public.groups (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'member' check (role in ('admin', 'member')),
  joined_at timestamptz not null default now(),
  primary key (group_id, user_id)
);

create table public.polls (
  id uuid primary key default gen_random_uuid(),
  group_id uuid not null references public.groups (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete restrict,
  question text not null check (length(trim(question)) > 0),
  status text not null default 'open' check (status in ('open', 'closed')),
  saved_outcome_option_id uuid,
  created_at timestamptz not null default now()
);

create table public.options (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null references public.polls (id) on delete cascade,
  restaurant_name text not null check (length(trim(restaurant_name)) > 0),
  price_range text,
  food_category text,
  created_at timestamptz not null default now(),
  constraint options_poll_id_id_unique unique (poll_id, id)
);

-- The saved outcome must be an option of the same poll.
alter table public.polls
  add constraint polls_saved_outcome_belongs_to_poll_fk
  foreign key (id, saved_outcome_option_id) references public.options (poll_id, id)
  on delete set null (saved_outcome_option_id);

create table public.votes (
  id uuid primary key default gen_random_uuid(),
  poll_id uuid not null,
  option_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  created_at timestamptz not null default now(),
  constraint votes_one_per_user_per_poll unique (poll_id, user_id),
  constraint votes_option_must_belong_to_poll_fk
    foreign key (poll_id, option_id) references public.options (poll_id, id) on delete cascade
);

alter table public.profiles enable row level security;
alter table public.groups enable row level security;
alter table public.group_members enable row level security;
alter table public.polls enable row level security;
alter table public.options enable row level security;
alter table public.votes enable row level security;

-- Create a profile row whenever Supabase Auth creates a user. Sign-up passes
-- username and display_name in options.data, which Auth stores in raw_user_meta_data.
create function public.handle_new_user() returns trigger
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

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();
