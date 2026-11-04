-- Run with psql against a disposable Supabase database. All changes roll back.
\set ON_ERROR_STOP on
\if :{?group_count}
\else
\set group_count 100
\endif
\if :{?polls_per_group}
\else
\set polls_per_group 100
\endif
\if :{?voter_count}
\else
\set voter_count 400
\endif

begin;

create temporary table bench_users as
select n, gen_random_uuid() as id from generate_series(1, :voter_count) n;
insert into auth.users (id, raw_user_meta_data)
select id, '{"display_name":"Benchmark diner"}'::jsonb from bench_users;

create temporary table bench_groups as
select n, gen_random_uuid() as id from generate_series(1, :group_count) n;
insert into public.groups (id, name, created_by)
select g.id, 'Benchmark group ' || g.n, u.id from bench_groups g cross join bench_users u where u.n = 1;
insert into public.group_members (group_id, user_id, role)
select g.id, u.id, case when u.n = 1 then 'owner' else 'member' end
from bench_groups g cross join bench_users u;

create temporary table bench_polls as
select g.id as group_id, g.n as group_n, poll_number.n, gen_random_uuid() as id
from bench_groups g cross join generate_series(1, :polls_per_group) as poll_number(n);
insert into public.polls (id, group_id, question, created_by, created_at)
select p.id, p.group_id, 'Dinner poll ' || p.n, u.id, now() - make_interval(mins => p.n)
from bench_polls p cross join bench_users u where u.n = 1;

create temporary table bench_options as
select p.id as poll_id, p.group_n, restaurant_number.n, gen_random_uuid() as id
from bench_polls p cross join generate_series(1, 4) as restaurant_number(n);
insert into public.options (id, poll_id, name, category, price_level, created_by)
select o.id, o.poll_id, 'Restaurant ' || o.n, 'Bistro', o.n, u.id
from bench_options o cross join bench_users u where u.n = 1;
insert into public.votes (poll_id, option_id, user_id)
select o.poll_id, o.id, u.id from bench_options o cross join bench_users u
where o.n = 1 + (u.n % 4) and (o.group_n = 1 or u.n <= least(20, :voter_count));

select id as sample_group from bench_groups where n = 1 \gset
select id as sample_poll from bench_polls where group_n = 1 and n = 1 \gset
select (select count(*) from bench_groups) as groups,
       (select count(*) from bench_polls) as polls,
       (select count(*) from public.votes) as votes_in_database;

drop index public.polls_group_created_idx;
drop index public.votes_poll_option_idx;
analyze public.polls;
analyze public.votes;
analyze public.options;

\echo === Baseline warm-up ===
\ir workload.sql
\echo === Baseline measured ===
\ir workload.sql

create index polls_group_created_idx on public.polls (group_id, created_at desc, id);
create index votes_poll_option_idx on public.votes (poll_id, option_id);
analyze public.polls;
analyze public.votes;
analyze public.options;

\echo === Indexed warm-up ===
\ir workload.sql
\echo === Indexed measured ===
\ir workload.sql

rollback;
