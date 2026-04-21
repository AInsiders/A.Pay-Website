# Bank portal (Supabase + Teller + GitHub Pages)

**First-time setup (secrets + dashboard steps):** see **[SETUP.md](./SETUP.md)** — minimal checklist of what you must paste into Supabase and GitHub.

**Unified system architecture:** see **[ARCHITECTURE.md](./ARCHITECTURE.md)** for how this Supabase/GitHub Pages stack is intended to pair with the canonical planner in `D:/BillPayer/BillPayer/shared/`.

This folder contains a static web app that signs users in with **Supabase Auth**, saves profile/theme data in **Postgres**, connects banks through **Teller Connect**, and lists **accounts and transactions** via **Supabase Edge Functions** (server-side token + optional mTLS).

The intended direction is:

- **planner truth** from `BillPayer/shared/` (`PlannerSnapshot` + `PlannerPlan`)
- **backend/auth/db truth** from this folder’s Supabase setup
- **web rendering** of the same deterministic planner outputs instead of a separate web-only planning engine

## What was added

- `bank-portal/` — Vite + TypeScript single-page app (GitHub Pages–friendly).
- `supabase/migrations/` — `profiles`, `teller_enrollments`, `teller_nonces` with RLS on `profiles` only.
- `supabase/functions/` — `teller-nonce`, `teller-enrollment-complete`, `teller-data`, `teller-webhook`.
- `supabase/migrations/20260421000000_planner_snapshots.sql` + `20260422000000_planner_snapshots_plan_contract.sql` — synced planner input/output state for cross-platform rendering.

## 1. Supabase database

In the Supabase SQL editor (or CLI), run the migration in:

`supabase/migrations/20260416000000_bank_portal.sql`

Enable **Email** auth (or add OAuth later) under Authentication → Providers.

## 2. Edge Functions (secrets)

Deploy functions from this repo root:

```bash
supabase link --project-ref YOUR_REF
supabase db push   # if you use CLI migrations
supabase functions deploy teller-nonce
supabase functions deploy teller-enrollment-complete
supabase functions deploy teller-data
# Teller servers call this URL without a Supabase JWT — disable JWT verification for this function only.
supabase functions deploy teller-webhook --no-verify-jwt
```

JWT verification: the app sends the user’s Supabase access token; each function uses the **anon** key + `Authorization` to resolve the user, then the **service role** for database writes. Keep the service role key **only** in Supabase secrets, never in the browser.

Set these **secrets** in Supabase (Dashboard → Edge Functions → Secrets):

| Secret | Purpose |
| --- | --- |
| `TELLER_TOKEN_SIGNING_PUBLIC_KEY` or `TELLER_TOKEN_SIGNING_PUBLIC_KEYS` | Comma-separated signing keys from the Teller Dashboard (used to verify Connect payloads). |
| `TELLER_CERT_PEM` / `TELLER_KEY_PEM` | Teller client certificate + private key (PEM text). **Required for development/production** API calls; sandbox often works without mTLS, but follow Teller’s guidance. |
| `TELLER_WEBHOOK_SIGNING_SECRET` or `TELLER_WEBHOOK_SIGNING_SECRETS` | Webhook signing secret(s) from Teller (for `teller-webhook`). |

`SUPABASE_URL`, `SUPABASE_ANON_KEY`, and `SUPABASE_SERVICE_ROLE_KEY` are available to Edge Functions automatically in hosted projects.

### Webhook URL

In the Teller Dashboard, point webhooks to:

`https://<project-ref>.supabase.co/functions/v1/teller-webhook`

The sample handler verifies the `Teller-Signature` header and deletes the enrollment row when Teller sends `enrollment.disconnected`.

## 3. Local / CI build (`bank-portal`)

Auth, database, and Edge Functions all live in **Supabase**. The Vite build is a **static** site (HTML/JS only)—serve it from GitHub Pages or any static host; you do **not** need a separate app platform.

Copy `bank-portal/.env.example` to `bank-portal/.env` and fill in:

- `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`
- `VITE_TELLER_APP_ID`
- `VITE_TELLER_ENVIRONMENT` (`sandbox` = fake institutions; `development` or `production` = real banks—must match your Teller app)

```bash
cd bank-portal
npm install
npm run dev
```

## 4. GitHub Pages

Production output is written to the **project root** (same directory as this README): **`index.html`**, **`assets/`**, and **`.nojekyll`**. Source stays under **`bank-portal/`**.

Workflow: `.github/workflows/pages.yml` builds in `bank-portal`, then packages **`index.html`**, **`assets/`**, and **`.nojekyll`** into a **`_site`** artifact for GitHub Pages (the `_site` folder is only for CI and is gitignored).

To publish **without** Actions: run `npm run build` in `bank-portal`, commit the root **`index.html`**, **`assets/`**, and **`.nojekyll`**, then use **Settings → Pages** with **Deploy from a branch** and folder **`/` (root)** — or prefer the workflow so the repo does not need build artifacts committed.

Repository **Settings → Pages**: source = **GitHub Actions**.

Add **GitHub Actions secrets** (same names as the `VITE_*` variables above). Optionally set a repository variable **`VITE_BASE`** to `/your-repo-name/` for a **project site** (`https://user.github.io/repo/`). For a **user/org site** at the domain root, leave `VITE_BASE` unset so it defaults to `/`.

## Security notes

- Only the **anon** key belongs in the frontend. Never put the **service role** key or Teller private material in the static site.
- `teller_enrollments` holds access tokens; it has **no** client policies so PostgREST cannot read it—only Edge Functions using the service role.
- Configure **Auth redirect URLs** in Supabase to include your GitHub Pages origin so email links and OAuth work when you add them later.
