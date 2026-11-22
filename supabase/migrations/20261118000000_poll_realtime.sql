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
