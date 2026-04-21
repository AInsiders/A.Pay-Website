-- Keep only the latest synced planner state per user so mobile/web can upsert
-- a single canonical row instead of appending unbounded history.

with ranked as (
  select
    id,
    row_number() over (
      partition by user_id
      order by updated_at desc nulls last, id desc
    ) as rn
  from public.planner_snapshots
)
delete from public.planner_snapshots
where id in (
  select id
  from ranked
  where rn > 1
);

create unique index if not exists planner_snapshots_user_id_uidx
  on public.planner_snapshots (user_id);
