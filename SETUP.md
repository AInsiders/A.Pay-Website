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
  - `http://localhost:5173/**` (`npm run dev`)
  - `http://localhost:4173/**` (`npm run preview` after a build — default Vite preview port)
  - `https://you.github.io/repo/**` (match your Pages URL)

**Example (organization site):** if the app is served from `https://ainsiders.github.io` (with or without a repo path), set **Site URL** to `https://ainsiders.github.io` and add **`https://ainsiders.github.io/**`** to **Redirect URLs** so magic links and OAuth returns match the live origin.

### 3. Database migrations (run once per project)

Either:

- **SQL Editor:** run the files in `supabase/migrations/` in order (`20260416000000` then `20260417000000`), or  
- **CLI:** `supabase link` then `supabase db push` (requires [Supabase CLI](https://supabase.com/docs/guides/cli)).

If tools like MCP report `relation "teller_nonces" does not exist`, those migrations have not been applied on that project yet—bank link cannot persist until they are.

### 4. Edge Functions + Teller (only when you want bank linking)

Deploy from repo root (after `supabase link`). Use **`--no-verify-jwt`** on these Teller handlers so the hosted gateway does not reject **ES256** session JWTs (your functions still call `getUser()` with the caller’s token):

```bash
supabase functions deploy teller-nonce --no-verify-jwt
supabase functions deploy teller-enrollment-complete --no-verify-jwt
supabase functions deploy teller-data --no-verify-jwt
supabase functions deploy teller-webhook --no-verify-jwt
```

From the repo root you can run all four in one go:

- **Windows (PowerShell):** `.\scripts\deploy-teller-edge-functions.ps1`
- **macOS / Linux:** `chmod +x scripts/deploy-teller-edge-functions.sh && ./scripts/deploy-teller-edge-functions.sh`

After deploy, open **Supabase Dashboard → Edge Functions**, select each Teller function, and confirm **Verify JWT** is **off**. If it is still on, run the deploy commands again with `--no-verify-jwt` or toggle it off in the dashboard.

`supabase/config.toml` matches this for local `supabase functions serve`; redeploy after changing function code.

#### GitHub Pages: “CORS” / `No Access-Control-Allow-Origin` on `teller-enrollment-complete`

If the browser console shows **CORS blocked** or **`net::ERR_FAILED`** on `…/functions/v1/teller-enrollment-complete` while the site is on **GitHub Pages** (e.g. `https://ainsiders.github.io`), the usual cause is **not** missing headers in your function code for successful responses—it is the **API gateway rejecting the session JWT before your Deno code runs** (hosted **Verify JWT** still on, or deploy without `--no-verify-jwt`). Gateway errors often **omit** `Access-Control-Allow-Origin`, so DevTools reports a CORS failure instead of **401 Unsupported JWT algorithm**.

**Fix:** redeploy all Teller functions with **`--no-verify-jwt`** (commands above or `scripts/deploy-teller-edge-functions.*`), confirm **Verify JWT** is off in the dashboard, then retry **Connect my bank**. Your functions still validate the caller with `getUser()` inside the handler.

In Supabase → **Edge Functions** → **Secrets**, set at least:

| Secret | Purpose |
|--------|---------|
| `TELLER_TOKEN_SIGNING_PUBLIC_KEY` or `TELLER_TOKEN_SIGNING_PUBLIC_KEYS` | Teller Dashboard — verify Connect payloads |
| `TELLER_CERT_PEM` / `TELLER_KEY_PEM` | Often required for **development/production** Teller API (not always for sandbox) |
| `TELLER_WEBHOOK_SIGNING_SECRET` or `TELLER_WEBHOOK_SIGNING_SECRETS` | Teller webhooks only |

Also add GitHub **Actions secrets** for the **static build** (same names as local):

- `VITE_TELLER_APP_ID`
- `VITE_TELLER_ENVIRONMENT` (`sandbox` for fake banks; `development` or `production` for real accounts—match the Teller Dashboard)

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

`bank-portal/vite.config.ts` sets **`root`** and **`envDir`** to `bank-portal/`, so **`bank-portal/.env`** is always loaded even if you run commands from the repo root.

### Never open the site as `file://` (double‑clicking `index.html`)

If you open `D:\...\index.html` **from Explorer** (URL starts with `file:///`), the browser uses a **`null` origin**. That causes:

- **CORS / module errors** for `assets/*.js` and `*.css` (blocked loads, `net::ERR_FAILED`).
- **Broken Supabase auth** (session / `Authorization` not sent reliably), so Edge Functions like **`teller-nonce` return 401** and you still see generic “non-2xx” messages.

**Use HTTP instead:**

| Goal | Command | Then open |
|------|---------|-----------|
| Local development | `cd bank-portal` → `npm run dev` | `http://localhost:5173/` |
| Test the **built** site (repo root `index.html` + `assets/`) | `cd bank-portal` → `npm run build` → `npm run preview` | `http://localhost:4173/` (default) |

Do **not** rely on double‑clicking `index.html` for this app.

**If you open the repo-root `index.html` / `assets/` (or GitHub Pages) and see “Supabase isn’t connected yet”:**  
`VITE_*` values are **baked in at build time**. After creating or changing `bank-portal/.env`, run `npm run build` in `bank-portal` so root `index.html` and `assets/` pick up the keys. For **GitHub Pages**, the workflow must have `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` as **Actions secrets** — a local `.env` does not affect CI until you add them there.

### “Teller nonce” / Edge Function non-2xx

The app calls **`teller-nonce`** (and other functions) on your Supabase project. If something fails, the UI shows the **server message** (not only “non-2xx”).

| Typical message | What to do |
|-----------------|------------|
| **Unauthorized** (often **401** in DevTools) | Use **`http://localhost`** (dev or preview), not **`file://`**. Then sign in again so the invoke includes a valid JWT. |
| **relation "teller_nonces" does not exist** (or insert error) | Run **`supabase/migrations/`** on this project (SQL Editor or `supabase db push`). |
| **404** / function missing | **Deploy** Edge Functions to this project — at least `teller-nonce`, `teller-enrollment-complete`, and `teller-data` (see commands above). |
| **Unsupported JWT algorithm ES256** (HTTP **401** on `functions/v1/…`) | Redeploy with **`--no-verify-jwt`** (see deploy block above) or turn off JWT verification for those functions in the Supabase dashboard. |

### Teller Connect (finish bank link in the overlay)

**Connect my bank** opens Teller in a **full-page iframe** (`teller.io`). You complete institution search and credentials **inside that overlay**; browser automation from the host page cannot drive those fields (cross-origin). After success, use **Refresh data** if accounts do not appear immediately.

### Edge Function logs (when enrollment or bank sync still fails)

Use **Supabase Dashboard → Edge Functions → [function] → Logs** (or **Log Explorer**).

| What to look for | Meaning |
|------------------|--------|
| **worker boot error**, **BOOT_ERROR**, import / compile errors | Fix the function code or dependencies, then redeploy. |
| **`signature_verify_failed`** / **401** from `teller-enrollment-complete` | Teller signing key env (`TELLER_TOKEN_SIGNING_PUBLIC_KEY`) does not match the Teller app, or payload signatures did not verify. |
| **Database errors** on `teller_nonces` or `teller_enrollments` | Run migrations; check **Secrets** include `SUPABASE_SERVICE_ROLE_KEY` for the Edge runtime. |
| **`nonce_lookup_failed`** / missing nonce | Clock skew, expired nonce, or `teller-nonce` / Connect flow did not align with the signed-in user. |

If logs show **no invocation** for `teller-enrollment-complete` while the browser reports CORS, the request was likely **stopped at the gateway** (JWT verify)—redeploy with `--no-verify-jwt` as above.

---

## What you do **not** need to invent

- Table schemas and RLS — see `supabase/migrations/`.
- Function code — see `supabase/functions/`.
- Pages deploy workflow — see `.github/workflows/pages.yml`.

---

## Summary checklist

- [ ] Create Supabase project (free tier is fine).
- [ ] Copy **URL** + **anon** key into `bank-portal/.env` and GitHub Actions secrets.
- [ ] Set **Auth redirect URLs** for localhost + your GitHub Pages URL (e.g. `https://ainsiders.github.io/**` if that is your host).
- [ ] Apply **migrations**.
- [ ] Deploy **Edge Functions** with **`--no-verify-jwt`** on Teller functions (see commands above); add Teller secrets + `VITE_TELLER_*` when testing bank link.
- [ ] Push to `main` (or run the workflow manually) so **GitHub Pages** builds with secrets.

That’s everything only **you** can do; the rest is already in this repository.
