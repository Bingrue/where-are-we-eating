-- STEP 0 of 4. Paste into the Supabase SQL Editor and click Run.
--
-- Sets up the table the Supabase CLI uses to remember which migrations have run,
-- and marks the core schema (20261114000000) as applied, because the hosted
-- project already has those tables. Without this, a later `npx supabase db push`
-- would try to run every migration again and fail.
--
-- Safe to run more than once.

create schema if not exists supabase_migrations;

create table if not exists supabase_migrations.schema_migrations (
  version text primary key,
  statements text[],
  name text
);

insert into supabase_migrations.schema_migrations (version, name)
values ('20261114000000', 'core_schema')
on conflict (version) do nothing;
