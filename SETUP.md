# A.Pay — one-time setup (Supabase + GitHub Pages)

The codebase already includes **migrations**, **Edge Functions**, and a **GitHub Actions** workflow. This file lists **only what you must supply** (secrets and a few dashboard clicks). No Vercel or other app host is required.

---

## Minimal: what only you can provide

I (or any developer) **cannot** log into your Supabase or GitHub account. You need to paste these yourself.

### 1. Supabase API keys (required for sign-in and the app)

| Secret / value | Where |
|----------------|--------|
| **Project URL** | Supabase → **Project Settings** → **API** → Project URL |
| **anon public key** | Same page → **anon** / “public” key (starts with `eyJ…`) |

**Never** put the **service_role** key in the frontend, GitHub build env, or chat.

**Where to put them**

- **Local:** `bank-portal/.env` (copy from `bank-portal/.env.example`).
- **GitHub Pages build:** Repository → **Settings** → **Secrets and variables** → **Actions** → add repository secrets:
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`

Optional **Variables** (not secrets):

- `VITE_BASE` — only if the site is a **project** GitHub Page (URL like `https://YOUR_USER.github.io/YOUR_REPO/`). Set to `/YOUR_REPO/` (with slashes). For a **custom domain at the root**, leave unset.

### 2. Supabase Auth URLs (required for magic link / reset / email confirm)

In Supabase → **Authentication** → **URL Configuration**:

- **Site URL:** your real site (e.g. `https://you.github.io/repo/` or production domain).
- **Redirect URLs:** add at least:
  - `http://localhost:5173/**` (local dev)
  - `https://you.github.io/repo/**` (match your Pages URL)

### 3. Database migrations (run once per project)

Either:

- **SQL Editor:** run the files in `supabase/migrations/` in order (`20260416000000` then `20260417000000`), or  
- **CLI:** `supabase link` then `supabase db push` (requires [Supabase CLI](https://supabase.com/docs/guides/cli)).

### 4. Edge Functions + Teller (only when you want bank linking)

Deploy from repo root (after `supabase link`):

```bash
supabase functions deploy teller-nonce
supabase functions deploy teller-enrollment-complete
supabase functions deploy teller-data
supabase functions deploy teller-webhook --no-verify-jwt
```

In Supabase → **Edge Functions** → **Secrets**, set at least:

| Secret | Purpose |
|--------|---------|
| `TELLER_TOKEN_SIGNING_PUBLIC_KEY` or `TELLER_TOKEN_SIGNING_PUBLIC_KEYS` | Teller Dashboard — verify Connect payloads |
| `TELLER_CERT_PEM` / `TELLER_KEY_PEM` | Often required for **development/production** Teller API (not always for sandbox) |
| `TELLER_WEBHOOK_SIGNING_SECRET` or `TELLER_WEBHOOK_SIGNING_SECRETS` | Teller webhooks only |

Also add GitHub **Actions secrets** for the **static build** (same names as local):

- `VITE_TELLER_APP_ID`
- `VITE_TELLER_ENVIRONMENT` (e.g. `sandbox`)

Point Teller webhooks to:  
`https://YOUR_PROJECT_REF.supabase.co/functions/v1/teller-webhook`

---

## Verify locally

```bash
cd bank-portal
npm install
npm run check:env
npm run dev
```

Open `http://localhost:5173/` — you should **not** see the “Supabase preview mode” banner if `.env` is correct.

---

## What you do **not** need to invent

- Table schemas and RLS — see `supabase/migrations/`.
- Function code — see `supabase/functions/`.
- Pages deploy workflow — see `.github/workflows/pages.yml`.

---

## Summary checklist

- [ ] Create Supabase project (free tier is fine).
- [ ] Copy **URL** + **anon** key into `bank-portal/.env` and GitHub Actions secrets.
- [ ] Set **Auth redirect URLs** for localhost + your GitHub Pages URL.
- [ ] Apply **migrations**.
- [ ] (Optional) Deploy **Edge Functions** + Teller secrets + `VITE_TELLER_*` for bank link.
- [ ] Push to `main` (or run the workflow manually) so **GitHub Pages** builds with secrets.

That’s everything only **you** can do; the rest is already in this repository.
