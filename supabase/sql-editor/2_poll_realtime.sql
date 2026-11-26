-- STEP 2 of 4. Paste into the Supabase SQL Editor and click Run.
-- Copy of supabase/migrations/20261118000000_poll_realtime.sql, wrapped in a transaction (if anything
-- fails, nothing is changed) and followed by a line that records it as applied.
-- Run step 1 first.

begin;

-- ===== start of supabase/migrations/20261118000000_poll_realtime.sql =====
-- Task 6 only: publish existing tables for RLS-filtered Postgres Changes.
-- No new tables, vote/close functions or changes to Albion's grants/policies.
do $$
declare t text;
begin
  foreach t in array array['polls', 'options', 'votes'] loop
    if not exists (
      select 1 from pg_publication_tables
      where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t
    ) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end;
$$;
-- ===== end of supabase/migrations/20261118000000_poll_realtime.sql =====

insert into supabase_migrations.schema_migrations (version, name)
values ('20261118000000', 'poll_realtime')
on conflict (version) do nothing;

commit;
