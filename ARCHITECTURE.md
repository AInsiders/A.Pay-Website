# A.Pay unified architecture

This repository is being converged toward **one deterministic planner**, **one Supabase backend**, and **one GitHub Pages web client**.

## Canonical responsibilities

### `D:/BillPayer/BillPayer`
Owns the **deterministic financial engine** and the current native app experience.

- `shared/src/main/kotlin/.../domain/model`
  - canonical domain objects: `PlannerSnapshot`, `PlannerPlan`, `DashboardOverview`, timeline/allocation types
- `shared/src/main/kotlin/.../domain/engine`
  - canonical planner logic: `CashflowPlanner`, `PlannerEngine`
- `app/src/main/java/...`
  - current Android storage + UI shell + repository/view model wiring

This is the **source of truth for planning math**.

### `D:/BillPayer/A.Pay-Website`
Owns the **Supabase + GitHub Pages** web stack.

- `bank-portal/`
  - static web client
  - auth UX
  - dashboard shell
  - GitHub Pages build output
- `supabase/migrations/`
  - canonical web/backend schema
- `supabase/functions/`
  - Teller / backend service integration

This is the **source of truth for web hosting, auth, secrets setup, and backend connectivity**.

## System principle

**Do not reimplement the planner in TypeScript unless absolutely necessary.**

Near-term, the best architecture is:

1. **BillPayer shared engine computes plan**
   - input: `PlannerSnapshot`
   - output: `PlannerPlan`
2. **Supabase stores synced planner state**
   - `planner_snapshots.snapshot` = canonical serialized `PlannerSnapshot`
   - `planner_snapshots.plan` = canonical serialized `PlannerPlan`
3. **A.Pay-Website renders that same plan**
   - Home / Planner / Bills / Accounts / Settings
   - powered by Supabase Auth + Postgres + Edge Functions

This gives:

- one planner
- one backend
- one login system
- one database
- minimal duplication

## Contract

The shared cross-platform contract is:

- `PlannerSnapshot` = all planning inputs / actuals / settings
- `PlannerPlan` = all deterministic outputs the UI should render

These structures originate in `BillPayer/shared/`.

The web app should **render** them, not reinterpret them with separate ad hoc math.

## Web route mapping

The web app should mirror the native app’s top-level structure:

- `home`
- `planner`
- `bills`
- `accounts`
- `settings`

Public marketing / legal pages can still exist, but the signed-in shell should speak the same language as the planner app.

## Backend strategy

Supabase remains the central backend for:

- Postgres
- Auth
- Storage
- Edge Functions
- Teller integration

If planner computation later needs to move off-device, expose it through **one backend contract** and keep the Kotlin planner canonical unless a full, tested migration path is ready.

## What to avoid

- duplicate planner math in multiple languages without contract tests
- multiple independent web app copies with drift
- UI-only money logic that diverges from the planner engine
- platform-specific features leaking into shared financial rules

## Current direction

This repo is now moving toward:

- **`BillPayer/shared`** = canonical planner/domain
- **`A.Pay-Website`** = canonical Supabase web/backend layer
- **`A.pay`** = legacy/duplicate web copy to phase out or archive once parity is moved
