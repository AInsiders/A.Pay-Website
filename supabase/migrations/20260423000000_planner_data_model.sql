-- Phase 1: Full planner data model.
-- Adds normalized per-user tables mirroring the BillPayer shared domain.
-- Bank-owned data (accounts, transactions) is synced-only (Teller).
-- User-owned data (bills, debts, expenses, income, goals, categories) supports manual CRUD.
--
-- Design notes:
-- * Uses `user_id uuid references auth.users` on every row with strict RLS.
-- * Uses JSONB for shape-fluid nested structures (recurring rules, amount ranges, audits).
--   This keeps the schema aligned with the Kotlin shared models without flattening every
--   inner data class; the Edge recompute path reads and writes these JSON shapes directly.
-- * Uses text IDs for domain entity IDs (bills, debts, etc.) so Android can pre-generate
--   IDs client-side and the web can round-trip them through upsert.

-- ============================================================
-- Shared helpers
-- ============================================================

create or replace function public.set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

-- ============================================================
-- User categories + custom labels
-- ============================================================

create table if not exists public.user_categories (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  kind text not null default 'GENERAL',
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.user_categories enable row level security;

create table if not exists public.custom_labels (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.custom_labels enable row level security;

-- ============================================================
-- Bank accounts (synced only)
-- ============================================================

create table if not exists public.bank_accounts (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  teller_enrollment_id text,
  teller_linked_account_id text,
  institution_name text,
  name text not null default '',
  type text not null default 'Checking',
  subtype text,
  mask text,
  currency text not null default 'USD',
  current_balance numeric(18,2) not null default 0,
  available_balance numeric(18,2) not null default 0,
  include_in_planning boolean not null default true,
  protected_from_payoff boolean not null default false,
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists bank_accounts_user_idx on public.bank_accounts (user_id);
create unique index if not exists bank_accounts_user_linked_uidx
  on public.bank_accounts (user_id, teller_linked_account_id)
  where teller_linked_account_id is not null;

alter table public.bank_accounts enable row level security;

-- ============================================================
-- Bank transactions (raw synced)
-- ============================================================

create table if not exists public.bank_transactions (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  bank_account_id text not null,
  provider_transaction_id text,
  description text not null default '',
  merchant text,
  amount numeric(18,2) not null,
  posted_date date,
  authorized_date date,
  running_balance numeric(18,2),
  status text default 'POSTED',
  raw_payload jsonb not null default '{}'::jsonb,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, bank_account_id)
    references public.bank_accounts (user_id, id)
    on delete cascade
);

create index if not exists bank_transactions_user_account_idx
  on public.bank_transactions (user_id, bank_account_id, posted_date desc);
create unique index if not exists bank_transactions_user_provider_uidx
  on public.bank_transactions (user_id, provider_transaction_id)
  where provider_transaction_id is not null;

alter table public.bank_transactions enable row level security;

-- ============================================================
-- Transaction categorization rules (auto-categorization pipeline)
-- ============================================================

create table if not exists public.category_rules (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null,
  -- matcher_type: MERCHANT_CONTAINS | DESCRIPTION_CONTAINS | AMOUNT_EQUALS | RECURRING
  matcher_type text not null default 'MERCHANT_CONTAINS',
  matcher_value text not null,
  target_kind text not null default 'CATEGORY',
  target_category_id text,
  target_bill_id text,
  target_debt_id text,
  target_expense_id text,
  target_custom_label text,
  is_enabled boolean not null default true,
  priority int not null default 100,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists category_rules_user_priority_idx
  on public.category_rules (user_id, is_enabled, priority);

alter table public.category_rules enable row level security;

-- ============================================================
-- Transaction categorization (applied per transaction, auto or manual)
-- ============================================================

create table if not exists public.transaction_categorizations (
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id text not null,
  category_kind text not null default 'CATEGORY',
  user_category_id text,
  custom_label_id text,
  bill_id text,
  debt_id text,
  expense_id text,
  goal_id text,
  housing_bucket_id text,
  income_source_id text,
  note text default '',
  is_user_override boolean not null default false,
  source_rule_id text,
  confidence numeric(5,4),
  categorized_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, transaction_id),
  foreign key (user_id, transaction_id)
    references public.bank_transactions (user_id, id)
    on delete cascade
);

alter table public.transaction_categorizations enable row level security;

-- ============================================================
-- Transaction splits (one tx split into multiple categorized parts)
-- ============================================================

create table if not exists public.transaction_splits (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  transaction_id text not null,
  position int not null default 0,
  amount numeric(18,2) not null,
  category_kind text not null default 'CATEGORY',
  user_category_id text,
  custom_label_id text,
  bill_id text,
  debt_id text,
  expense_id text,
  goal_id text,
  housing_bucket_id text,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, transaction_id)
    references public.bank_transactions (user_id, id)
    on delete cascade
);

create index if not exists transaction_splits_user_tx_idx
  on public.transaction_splits (user_id, transaction_id, position);

alter table public.transaction_splits enable row level security;

-- ============================================================
-- Income sources
-- ============================================================

create table if not exists public.income_sources (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  payer_label text default '',
  recurring_rule jsonb not null default '{}'::jsonb,
  amount_range jsonb not null default '{}'::jsonb,
  forecast_amount_mode text not null default 'FIXED',
  input_mode text not null default 'USABLE',
  next_expected_pay_date date,
  expected_date_hints jsonb not null default '[]'::jsonb,
  is_manual_only boolean not null default false,
  is_active boolean not null default true,
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  deduction_rule_ids jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.income_sources enable row level security;

-- ============================================================
-- Paychecks (actual income events)
-- ============================================================

create table if not exists public.paychecks (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  income_source_id text,
  payer_label text default '',
  date date not null,
  amount numeric(18,2) not null default 0,
  amount_mode text not null default 'USABLE',
  deposited boolean not null default false,
  account_id text,
  notes text default '',
  custom_fields jsonb not null default '[]'::jsonb,
  optional_deduction_rule_ids jsonb not null default '[]'::jsonb,
  entered_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists paychecks_user_date_idx
  on public.paychecks (user_id, date desc);

alter table public.paychecks enable row level security;

create table if not exists public.paycheck_actions (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  paycheck_id text not null,
  account_id text,
  type text not null default 'BILL_GROUP',
  source_id text,
  label text not null default '',
  amount numeric(18,2) not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, paycheck_id)
    references public.paychecks (user_id, id)
    on delete cascade
);

create index if not exists paycheck_actions_user_paycheck_idx
  on public.paycheck_actions (user_id, paycheck_id);

alter table public.paycheck_actions enable row level security;

-- ============================================================
-- Bills
-- ============================================================

create table if not exists public.bills (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  amount_due numeric(18,2) not null default 0,
  total_balance numeric(18,2),
  recurring_rule jsonb not null default '{}'::jsonb,
  grace_days int,
  minimum_due numeric(18,2) not null default 0,
  current_amount_due numeric(18,2) not null default 0,
  status text not null default 'UPCOMING',
  category text default '',
  is_essential boolean not null default false,
  auto_pay boolean not null default false,
  is_variable boolean not null default false,
  expected_range jsonb,
  cadence_mode text not null default 'RECURRING_RULE',
  manual_due_dates jsonb not null default '[]'::jsonb,
  payment_policy text not null default 'HARD_DUE',
  partial_payment_allowed boolean not null default true,
  minimum_payment_allowed boolean not null default true,
  early_payment_allowed boolean not null default true,
  end_of_month_allowed boolean not null default false,
  late_trigger_days int not null default 0,
  paid_through_month int,
  paid_through_year int,
  period_tracking_override text not null default 'CATEGORY_DEFAULT',
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.bills enable row level security;

create table if not exists public.bill_payments (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  bill_id text not null,
  amount numeric(18,2) not null default 0,
  payment_date date not null,
  paycheck_id text,
  source_label text,
  note text default '',
  applied_due_date date,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, bill_id)
    references public.bills (user_id, id)
    on delete cascade
);

create index if not exists bill_payments_user_bill_idx
  on public.bill_payments (user_id, bill_id, payment_date desc);

alter table public.bill_payments enable row level security;

-- ============================================================
-- Debts
-- ============================================================

create table if not exists public.debts (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  lender text default '',
  type text not null default 'INSTALLMENT',
  current_balance numeric(18,2) not null default 0,
  available_credit numeric(18,2) not null default 0,
  minimum_due numeric(18,2) not null default 0,
  required_due_date date,
  interest_rate numeric(9,4),
  fees numeric(18,2),
  arrears_amount numeric(18,2) not null default 0,
  status text not null default 'CURRENT',
  payoff_priority int not null default 1,
  snowball_order int not null default 1,
  avalanche_order int not null default 1,
  custom_order int not null default 1,
  reborrow_allowed boolean not null default false,
  max_safe_reborrow_amount numeric(18,2) not null default 0,
  repayment_term_days int not null default 14,
  borrow_available_restores boolean not null default true,
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  reborrow_rule_config jsonb not null default '{}'::jsonb,
  installments jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.debts enable row level security;

create table if not exists public.revolving_debt_settings (
  debt_id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  total_limit numeric(18,2),
  available_to_borrow_now numeric(18,2) not null default 0,
  required_due_amount numeric(18,2) not null default 0,
  due_dates jsonb not null default '[]'::jsonb,
  reborrow_allowed boolean not null default false,
  max_safe_reborrow_amount numeric(18,2) not null default 0,
  reborrow_rule_config jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, debt_id),
  foreign key (user_id, debt_id)
    references public.debts (user_id, id)
    on delete cascade
);

alter table public.revolving_debt_settings enable row level security;

create table if not exists public.debt_transactions (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  debt_id text not null,
  type text not null default 'PAYMENT',
  amount numeric(18,2) not null default 0,
  event_date date not null,
  paycheck_id text,
  fee_amount numeric(18,2) not null default 0,
  source_label text,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, debt_id)
    references public.debts (user_id, id)
    on delete cascade
);

create index if not exists debt_transactions_user_debt_idx
  on public.debt_transactions (user_id, debt_id, event_date desc);

alter table public.debt_transactions enable row level security;

-- ============================================================
-- Recurring expenses + spends
-- ============================================================

create table if not exists public.recurring_expenses (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  category_id text,
  category_label text default '',
  amount numeric(18,2) not null default 0,
  recurring_rule jsonb not null default '{}'::jsonb,
  is_essential boolean not null default true,
  is_variable boolean not null default false,
  expected_range jsonb,
  allocation_mode text not null default 'EVENLY',
  one_time_date date,
  is_paid boolean not null default false,
  is_locked boolean not null default false,
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.recurring_expenses enable row level security;

create table if not exists public.expense_spends (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  expense_id text not null,
  amount numeric(18,2) not null default 0,
  spend_date date not null,
  paycheck_id text,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, expense_id)
    references public.recurring_expenses (user_id, id)
    on delete cascade
);

create index if not exists expense_spends_user_expense_idx
  on public.expense_spends (user_id, expense_id, spend_date desc);

alter table public.expense_spends enable row level security;

-- ============================================================
-- Housing
-- ============================================================

create table if not exists public.housing_config (
  user_id uuid not null references auth.users (id) on delete cascade,
  id text not null default 'housing',
  current_monthly_rent numeric(18,2) not null default 0,
  minimum_acceptable_payment numeric(18,2) not null default 0,
  rent_due_day int not null default 1,
  arrangement text not null default 'RENT_MONTH_TO_MONTH',
  allocation_order text not null default 'OLDEST_ARREARS_FIRST',
  allow_future_prepay boolean not null default false,
  paid_through_month int,
  paid_through_year int,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.housing_config enable row level security;

create table if not exists public.housing_buckets (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  label text not null default '',
  month_key text not null,
  amount_due numeric(18,2) not null default 0,
  amount_paid numeric(18,2) not null default 0,
  due_date date,
  is_current_bucket boolean not null default false,
  notes text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists housing_buckets_user_month_idx
  on public.housing_buckets (user_id, month_key);

alter table public.housing_buckets enable row level security;

create table if not exists public.housing_payments (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  bucket_id text not null,
  amount numeric(18,2) not null default 0,
  payment_date date not null,
  paycheck_id text,
  label text default '',
  note text default '',
  applied_period_month int,
  applied_period_year int,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id),
  foreign key (user_id, bucket_id)
    references public.housing_buckets (user_id, id)
    on delete cascade
);

alter table public.housing_payments enable row level security;

-- ============================================================
-- Goals
-- ============================================================

create table if not exists public.goals (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  target_amount numeric(18,2) not null default 0,
  current_amount numeric(18,2) not null default 0,
  notes text default '',
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.goals enable row level security;

-- ============================================================
-- Deduction rules
-- ============================================================

create table if not exists public.deduction_rules (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  name text not null default '',
  scope text not null default 'GLOBAL',
  income_source_id text,
  value_type text not null default 'PERCENTAGE',
  fixed_amount numeric(18,2) not null default 0,
  percentage numeric(9,4) not null default 0,
  status text not null default 'MANDATORY',
  is_enabled_by_default boolean not null default true,
  notes text default '',
  tags jsonb not null default '[]'::jsonb,
  custom_fields jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

alter table public.deduction_rules enable row level security;

-- ============================================================
-- Cash adjustments
-- ============================================================

create table if not exists public.cash_adjustments (
  id text not null,
  user_id uuid not null references auth.users (id) on delete cascade,
  account_id text,
  type text not null default 'CASH_IN',
  amount numeric(18,2) not null default 0,
  adjustment_date date not null,
  note text default '',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (user_id, id)
);

create index if not exists cash_adjustments_user_date_idx
  on public.cash_adjustments (user_id, adjustment_date desc);

alter table public.cash_adjustments enable row level security;

-- ============================================================
-- Planner settings (per user)
-- ============================================================

create table if not exists public.planner_settings (
  user_id uuid not null references auth.users (id) on delete cascade primary key,
  settings jsonb not null default '{}'::jsonb,
  notification_settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.planner_settings enable row level security;

-- ============================================================
-- RLS policies + updated_at triggers for all user-owned tables.
-- Generated dynamically to avoid per-table boilerplate.
-- ============================================================

do $$
declare
  target_table text;
  pol record;
  target_tables text[] := array[
    'user_categories',
    'custom_labels',
    'bank_accounts',
    'bank_transactions',
    'category_rules',
    'transaction_categorizations',
    'transaction_splits',
    'income_sources',
    'paychecks',
    'paycheck_actions',
    'bills',
    'bill_payments',
    'debts',
    'revolving_debt_settings',
    'debt_transactions',
    'recurring_expenses',
    'expense_spends',
    'housing_config',
    'housing_buckets',
    'housing_payments',
    'goals',
    'deduction_rules',
    'cash_adjustments',
    'planner_settings'
  ];
  policy_suffixes text[] := array['select_own', 'insert_own', 'update_own', 'delete_own'];
  suffix text;
  policy_name text;
  policy_sql text;
begin
  foreach target_table in array target_tables loop
    foreach suffix in array policy_suffixes loop
      policy_name := target_table || '_' || suffix;

      if exists (
        select 1 from pg_policies
        where schemaname = 'public'
          and tablename = target_table
          and policyname = policy_name
      ) then
        continue;
      end if;

      if suffix = 'select_own' then
        policy_sql := format(
          'create policy %I on public.%I for select to authenticated using (auth.uid() = user_id)',
          policy_name, target_table
        );
      elsif suffix = 'insert_own' then
        policy_sql := format(
          'create policy %I on public.%I for insert to authenticated with check (auth.uid() = user_id)',
          policy_name, target_table
        );
      elsif suffix = 'update_own' then
        policy_sql := format(
          'create policy %I on public.%I for update to authenticated using (auth.uid() = user_id) with check (auth.uid() = user_id)',
          policy_name, target_table
        );
      else
        policy_sql := format(
          'create policy %I on public.%I for delete to authenticated using (auth.uid() = user_id)',
          policy_name, target_table
        );
      end if;

      execute policy_sql;
    end loop;

    execute format(
      'drop trigger if exists set_%I_updated_at on public.%I',
      target_table, target_table
    );
    execute format(
      'create trigger set_%I_updated_at before update on public.%I for each row execute function public.set_updated_at()',
      target_table, target_table
    );
  end loop;
end$$;
