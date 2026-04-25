-- Required for two-device live sync. Client subscriptions listen to these rows,
-- so the tables must be part of Supabase Realtime's publication.

do $$
begin
  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'profiles'
  ) then
    alter publication supabase_realtime add table public.profiles;
  end if;

  if not exists (
    select 1
    from pg_publication_tables
    where pubname = 'supabase_realtime'
      and schemaname = 'public'
      and tablename = 'planner_snapshots'
  ) then
    alter publication supabase_realtime add table public.planner_snapshots;
  end if;
end $$;
