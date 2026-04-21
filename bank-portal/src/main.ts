import "./styles.css";
import { invokeEdgeFunction, isSupabaseConfigured, resolvedSupabaseUrl, supabase } from "./supabase";
import type { TellerEnrollmentPayload } from "./teller";

/** Edge → Teller can be slow (cold start + bank API). Avoid client-side fetch aborting too early. */
const TELLER_DATA_INVOKE_TIMEOUT_MS = 150_000;

type Profile = {
  id: string;
  display_name: string | null;
  accent_color: string | null;
  theme_mode?: "dark" | "light" | null;
};

function maskToken(token: string | null | undefined): string {
  const t = (token ?? "").trim();
  if (!t) return "—";
  if (t.length <= 18) return `${t.slice(0, 6)}…${t.slice(-4)}`;
  return `${t.slice(0, 10)}…${t.slice(-6)}`;
}

function supabaseHostHint(): string {
  try {
    return new URL(resolvedSupabaseUrl).host;
  } catch {
    return resolvedSupabaseUrl;
  }
}

function formatAuthError(prefix: string, err: unknown): string {
  const host = supabaseHostHint();
  const raw = err instanceof Error ? err.message || String(err) : String(err);

  if (/failed to fetch/i.test(raw)) {
    return `${prefix}: Failed to fetch. Usually network/CORS or invalid Supabase URL. Check VITE_SUPABASE_URL (currently: ${host}).`;
  }

  // @supabase/supabase-js when `fetch` to Edge Functions throws before any HTTP response
  if (/failed to send a request to the edge function/i.test(raw)) {
    return `${prefix}: Could not reach Edge Functions at ${host}. Check: offline/VPN/firewall, browser extensions, Supabase project paused, or opening the app via file:// (use http://localhost:5173). Bank sync waits up to ${Math.round(TELLER_DATA_INVOKE_TIMEOUT_MS / 1000)}s for Teller—if it still fails, inspect DevTools → Network for …/functions/v1/teller-data.`;
  }

  if (err instanceof Error) {
    return `${prefix}: ${raw}`;
  }
  return `${prefix}: ${raw}`;
}

/** Supabase `functions.invoke` hides Edge Function JSON in `FunctionsHttpError.context` — unpack it. */
/** `teller-data` returns 400 when the user has not completed Teller Connect yet — not a sync failure. */
function isNoBankEnrollmentMessage(msg: string): boolean {
  return /No bank connection\. Run Teller Connect first\./i.test(msg.trim());
}

async function edgeFunctionMessage(err: unknown): Promise<string> {
  if (err && typeof err === "object" && "context" in err) {
    const ctx = (err as { context?: Response }).context;
    if (ctx && typeof ctx.clone === "function") {
      const status = ctx.status;
      try {
        const text = (await ctx.clone().text()).trim();
        if (text) {
          try {
            const body = JSON.parse(text) as Record<string, unknown>;
            const piece =
              (typeof body.error === "string" && body.error) ||
              (typeof body.message === "string" && body.message) ||
              (typeof body.msg === "string" && body.msg);
            const errCode = typeof body.code === "string" && body.code.trim()
              ? body.code.trim()
              : "";
            if (piece) {
              const suffix = errCode ? ` [${errCode}]` : "";
              return status ? `${piece}${suffix} (HTTP ${status})` : `${piece}${suffix}`;
            }
          } catch {
            return status ? `${text.slice(0, 400)} (HTTP ${status})` : text.slice(0, 400);
          }
        }
      } catch {
        /* fall through */
      }
      if (status) return `HTTP ${status}`;
    }
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/** Validates session with Supabase before Edge calls (reduces races right after sign-in or Connect). */
async function ensureFreshAuthForEdge(): Promise<void> {
  const { error } = await supabase.auth.getUser();
  if (error) throw error;
}

/** Ensures Edge Functions receive a JWT (some browsers/builds omit the default header). */
async function bearerAuthHeaders(): Promise<{ Authorization: string }> {
  const { data, error } = await supabase.auth.getSession();
  if (error) throw error;
  const t = data.session?.access_token?.trim();
  if (!t) throw new Error("No active session. Sign out and sign in again.");
  return { Authorization: `Bearer ${t}` };
}

const THEME_PRESETS: { id: string; label: string; hex: string }[] = [
  { id: "mint", label: "Cash mint", hex: "#5ee7ff" },
  { id: "bullion", label: "Gold vault", hex: "#e8c547" },
  { id: "platinum", label: "Platinum", hex: "#c4b5fd" },
  { id: "bull", label: "Green bull", hex: "#5ef3a1" },
  { id: "rose", label: "Rose fund", hex: "#ff6b9d" },
  { id: "ember", label: "Copper wire", hex: "#ff8a5c" },
];

const state: {
  session: Awaited<ReturnType<typeof supabase.auth.getSession>>["data"]["session"];
  profile: Profile | null;
  accounts: unknown[];
  transactions: unknown[];
  selectedAccountId: string | null;
  error: string | null;
  info: string | null;
  busy: boolean;
  /** Guest landing: sign-in modal visibility */
  authModalOpen: boolean;
  /** When user returned from a password recovery email link. */
  recoveryMode: boolean;
} = {
  session: null,
  profile: null,
  accounts: [],
  transactions: [],
  selectedAccountId: null,
  error: null,
  info: null,
  busy: false,
  authModalOpen: false,
  recoveryMode: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Cleans pointer/scroll listeners when leaving the guest landing view. */
let landingParallaxTeardown: (() => void) | null = null;

const DEFAULT_ACCENT = "#5ee7ff";

function applyMode(mode: Profile["theme_mode"]) {
  const m = mode === "light" ? "light" : "dark";
  document.documentElement.dataset.mode = m;
  const meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (meta) meta.content = m === "light" ? "#f8fafc" : "#050810";
}

function applyFullTheme(hex: string | null) {
  const root = document.documentElement;
  const v = hex?.trim();
  if (!v || !/^#[0-9a-fA-F]{6}$/.test(v)) {
    root.style.setProperty("--accent", DEFAULT_ACCENT);
    root.style.setProperty("--accent-dim", "color-mix(in srgb, var(--accent) 28%, transparent)");
    root.style.setProperty("--accent-glow", "color-mix(in srgb, var(--accent) 55%, transparent)");
    return;
  }
  root.style.setProperty("--accent", v);
  root.style.setProperty("--accent-dim", `color-mix(in srgb, ${v} 28%, transparent)`);
  root.style.setProperty("--accent-glow", `color-mix(in srgb, ${v} 55%, transparent)`);
}

function money(n: unknown): string {
  const num = typeof n === "number" ? n : Number(n);
  if (Number.isNaN(num)) return "—";
  const abs = Math.abs(num);
  const sign = num < 0 ? "-" : "";
  return `${sign}$${abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

async function loadProfile(userId: string) {
  const { data, error } = await supabase.from("profiles").select("*").eq("id", userId).maybeSingle();
  if (error) throw error;
  if (data) {
    state.profile = data as Profile;
    applyMode(state.profile.theme_mode);
    applyFullTheme(state.profile.accent_color);
    return;
  }
  const email = state.session?.user.email ?? "you";
  const insert = {
    id: userId,
    display_name: email.split("@")[0] ?? "User",
    accent_color: DEFAULT_ACCENT,
    theme_mode: "dark" as const,
  };
  const { data: created, error: insErr } = await supabase.from("profiles").insert(insert).select().single();
  if (insErr) throw insErr;
  state.profile = created as Profile;
  applyMode(insert.theme_mode);
  applyFullTheme(insert.accent_color);
}

async function saveProfile(
  partial: Partial<Pick<Profile, "display_name" | "accent_color" | "theme_mode">>,
) {
  if (!state.session?.user.id) return;
  state.busy = true;
  state.error = null;
  render();
  const { data, error } = await supabase
    .from("profiles")
    .upsert({ id: state.session.user.id, ...partial, updated_at: new Date().toISOString() })
    .select()
    .single();
  state.busy = false;
  if (error) {
    state.error = error.message;
    render();
    return;
  }
  state.profile = data as Profile;
  applyMode(state.profile.theme_mode);
  applyFullTheme(state.profile.accent_color);
  state.info = "Appearance saved.";
  render();
  setTimeout(() => {
    state.info = null;
    render();
  }, 2200);
}

async function refreshBankData() {
  if (!state.session) return;
  state.busy = true;
  state.error = null;
  render();
  try {
    await ensureFreshAuthForEdge();
    const headers = await bearerAuthHeaders();
    const { data, error } = await invokeEdgeFunction("teller-data", {
      body: { action: "accounts" },
      headers,
      timeout: TELLER_DATA_INVOKE_TIMEOUT_MS,
    });
    if (error) {
      const msg = await edgeFunctionMessage(error);
      if (isNoBankEnrollmentMessage(msg)) {
        state.accounts = [];
        state.transactions = [];
        state.selectedAccountId = null;
        state.busy = false;
        state.error = null;
        render();
        return;
      }
      throw new Error(msg);
    }
    const payload = data as { accounts?: unknown[]; error?: string };
    if (payload?.error) throw new Error(payload.error);
    state.accounts = payload.accounts ?? [];
  } catch (e) {
    state.error = formatAuthError("Bank sync", e);
    state.accounts = [];
    state.transactions = [];
    state.busy = false;
    render();
    return;
  }
  state.busy = false;
  if (!state.selectedAccountId && state.accounts.length) {
    const first = state.accounts[0] as { id?: string };
    state.selectedAccountId = first.id ?? null;
  }
  await loadTransactions();
}

async function loadTransactions() {
  if (!state.session || !state.selectedAccountId) {
    state.transactions = [];
    render();
    return;
  }
  state.busy = true;
  state.error = null;
  render();
  try {
    await ensureFreshAuthForEdge();
    const headers = await bearerAuthHeaders();
    const { data, error } = await invokeEdgeFunction("teller-data", {
      body: { action: "transactions", accountId: state.selectedAccountId },
      headers,
      timeout: TELLER_DATA_INVOKE_TIMEOUT_MS,
    });
    if (error) throw new Error(await edgeFunctionMessage(error));
    const payload = data as { transactions?: unknown[]; error?: string };
    if (payload?.error) throw new Error(payload.error);
    state.transactions = payload.transactions ?? [];
  } catch (e) {
    state.error = formatAuthError("Transaction load", e);
    state.transactions = [];
  } finally {
    state.busy = false;
    render();
  }
}

async function fetchNonce(): Promise<string> {
  try {
    const headers = await bearerAuthHeaders();
    const { data, error } = await invokeEdgeFunction("teller-nonce", {
      body: {},
      headers,
    });
    if (error) throw new Error(await edgeFunctionMessage(error));
    const n = (data as { nonce?: string })?.nonce;
    if (!n) throw new Error("No nonce returned");
    return n;
  } catch (e) {
    throw new Error(formatAuthError("Teller nonce", e));
  }
}

function tellerEnvironment(): string {
  // sandbox = Teller fake institutions; development | production = real FI data (per Teller app settings).
  return import.meta.env.VITE_TELLER_ENVIRONMENT?.trim() || "development";
}

/** True when the SPA was built with a Teller application id (required for Connect). */
function tellerConfigured(): boolean {
  return Boolean(import.meta.env.VITE_TELLER_APP_ID?.trim());
}

function tellerAppId(): string {
  const id = import.meta.env.VITE_TELLER_APP_ID?.trim();
  if (!id) throw new Error("Missing VITE_TELLER_APP_ID");
  return id;
}

async function startTellerConnect() {
  if (!state.session) {
    state.error = "Sign in first.";
    render();
    return;
  }
  if (!tellerConfigured()) {
    state.error =
      "Missing VITE_TELLER_APP_ID. Add your Teller application ID to bank-portal/.env, run npm run dev (or npm run build), and reload.";
    render();
    return;
  }
  if (!window.TellerConnect?.setup) {
    state.error =
      "Teller Connect did not load. Check the network tab for https://cdn.teller.io/connect/connect.js (ad blockers and strict CSP can block it).";
    render();
    return;
  }
  state.busy = true;
  state.error = null;
  render();
  try {
    const nonce = await fetchNonce();
    state.busy = false;
    render();

    const tc = window.TellerConnect.setup({
      applicationId: tellerAppId(),
      environment: tellerEnvironment(),
      products: ["balance", "transactions"],
      nonce,
      onSuccess: async (enrollment: TellerEnrollmentPayload) => {
        state.busy = true;
        state.error = null;
        render();
        const headers = await bearerAuthHeaders();
        const { error } = await invokeEdgeFunction("teller-enrollment-complete", {
          body: { nonce, environment: tellerEnvironment(), payload: enrollment },
          headers,
        });
        state.busy = false;
        if (error) {
          state.error = await edgeFunctionMessage(error);
          render();
          return;
        }
        state.info = "Bank connected.";
        render();
        await refreshBankData();
        setTimeout(() => {
          state.info = null;
          render();
        }, 2500);
      },
      onExit: () => {
        state.busy = false;
        render();
      },
      onFailure: (failure) => {
        state.busy = false;
        const msg = failure?.message?.trim();
        state.error = msg ? `Teller Connect: ${msg}` : "Teller Connect reported an error.";
        render();
      },
    });
    tc.open();
  } catch (e) {
    state.busy = false;
    state.error = e instanceof Error ? e.message : String(e);
    render();
  }
}

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

function renderBoot() {
  return `
    <div class="fx-root">
      <div class="fx-grid" aria-hidden="true"></div>
      <div class="fx-scan" aria-hidden="true"></div>
      <div class="fx-noise" aria-hidden="true"></div>
      <div class="fx-boot">
        <div class="fx-static-boot__card" style="max-width:360px">
          <div class="fx-static-boot__logo" aria-hidden="true"></div>
          <p class="fx-static-boot__text">Opening your A.Pay workspace…</p>
        </div>
      </div>
    </div>
  `;
}

/** Hero: stacks of cash / liquidity mood (Unsplash). */
const LANDING_HERO_IMG =
  "https://images.unsplash.com/photo-1530651788726-238dfa2d8d5c?auto=format&fit=crop&w=1920&q=85";

function renderAuth() {
  const supabaseHost = (() => {
    try {
      return new URL(resolvedSupabaseUrl).host;
    } catch {
      return resolvedSupabaseUrl;
    }
  })();
  const disabled = state.busy || !isSupabaseConfigured;
  return `
    <div class="fx-root fx-root--landing">
      <div class="fx-grid" aria-hidden="true"></div>
      <div class="fx-scan" aria-hidden="true"></div>
      <div class="fx-noise" aria-hidden="true"></div>

      <header class="fx-landing-header" role="banner">
        <div class="fx-landing-header__inner shell-narrow">
          <div class="fx-brand">
            <div class="fx-brand__mark" aria-hidden="true"></div>
            <div class="fx-brand__text">
              <span class="fx-brand__name">A.Pay</span>
              <span class="fx-brand__tag">Cash-first clarity</span>
            </div>
          </div>
          <button type="button" class="fx-landing-header__link" id="btn-open-auth">Sign in</button>
        </div>
      </header>

      <div class="fx-hero-parallax-wrap" id="hero-parallax-scope" aria-label="A.Pay home">
        <section class="fx-hero-pro fx-hero-pro--fullscreen" aria-labelledby="landing-hero-title">
          <div class="fx-hero-pro__media">
            <div class="fx-hero-pro__parallax-inner fx-parallax-bg">
              <img
                class="fx-hero-pro__img"
                src="${LANDING_HERO_IMG}"
                width="1920"
                height="1080"
                alt="US hundred-dollar bills—liquid cash, financial freedom energy"
                decoding="async"
                fetchpriority="high"
              />
            </div>
          </div>
          <div class="fx-hero-pro__overlay"></div>

          <div class="fx-hero-pro__body">
            <div class="fx-hero-pro__content shell-narrow fx-parallax-hero-copy">
              <p class="fx-hero-pro__eyebrow">Bill dread off · liquidity on</p>
              <h1 id="landing-hero-title" class="fx-hero-pro__title">
                Built for the vibe of <span class="fx-hero-pro__accent">all cash, no panic</span>
              </h1>
              <p class="fx-hero-pro__lede">
                See what’s already handled automatically, then treat the rest like money in your pocket—forecast paydays,
                link your bank with Teller, and spend knowing exactly what’s still truly yours.
              </p>
              <div class="fx-hero-pro__actions">
                <button type="button" class="fx-btn-hero" id="btn-hero-cta">Start stacking clarity</button>
                <button type="button" class="fx-btn-hero-secondary js-open-auth">I already have an account</button>
              </div>
              <ul class="fx-hero-pro__trust" aria-label="Highlights">
                <li>Liquid cash, spelled out</li>
                <li>Real balances via Teller</li>
                <li>Spend loud, not blind</li>
              </ul>
            </div>
          </div>
        </section>
      </div>

      <div
        class="fx-auth-modal${state.authModalOpen ? " fx-auth-modal--open" : ""}"
        id="auth-modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="auth-modal-title"
        ${state.authModalOpen ? "" : "hidden"}
      >
        <button type="button" class="fx-auth-modal__backdrop" id="auth-modal-backdrop" aria-label="Close"></button>
        <div class="fx-auth-modal__panel" id="sign-in-panel">
          <div class="fx-auth-modal__chrome">
            <h2 id="auth-modal-title" class="fx-auth-modal__title">Access A.Pay</h2>
            <button type="button" class="fx-auth-modal__close" id="auth-modal-close" aria-label="Close">×</button>
          </div>
          <p class="fx-auth-modal__lede">Secure sign-in. Your forecast and bank link sync to your profile.</p>
          ${
            !isSupabaseConfigured
              ? `<div class="banner" style="margin:10px 0 12px">
                  <strong>Supabase isn’t connected yet.</strong><br />
                  Add <code>bank-portal/.env</code> (local) or GitHub Actions secrets (deploy) for
                  <strong>VITE_SUPABASE_URL</strong> and <strong>VITE_SUPABASE_ANON_KEY</strong>.
                </div>`
              : ""
          }
          <form id="form-signin" class="fx-auth-modal__form list">
            <label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@email.com" /></label>
            <label class="field">Password<input name="password" type="password" autocomplete="current-password" required placeholder="••••••••" /></label>
            <div class="row row--stretch">
              <button type="submit" class="fx-btn-block" ${disabled ? "disabled" : ""}>Enter A.Pay</button>
              <button type="button" class="secondary fx-btn-block" id="btn-signup" ${disabled ? "disabled" : ""}>Create account</button>
            </div>
            <div class="row row--stretch">
              <button type="button" class="secondary fx-btn-block" id="btn-magiclink" ${disabled ? "disabled" : ""}>Email me a magic link</button>
              <button type="button" class="secondary fx-btn-block" id="btn-forgot" ${disabled ? "disabled" : ""}>Forgot password</button>
            </div>
            <p class="muted" style="margin:6px 0 0">
              Supabase: <strong>${escapeHtml(isSupabaseConfigured ? supabaseHost : "Not configured (preview mode)")}</strong>
            </p>
            ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
            ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
          </form>

          ${
            state.recoveryMode
              ? `
                <hr style="border:0;border-top:1px solid rgba(255,255,255,.08);margin:14px 0" />
                <form id="form-recovery" class="fx-auth-modal__form list">
                  <p class="muted" style="margin:0">Set a new password to finish recovery.</p>
                  <label class="field">New password<input name="new_password" type="password" autocomplete="new-password" required placeholder="••••••••" /></label>
                  <label class="field">Confirm new password<input name="new_password_confirm" type="password" autocomplete="new-password" required placeholder="••••••••" /></label>
                  <div class="row row--stretch">
                    <button type="submit" class="fx-btn-block" ${state.busy ? "disabled" : ""}>Update password</button>
                  </div>
                  ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
                  ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
                </form>
              `
              : ""
          }
        </div>
      </div>

      <footer class="fx-landing-footer" role="contentinfo">
        <div class="fx-landing-footer__inner shell-narrow">
          <p class="fx-landing-footer__copy">© ${new Date().getFullYear()} A.Insiders Network. All rights reserved.</p>
        </div>
      </footer>

      <section class="fx-value-section shell-narrow" aria-labelledby="value-heading">
        <h2 id="value-heading" class="fx-value-section__title">Why cash-conscious households use A.Pay</h2>
        <p class="fx-value-section__subtitle">
          Most apps leave you staring at history. A.Pay shows what stays liquid after life auto-pays itself—so you move through paydays with swagger, not spreadsheet shame.
        </p>
        <div class="fx-value-grid">
          <article class="fx-value-card">
            <span class="fx-value-card__icon" aria-hidden="true">01</span>
            <h3 class="fx-value-card__h">Forecast across paydays</h3>
            <p class="fx-value-card__p">
              Map income across upcoming paydays—liquidity first, not just today’s balance—so shortfalls surface before they sting.
            </p>
          </article>
          <article class="fx-value-card">
            <span class="fx-value-card__icon" aria-hidden="true">02</span>
            <h3 class="fx-value-card__h">Know what’s safe to spend</h3>
            <p class="fx-value-card__p">
              See what’s already earmarked for life’s non-negotiables, then spend what’s left without the guilt—or the overdraft surprise.
            </p>
          </article>
          <article class="fx-value-card">
            <span class="fx-value-card__icon" aria-hidden="true">03</span>
            <h3 class="fx-value-card__h">Real bank data, one glass pane</h3>
            <p class="fx-value-card__p">
              Connect accounts with Teller and watch deposits and debits roll in. Your forecast stays honest because your numbers stay current.
            </p>
          </article>
        </div>
      </section>
    </div>
  `;
}

function accountTitle(a: Record<string, unknown>): string {
  const inst = (a.institution as { name?: string } | undefined)?.name;
  const name = (a.name as string | undefined) ?? "Account";
  return inst ? `${inst} — ${name}` : name;
}

function themePresetButtons(currentHex: string): string {
  return THEME_PRESETS.map((p) => {
    const active = p.hex.toLowerCase() === currentHex.toLowerCase() ? " is-active" : "";
    return `
      <button type="button" class="fx-theme-preset${active}" data-theme-hex="${escapeHtml(p.hex)}" aria-pressed="${active ? "true" : "false"}">
        <span class="fx-theme-preset__sw" style="--swatch:${escapeHtml(p.hex)}"></span>
        <span class="fx-theme-preset__name">${escapeHtml(p.label)}</span>
      </button>
    `;
  }).join("");
}

function renderApp() {
  const profile = state.profile;
  const accent = profile?.accent_color ?? DEFAULT_ACCENT;
  const mode = profile?.theme_mode === "light" ? "light" : "dark";
  const user = state.session?.user;
  const identity = user?.identities?.[0];
  const provider = (identity?.provider as string | undefined) ?? (user?.app_metadata as { provider?: string } | undefined)?.provider;
  const lastSignIn = (user as { last_sign_in_at?: string } | null)?.last_sign_in_at ?? null;
  const createdAt = (user as { created_at?: string } | null)?.created_at ?? null;
  const accessToken = maskToken(state.session?.access_token);
  const rows = (state.accounts as Record<string, unknown>[]).map((a) => {
    const id = String(a.id ?? "");
    const sel = id === state.selectedAccountId ? "secondary" : "";
    return `
      <div class="card">
        <h3>${escapeHtml(accountTitle(a))}</h3>
        <p class="muted">${escapeHtml(String(a.subtype ?? a.type ?? "account"))}</p>
        <div class="row">
          <button type="button" class="${sel}" data-pick-account="${escapeHtml(id)}">View activity</button>
        </div>
      </div>
    `;
  });

  const txRows = (state.transactions as Record<string, unknown>[]).map((t) => {
    const amt = t.amount as number | string | undefined;
    const date = String(t.date ?? t.running_balance_at ?? "");
    const desc = String(t.description ?? "Transaction");
    const n = typeof amt === "number" ? amt : Number(amt);
    const cls = n >= 0 ? "amt-pos" : "amt-neg";
    return `
      <div class="tx">
        <div>
          <div class="tx-title">${escapeHtml(desc)}</div>
          <div class="tx-date">${escapeHtml(date)}</div>
        </div>
        <div class="${cls}">${money(n)}</div>
      </div>
    `;
  });

  const busy = state.busy
    ? `<span class="fx-busy-hint"><span class="fx-spinner" aria-hidden="true"></span> Syncing…</span>`
    : "";

  return `
    <div class="fx-root">
      <div class="fx-grid" aria-hidden="true"></div>
      <div class="fx-scan" aria-hidden="true"></div>
      <div class="fx-noise" aria-hidden="true"></div>
      <div class="shell">
        <header class="fx-header">
          <div class="fx-brand">
            <div class="fx-brand__mark" aria-hidden="true"></div>
            <div class="fx-brand__text">
              <span class="fx-brand__name">A.Pay</span>
              <span class="fx-brand__tag">Forecast &amp; cash</span>
            </div>
          </div>
          <div class="fx-header__actions">
            <span class="fx-pill"><strong>${escapeHtml(profile?.display_name ?? state.session?.user.email ?? "Member")}</strong></span>
            ${busy}
            <button type="button" class="danger" id="btn-signout" ${state.busy ? "disabled" : ""}>Sign out</button>
          </div>
        </header>

        ${
          !isSupabaseConfigured
            ? `<div class="banner">A.Pay preview: add <strong>.env</strong> with <strong>VITE_SUPABASE_URL</strong> and <strong>VITE_SUPABASE_ANON_KEY</strong> so sign-in and bank link work end-to-end.</div>`
            : ""
        }
        ${state.error ? `<div class="banner banner--alert" role="alert">${escapeHtml(state.error)}</div>` : ""}

        <div class="fx-layout fx-layout--split">
          <div class="fx-stack">
            <section class="fx-panel fx-panel--highlight">
              <p class="fx-eyebrow">Your profile</p>
              <h2>Make A.Pay yours</h2>
              <p class="muted">How you appear in the app and the accent color for your personal “million-dollar” dashboard vibe.</p>
              <form id="form-profile" class="list">
                <label class="field">Display name<input name="display_name" type="text" value="${escapeHtml(profile?.display_name ?? "")}" placeholder="First name or nickname" /></label>
                <input type="hidden" name="accent_color" id="field-accent" value="${escapeHtml(accent)}" />
                <div class="field">
                  <div style="display:flex;align-items:center;justify-content:space-between;gap:12px">
                    <span style="font-weight:600">Mode</span>
                    <div class="fx-seg" role="group" aria-label="Theme mode">
                      <button type="button" class="fx-seg__btn${mode === "dark" ? " is-active" : ""}" data-mode="dark" aria-pressed="${mode === "dark" ? "true" : "false"}">Dark</button>
                      <button type="button" class="fx-seg__btn${mode === "light" ? " is-active" : ""}" data-mode="light" aria-pressed="${mode === "light" ? "true" : "false"}">Light</button>
                    </div>
                  </div>
                  <input type="hidden" name="theme_mode" id="field-mode" value="${escapeHtml(mode)}" />
                </div>
                <div class="row" style="margin-top:4px">
                  <button type="submit" ${state.busy ? "disabled" : ""}>Save profile</button>
                </div>
                ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
              </form>
            </section>

            <section class="fx-panel">
              <p class="fx-eyebrow">Signed-in</p>
              <h2>Your account</h2>
              <div class="list">
                <div class="card">
                  <p class="muted" style="margin:0 0 8px">These details help debug auth + fetch issues.</p>
                  <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap">
                    <span class="fx-pill">Email: <strong>${escapeHtml(user?.email ?? "—")}</strong></span>
                    <span class="fx-pill">User ID: <strong>${escapeHtml(user?.id ?? "—")}</strong></span>
                  </div>
                  <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px">
                    <span class="fx-pill">Provider: <strong>${escapeHtml(provider ?? "email")}</strong></span>
                    <span class="fx-pill">Access token: <strong>${escapeHtml(accessToken)}</strong></span>
                  </div>
                  <div class="row" style="justify-content:space-between;gap:10px;flex-wrap:wrap;margin-top:10px">
                    <span class="fx-pill">Created: <strong>${escapeHtml(createdAt ? new Date(createdAt).toLocaleString() : "—")}</strong></span>
                    <span class="fx-pill">Last sign-in: <strong>${escapeHtml(lastSignIn ? new Date(lastSignIn).toLocaleString() : "—")}</strong></span>
                  </div>
                </div>
              </div>
              ${
                !isSupabaseConfigured
                  ? `<p class="error" style="margin-top:12px">Supabase is in preview mode (missing VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY). Function calls will fail until set.</p>`
                  : ""
              }
            </section>

            <section class="fx-panel">
              <p class="fx-eyebrow">Look &amp; feel</p>
              <h2>Vault colors</h2>
              <p class="muted">Presets inspired by cash, bullion, and momentum—or dial in your own accent. Live preview; save to keep it.</p>
              <div class="fx-theme-grid" id="theme-presets" role="group" aria-label="Theme presets">
                ${themePresetButtons(accent)}
              </div>
              <div class="fx-color-row">
                <label class="field">Custom accent<input id="field-color-picker" type="color" value="${escapeHtml(accent)}" aria-label="Custom accent color" /></label>
              </div>
            </section>
          </div>

          <div class="fx-stack">
            <section class="fx-panel">
              <p class="fx-eyebrow">Bank link</p>
              <h2>Feed your forecast real data</h2>
              <p class="muted">
                Connect with Teller so deposits, bills, and spending show up where you’re planning. Environment is
                <strong>${escapeHtml(tellerEnvironment())}</strong>
                (${tellerEnvironment() === "sandbox" ? "fake institutions" : "real institutions your Teller app is allowed to use"}). Set
                <code>VITE_TELLER_ENVIRONMENT</code> in <code>bank-portal/.env</code> to <code>sandbox</code>,
                <code>development</code>, or <code>production</code>, then restart dev or rebuild.
              </p>
              <div class="row">
                <button type="button" id="btn-teller" ${state.busy ? "disabled" : ""}>Connect my bank</button>
                <button type="button" class="secondary" id="btn-refresh" ${state.busy ? "disabled" : ""}>Refresh data</button>
              </div>
              ${
                !tellerConfigured()
                  ? `<p class="error" style="margin-top:12px">Bank link needs <strong>VITE_TELLER_APP_ID</strong> in <code>bank-portal/.env</code> (restart dev or rebuild; required at build time for production).</p>`
                  : ""
              }
            </section>

            <section class="fx-panel">
              <p class="fx-eyebrow">Your money map</p>
              <h2>Accounts</h2>
              ${rows.length ? `<div class="list">${rows.join("")}</div>` : `<p class="muted">Link a bank above to see checking, savings, and more—where your paychecks actually land.</p>`}
            </section>

            <section class="fx-panel">
              <p class="fx-eyebrow">Activity</p>
              <h2>Transactions</h2>
              <p class="muted">The latest movement on the account you select—so your forecast can match real life.</p>
              <div class="tx-feed">
                ${txRows.length ? txRows.join("") : `<p class="muted" style="padding:16px;margin:0">Connect an account and pick it above to load your stream.</p>`}
              </div>
            </section>
          </div>
        </div>
      </div>
    </div>
  `;
}

function render() {
  landingParallaxTeardown?.();
  landingParallaxTeardown = null;

  if (!state.session) {
    applyFullTheme(null);
    document.body.style.overflow = state.authModalOpen ? "hidden" : "";
    app.innerHTML = renderAuth();
    wireAuth();
    if (state.authModalOpen) {
      queueMicrotask(() =>
        document.querySelector<HTMLInputElement>('#form-signin input[name="email"]')?.focus(),
      );
    }
    return;
  }
  document.body.style.overflow = "";
  applyFullTheme(state.profile?.accent_color ?? DEFAULT_ACCENT);
  app.innerHTML = renderApp();
  wireApp();
}

function openAuthModal() {
  state.authModalOpen = true;
  render();
}

function closeAuthModal() {
  state.authModalOpen = false;
  render();
}

/** Pointer-driven parallax: background moves slowly; nav + glass move faster (layered depth). */
function bindLandingParallax() {
  landingParallaxTeardown?.();
  landingParallaxTeardown = null;

  const root = document.getElementById("hero-parallax-scope");
  if (!root) return;

  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
    root.style.setProperty("--prlx-x", "0");
    root.style.setProperty("--prlx-y", "0");
    root.style.setProperty("--prlx-scroll", "0");
    return;
  }

  let raf = 0;
  let mx = 0;
  let my = 0;

  const flush = () => {
    raf = 0;
    root.style.setProperty("--prlx-x", mx.toFixed(5));
    root.style.setProperty("--prlx-y", my.toFixed(5));
  };

  const setFromClient = (clientX: number, clientY: number) => {
    const rect = root.getBoundingClientRect();
    const w = Math.max(rect.width, 1);
    const h = Math.max(rect.height, 1);
    mx = ((clientX - rect.left) / w - 0.5) * 2;
    my = ((clientY - rect.top) / h - 0.5) * 2;
    if (!raf) raf = requestAnimationFrame(flush);
  };

  const onMove = (e: MouseEvent) => setFromClient(e.clientX, e.clientY);

  const onTouch = (e: TouchEvent) => {
    if (e.touches.length !== 1) return;
    const t = e.touches[0];
    setFromClient(t.clientX, t.clientY);
  };

  const onScroll = () => {
    const rect = root.getBoundingClientRect();
    const total = Math.max(rect.height, 1);
    const past = Math.min(1, Math.max(0, -rect.top / total));
    root.style.setProperty("--prlx-scroll", past.toFixed(5));
  };

  root.addEventListener("mousemove", onMove);
  root.addEventListener("touchmove", onTouch, { passive: true });
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  landingParallaxTeardown = () => {
    root.removeEventListener("mousemove", onMove);
    root.removeEventListener("touchmove", onTouch);
    window.removeEventListener("scroll", onScroll);
  };
}

function wireAuth() {
  bindLandingParallax();

  document.getElementById("btn-hero-cta")?.addEventListener("click", () => openAuthModal());
  document.getElementById("btn-open-auth")?.addEventListener("click", () => openAuthModal());
  document.querySelectorAll<HTMLElement>(".js-open-auth").forEach((el) => {
    el.addEventListener("click", () => openAuthModal());
  });

  document.getElementById("auth-modal-backdrop")?.addEventListener("click", () => closeAuthModal());
  document.getElementById("auth-modal-close")?.addEventListener("click", () => closeAuthModal());

  const form = document.querySelector<HTMLFormElement>("#form-signin");
  const signup = document.querySelector<HTMLButtonElement>("#btn-signup");
  const magic = document.querySelector<HTMLButtonElement>("#btn-magiclink");
  const forgot = document.querySelector<HTMLButtonElement>("#btn-forgot");
  const recoveryForm = document.querySelector<HTMLFormElement>("#form-recovery");

  const redirectTo = `${new URL(import.meta.env.BASE_URL, window.location.origin)}`;
  if (!isSupabaseConfigured) {
    // Keep the modal usable for instructions, but prevent confusing network errors.
    form?.addEventListener("submit", (e) => e.preventDefault());
    signup?.addEventListener("click", () => {});
    magic?.addEventListener("click", () => {});
    forgot?.addEventListener("click", () => {});
    recoveryForm?.addEventListener("submit", (e) => e.preventDefault());
    return;
  }
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(form);
    const email = String(fd.get("email") ?? "");
    const password = String(fd.get("password") ?? "");
    state.busy = true;
    state.error = null;
    state.authModalOpen = true;
    render();
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    state.busy = false;
    if (error) {
      state.error = error.message;
      state.authModalOpen = true;
      render();
      return;
    }
  });
  magic?.addEventListener("click", async () => {
    const formEl = document.querySelector<HTMLFormElement>("#form-signin");
    if (!formEl) return;
    const fd = new FormData(formEl);
    const email = String(fd.get("email") ?? "").trim();
    if (!email) {
      state.error = "Enter your email first.";
      state.authModalOpen = true;
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    state.info = null;
    state.authModalOpen = true;
    render();
    const { error } = await supabase.auth.signInWithOtp({
      email,
      options: { emailRedirectTo: redirectTo },
    });
    state.busy = false;
    if (error) {
      state.error = error.message;
      state.authModalOpen = true;
      render();
      return;
    }
    state.info = "Magic link sent. Check your email.";
    state.authModalOpen = true;
    render();
  });
  forgot?.addEventListener("click", async () => {
    const formEl = document.querySelector<HTMLFormElement>("#form-signin");
    if (!formEl) return;
    const fd = new FormData(formEl);
    const email = String(fd.get("email") ?? "").trim();
    if (!email) {
      state.error = "Enter your email first.";
      state.authModalOpen = true;
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    state.info = null;
    state.authModalOpen = true;
    render();
    const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo });
    state.busy = false;
    if (error) {
      state.error = error.message;
      state.authModalOpen = true;
      render();
      return;
    }
    state.info = "Password reset email sent.";
    state.authModalOpen = true;
    render();
  });

  recoveryForm?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const fd = new FormData(recoveryForm);
    const a = String(fd.get("new_password") ?? "");
    const b = String(fd.get("new_password_confirm") ?? "");
    if (a.length < 8) {
      state.error = "Use at least 8 characters for the password.";
      state.authModalOpen = true;
      render();
      return;
    }
    if (a !== b) {
      state.error = "Passwords do not match.";
      state.authModalOpen = true;
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    state.info = null;
    state.authModalOpen = true;
    render();
    const { error } = await supabase.auth.updateUser({ password: a });
    state.busy = false;
    if (error) {
      state.error = error.message;
      state.authModalOpen = true;
      render();
      return;
    }
    state.recoveryMode = false;
    state.info = "Password updated. You can continue signing in.";
    // Remove recovery tokens from the URL.
    history.replaceState({}, document.title, `${window.location.pathname}${window.location.search}`);
    state.authModalOpen = true;
    render();
  });
  signup?.addEventListener("click", async () => {
    const formEl = document.querySelector<HTMLFormElement>("#form-signin");
    if (!formEl) return;
    const fd = new FormData(formEl);
    const email = String(fd.get("email") ?? "");
    const password = String(fd.get("password") ?? "");
    if (password.length < 8) {
      state.error = "Use at least 8 characters for the password.";
      state.authModalOpen = true;
      render();
      return;
    }
    state.busy = true;
    state.error = null;
    state.authModalOpen = true;
    render();
    const { data, error } = await supabase.auth.signUp({ email, password });
    state.busy = false;
    if (error) {
      state.error = error.message;
      state.authModalOpen = true;
      render();
      return;
    }
    state.error = null;
    if (data.session) {
      state.session = data.session;
      state.info = null;
      state.authModalOpen = false;
      render();
      return;
    }
    state.info = "Check your email if confirmation is enabled, then sign in.";
    state.authModalOpen = true;
    render();
  });
}

function wireApp() {
  const accentInput = document.querySelector<HTMLInputElement>("#field-accent");
  const colorPicker = document.querySelector<HTMLInputElement>("#field-color-picker");
  const modeInput = document.querySelector<HTMLInputElement>("#field-mode");

  document.querySelector<HTMLButtonElement>("#btn-signout")?.addEventListener("click", async () => {
    state.busy = true;
    render();
    await supabase.auth.signOut();
    state.session = null;
    state.profile = null;
    state.accounts = [];
    state.transactions = [];
    state.busy = false;
    state.authModalOpen = false;
    applyFullTheme(null);
    render();
  });

  document.querySelector<HTMLFormElement>("#form-profile")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const fd = new FormData(form);
    const display_name = String(fd.get("display_name") ?? "").trim();
    const accent_color = String(fd.get("accent_color") ?? colorPicker?.value ?? "").trim();
    const theme_mode = String(fd.get("theme_mode") ?? "dark").trim() === "light" ? "light" : "dark";
    applyFullTheme(accent_color);
    applyMode(theme_mode);
    await saveProfile({ display_name: display_name || null, accent_color, theme_mode });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-mode]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const m = btn.getAttribute("data-mode") === "light" ? "light" : "dark";
      if (modeInput) modeInput.value = m;
      applyMode(m);
      document.querySelectorAll(".fx-seg__btn").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });

  document.querySelectorAll<HTMLButtonElement>("[data-theme-hex]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const hex = btn.getAttribute("data-theme-hex");
      if (!hex || !accentInput || !colorPicker) return;
      accentInput.value = hex;
      colorPicker.value = hex;
      applyFullTheme(hex);
      document.querySelectorAll(".fx-theme-preset").forEach((b) => b.classList.remove("is-active"));
      btn.classList.add("is-active");
    });
  });

  colorPicker?.addEventListener("input", () => {
    const v = colorPicker.value;
    if (accentInput) accentInput.value = v;
    applyFullTheme(v);
    document.querySelectorAll(".fx-theme-preset").forEach((b) => {
      const h = b.getAttribute("data-theme-hex");
      b.classList.toggle("is-active", h?.toLowerCase() === v.toLowerCase());
    });
  });

  document.querySelector<HTMLButtonElement>("#btn-teller")?.addEventListener("click", () => {
    void startTellerConnect();
  });

  document.querySelector<HTMLButtonElement>("#btn-refresh")?.addEventListener("click", () => {
    void refreshBankData();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pick-account]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-pick-account");
      if (!id) return;
      state.selectedAccountId = id;
      void loadTransactions();
    });
  });
}

async function init() {
  app.innerHTML = renderBoot();
  applyFullTheme(null);

  try {
    // If user lands from a password recovery email, Supabase will detect tokens in URL.
    // We also surface the recovery UI so the user can set a new password.
    const hash = window.location.hash.startsWith("#") ? window.location.hash.slice(1) : window.location.hash;
    const hashParams = new URLSearchParams(hash);
    const flowType = hashParams.get("type") || hashParams.get("flow_type");
    state.recoveryMode = flowType === "recovery";
    if (state.recoveryMode) state.authModalOpen = true;

    const { data } = await supabase.auth.getSession();
    state.session = data.session;
    if (state.session?.user) {
      try {
        await loadProfile(state.session.user.id);
        await refreshBankData();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
    }
    render();

    supabase.auth.onAuthStateChange(async (_evt, session) => {
      state.session = session;
      state.error = null;
      state.info = null;
      if (session?.user) {
        try {
          await loadProfile(session.user.id);
          await refreshBankData();
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
        }
      } else {
        state.profile = null;
        state.accounts = [];
        state.transactions = [];
      }
      render();
    });
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    render();
  }

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || state.session || !state.authModalOpen) return;
    e.preventDefault();
    closeAuthModal();
  });
}

void init();
