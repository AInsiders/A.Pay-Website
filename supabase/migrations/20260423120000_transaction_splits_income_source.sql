-- Link split rows and learned rules to income sources (paycheck tagging from bank deposits).
-- Runs after planner_data_model so base tables exist.

alter table public.transaction_splits
  add column if not exists income_source_id text;

alter table public.category_rules
  add column if not exists target_goal_id text;

alter table public.category_rules
  add column if not exists target_housing_bucket_id text;

alter table public.category_rules
  add column if not exists target_income_source_id text;
