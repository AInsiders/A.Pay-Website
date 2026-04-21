import "./styles.css";
import { invokeEdgeFunction, isSupabaseConfigured, resolvedSupabaseUrl, supabase } from "./supabase";
import {
  planAmountShort,
  plannerPlan,
  planNextActions,
  planProtectedAmount,
  planSafeLiquidity,
  planSafeToSpend,
  planWarnings,
  toPlannerStateRow,
  type PlannerPlan,
  type PlannerReserveAllocationLine,
  type PlannerStateRow,
} from "./planner-state";
import type { TellerEnrollmentPayload } from "./teller";
import {
  LEGAL_EFFECTIVE_DATE_DISPLAY,
  privacyPolicyProseHtml,
  termsOfServiceProseHtml,
} from "./legal-pages";

/** Edge → Teller can be slow (cold start + bank API). Avoid client-side fetch aborting too early. */
const TELLER_DATA_INVOKE_TIMEOUT_MS = 150_000;

type Profile = {
  id: string;
  display_name: string | null;
  accent_color: string | null;
  theme_mode?: "dark" | "light" | null;
};

type RouteId = "home" | "about" | "contact" | "privacy" | "terms" | "planner" | "bills" | "accounts" | "settings";

const APP_ONLY_ROUTES = new Set<RouteId>(["planner", "bills", "accounts", "settings"]);
const APP_PRIMARY_ROUTES = new Set<RouteId>(["home", "planner", "bills", "accounts", "settings"]);

function supabaseHostHint(): string {
  try {
    return new URL(resolvedSupabaseUrl).host;
  } catch {
    return resolvedSupabaseUrl;
  }
}

type EdgeErrorContext = {
  /** Supabase Edge Function name for clearer UI copy */
  edgeFunction?: string;
};

function formatAuthError(prefix: string, err: unknown, ctx?: EdgeErrorContext): string {
  const host = supabaseHostHint();
  const raw = err instanceof Error ? err.message || String(err) : String(err);

  let detail: string;
  if (/failed to fetch/i.test(raw)) {
    detail = `Failed to fetch. Often: network drop, CORS, wrong project URL, or ad-blocker. Confirm VITE_SUPABASE_URL points at this project (host: ${host}).`;
  } else if (/failed to send a request to the edge function/i.test(raw)) {
    detail = `Could not complete the request to Edge Functions at ${host}. Try: stable network, disable VPN/ad-block for this site, ensure the Supabase project is not paused, and do not open the app as file:// (use http://localhost:5173 for dev). Bank calls can take up to ${Math.round(TELLER_DATA_INVOKE_TIMEOUT_MS / 1000)}s — check DevTools → Network for the failing …/functions/v1/… URL and status.`;
  } else {
    detail = raw;
  }

  const lines: string[] = [`${prefix}: ${detail}`];
  if (ctx?.edgeFunction) {
    lines.push(`Edge function: ${ctx.edgeFunction}.`);
  }

  const combined = `${prefix} ${detail} ${raw}`;
  if (
    /cors|access-control|failed to send|failed to fetch|net::err_failed|401|403|unsupported jwt|verify jwt|jwt/i.test(
      combined,
    )
  ) {
    lines.push(
      `Tip: If you use GitHub Pages or see “CORS” with no response body, the API gateway may be rejecting the session JWT before your function runs. Redeploy with --no-verify-jwt and turn off Verify JWT for Teller functions in Supabase Dashboard (ES256 tokens). See SETUP.md.`,
    );
  }

  return lines.join("\n\n");
}

/** Supabase `functions.invoke` hides Edge Function JSON in `FunctionsHttpError.context` — unpack it. */
/** `teller-data` returns 400 when the user has not completed Teller Connect yet — not a sync failure. */
function isNoBankEnrollmentMessage(msg: string): boolean {
  return /No bank connection\. Run Teller Connect first\./i.test(msg.trim());
}

function formatEdgeFunctionJsonBody(body: Record<string, unknown>, status: number): string {
  const lines: string[] = [];
  const e0 = typeof body.error === "string" ? body.error.trim() : "";
  const m0 = typeof body.message === "string" ? body.message.trim() : "";
  const u0 = typeof body.msg === "string" ? body.msg.trim() : "";
  const main = e0 || m0 || u0;
  if (main) lines.push(main);

  const code = typeof body.code === "string" && body.code.trim() ? body.code.trim() : "";
  if (code && !main?.includes(code)) lines.push(`Code: ${code}`);

  const details = body.details;
  if (typeof details === "string" && details.trim()) {
    lines.push(`Details: ${details.trim()}`);
  } else if (details != null && typeof details === "object") {
    lines.push(`Details: ${JSON.stringify(details).slice(0, 500)}`);
  }

  const hint = typeof body.hint === "string" && body.hint.trim() ? body.hint.trim() : "";
  if (hint) lines.push(`Hint: ${hint}`);

  const sup = body.supabase;
  if (sup && typeof sup === "object" && sup !== null) {
    const s = sup as Record<string, unknown>;
    if (typeof s.code === "string" && s.code.trim()) lines.push(`Supabase code: ${s.code.trim()}`);
    if (typeof s.details === "string" && s.details.trim()) lines.push(`Supabase details: ${s.details.trim()}`);
    if (typeof s.hint === "string" && s.hint.trim()) lines.push(`Supabase hint: ${s.hint.trim()}`);
  }

  const head = lines.filter(Boolean).join("\n");
  if (!head) {
    if (status === 401) {
      return `HTTP ${status} — Unauthorized. Try signing out and back in. If this persists on a hosted site, ensure Edge Functions are deployed with --no-verify-jwt (ES256 session tokens).`;
    }
    if (status === 404) {
      return `HTTP ${status} — Function not found. Deploy it: supabase functions deploy <name> --no-verify-jwt`;
    }
    if (status === 403) {
      return `HTTP ${status} — Forbidden. Check gateway JWT / Verify JWT settings for this function.`;
    }
    return `HTTP ${status}`;
  }
  return `${head}\n(HTTP ${status})`;
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
            return formatEdgeFunctionJsonBody(body, status);
          } catch {
            return status ? `${text.slice(0, 600)} (HTTP ${status})` : text.slice(0, 600);
          }
        }
      } catch {
        /* fall through */
      }
      if (status) {
        return formatEdgeFunctionJsonBody({}, status);
      }
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

/**
 * Magic-link and password-reset redirects must land on the same path the app is served from
 * (e.g. GitHub Pages project site: /RepoName/). Using only `window.location.origin` drops the path.
 */
function authEmailRedirectUrl(): string {
  const base = import.meta.env.BASE_URL || "./";
  try {
    return new URL(base, window.location.href).href;
  } catch {
    return `${window.location.origin}/`;
  }
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
  plannerSnapshot: unknown | null;
  accounts: unknown[];
  transactions: unknown[];
  selectedAccountId: string | null;
  error: string | null;
  info: string | null;
  busy: boolean;
  /** True while re-fetching `planner_snapshots` from Supabase (planner tab / manual reload). */
  plannerSyncBusy: boolean;
  /** Last Supabase error when loading planner state (non-fatal; bank/profile may still work). */
  plannerLoadError: string | null;
  route: RouteId;
  /** Guest landing: sign-in modal visibility */
  authModalOpen: boolean;
  /** When user returned from a password recovery email link. */
  recoveryMode: boolean;
} = {
  session: null,
  profile: null,
  plannerSnapshot: null,
  accounts: [],
  transactions: [],
  selectedAccountId: null,
  error: null,
  info: null,
  busy: false,
  plannerSyncBusy: false,
  plannerLoadError: null,
  route: "home",
  authModalOpen: false,
  recoveryMode: false,
};

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Cleans pointer/scroll listeners when leaving the guest landing view. */
let landingParallaxTeardown: (() => void) | null = null;

const DEFAULT_ACCENT = "#5ee7ff";

function normalizeRouteId(v: string): RouteId {
  const raw = v.trim().toLowerCase();
  if (raw === "" || raw === "home") return "home";
  if (raw === "dashboard") return "home";
  if (raw === "planner" || raw === "plan" || raw === "calendar" || raw === "improve") return "planner";
  if (raw === "bills") return "bills";
  if (raw === "accounts" || raw === "profile" || raw === "transactions") return "accounts";
  if (raw === "settings" || raw === "edit") return "settings";
  if (raw === "about" || raw === "about-us" || raw === "aboutus") return "about";
  if (raw === "contact" || raw === "contact-us" || raw === "contactus") return "contact";
  if (raw === "privacy" || raw === "privacy-policy") return "privacy";
  if (raw === "terms" || raw === "terms-and-conditions" || raw === "terms-conditions") return "terms";
  return "home";
}

function readRouteFromHash(): RouteId {
  const h = window.location.hash.replace(/^#\/?/, "");
  return normalizeRouteId(h);
}

function setRoute(next: RouteId) {
  const target = next === "home" ? "#/" : `#/${next}`;
  if (window.location.hash === target) return;
  window.location.hash = target;
}

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
    state.error = formatAuthError("Bank sync", e, { edgeFunction: "teller-data" });
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
    state.error = formatAuthError("Transaction load", e, { edgeFunction: "teller-data" });
    state.transactions = [];
  } finally {
    state.busy = false;
    render();
  }
}

async function loadPlannerSnapshot() {
  state.plannerLoadError = null;
  if (!state.session?.user?.id) {
    state.plannerSnapshot = null;
    return;
  }
  const { data, error } = await supabase
    .from("planner_snapshots")
    .select(
      "id, user_id, plan, snapshot, created_at, updated_at, source_platform, source_app_version, source_updated_at, planner_schema_version, planner_engine_version",
    )
    .eq("user_id", state.session.user.id)
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    state.plannerLoadError = error.message;
    state.plannerSnapshot = null;
    return;
  }
  state.plannerSnapshot = data ?? null;
}

async function reloadPlannerFromSupabase() {
  if (!state.session?.user?.id) return;
  state.plannerSyncBusy = true;
  render();
  try {
    await loadPlannerSnapshot();
  } finally {
    state.plannerSyncBusy = false;
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
    throw new Error(formatAuthError("Teller nonce", e, { edgeFunction: "teller-nonce" }));
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
          const msg = await edgeFunctionMessage(error);
          state.error = formatAuthError("Bank link", new Error(msg), {
            edgeFunction: "teller-enrollment-complete",
          });
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

function navLink(route: RouteId, label: string, current: RouteId) {
  const href = route === "home" ? "#/" : `#/${route}`;
  const active = route === current ? " is-active" : "";
  return `<a class="fx-nav__link${active}" href="${href}" data-nav="${route}">${escapeHtml(label)}</a>`;
}

function renderPublicPage(route: RouteId) {
  switch (route) {
    case "about":
      return `
        <main class="fx-doc shell-narrow" role="main">
          <p class="fx-doc__eyebrow">About</p>
          <h1 class="fx-doc__title">A.Pay is a money plan that thinks ahead.</h1>
          <p class="fx-doc__lede">
            Most budgeting apps show charts after the fact. A.Pay forecasts forward—mapping paychecks to upcoming bills,
            prioritizing essentials, and keeping a clear “safe to spend” number front and center.
          </p>
          <div class="fx-doc__grid">
            <section class="fx-doc__card">
              <h2>Essentials-first planning</h2>
              <p class="muted">Upcoming bills and obligations get handled before “extra” money is counted as free.</p>
            </section>
            <section class="fx-doc__card">
              <h2>Paycheck-by-paycheck forecast</h2>
              <p class="muted">See what’s due next and how future paydays cover future bills—before the stress hits.</p>
            </section>
            <section class="fx-doc__card">
              <h2>Low effort, high clarity</h2>
              <p class="muted">Connect accounts with Teller and let real activity keep the forecast honest over time.</p>
            </section>
          </div>
          <div class="fx-doc__cta">
            <button type="button" class="fx-btn-hero js-open-auth">Sign in</button>
            <a class="fx-btn-hero-secondary" href="#/contact">Contact us</a>
          </div>
        </main>
      `;
    case "contact":
      return `
        <main class="fx-doc shell-narrow" role="main">
          <p class="fx-doc__eyebrow">Contact</p>
          <h1 class="fx-doc__title">Talk to the team.</h1>
          <p class="fx-doc__lede">Questions, bugs, partnerships, security—send a note and we’ll respond.</p>

          <div class="fx-doc__card">
            <form id="form-contact" class="list">
              <label class="field">
                Topic
                <select name="topic" required>
                  <option value="support">Support</option>
                  <option value="billing">Billing</option>
                  <option value="privacy">Privacy</option>
                  <option value="security">Security</option>
                  <option value="partnerships">Partnerships</option>
                </select>
              </label>
              <label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@email.com" /></label>
              <label class="field">Message<textarea name="message" rows="5" required placeholder="How can we help?"></textarea></label>
              <div class="row row--stretch">
                <button type="submit" class="fx-btn-block">Send message</button>
                <button type="button" class="secondary fx-btn-block js-open-auth">Sign in</button>
              </div>
              <p class="muted" style="margin:8px 0 0">For now this form is a UI placeholder. Hook it to email or a ticket system when you’re ready.</p>
            </form>
          </div>
        </main>
      `;
    case "privacy":
      return `
        <main class="fx-doc shell-narrow" role="main">
          <p class="fx-doc__eyebrow">Legal</p>
          <h1 class="fx-doc__title">Privacy Policy</h1>
          <p class="fx-doc__lede">
            How A.Pay collects, uses, and discloses information when you use the Services. Last updated ${LEGAL_EFFECTIVE_DATE_DISPLAY}.
            Have qualified counsel review before launch.
          </p>

          <div class="fx-doc__card fx-doc__prose">
            ${privacyPolicyProseHtml()}
          </div>
        </main>
      `;
    case "terms":
      return `
        <main class="fx-doc shell-narrow" role="main">
          <p class="fx-doc__eyebrow">Legal</p>
          <h1 class="fx-doc__title">Terms &amp; Conditions</h1>
          <p class="fx-doc__lede">
            Rules for using A.Pay. Last updated ${LEGAL_EFFECTIVE_DATE_DISPLAY}. Have qualified counsel review before launch.
          </p>

          <div class="fx-doc__card fx-doc__prose">
            ${termsOfServiceProseHtml()}
          </div>
        </main>
      `;
    case "home":
    default:
      return `
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
      `;
  }
}

function renderAuth() {
  const supabaseHost = (() => {
    try {
      return new URL(resolvedSupabaseUrl).host;
    } catch {
      return resolvedSupabaseUrl;
    }
  })();
  const disabled = state.busy || !isSupabaseConfigured;
  const route = state.route;
  const nav = `
    <nav class="fx-nav" aria-label="Primary">
      ${navLink("home", "Home", route)}
      ${navLink("about", "About", route)}
      ${navLink("contact", "Contact", route)}
      ${navLink("privacy", "Privacy", route)}
      ${navLink("terms", "Terms", route)}
    </nav>
  `;
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
          ${nav}
          <button type="button" class="fx-landing-header__link" id="btn-open-auth">Sign in</button>
        </div>
      </header>

      ${renderPublicPage(route)}

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
          <div class="fx-landing-footer__links" aria-label="Legal">
            <a href="#/privacy">Privacy</a>
            <a href="#/terms">Terms</a>
          </div>
        </div>
      </footer>

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

function appNavLink(route: RouteId, label: string, current: RouteId) {
  const active = current === route ? " is-active" : "";
  const href = route === "home" ? "#/" : `#/${route}`;
  return `<a class="fx-app-nav__link${active}" href="${href}" data-app-route="${route}">${escapeHtml(label)}</a>`;
}

function renderStringList(items: string[], emptyCopy: string) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyCopy)}</p>`;
  return `<ul class="fx-inline-list">${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

function renderDueRecommendationList(
  items: { label: string; amount: number; dueDate?: string; rationale?: string }[],
  emptyCopy: string,
) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyCopy)}</p>`;
  return `<div class="fx-mini-list">${items
    .map(
      (item) => `
        <article class="fx-mini-list__item">
          <div>
            <strong>${escapeHtml(item.label)}</strong>
            <p>${escapeHtml(item.rationale ?? item.dueDate ?? "No extra detail yet.")}</p>
          </div>
          <span>${money(item.amount)}</span>
        </article>
      `,
    )
    .join("")}</div>`;
}

function renderTimelineList(
  items: { date?: string; payerLabel?: string; usableAmount?: number; amountLeftAfterAllocations?: number; allocations?: { label: string; amount: number }[] }[],
  emptyCopy: string,
) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyCopy)}</p>`;
  return `<div class="fx-timeline-list">${items
    .map((item) => {
      const allocations = (item.allocations ?? []).slice(0, 4);
      return `
        <article class="fx-timeline-card">
          <div class="fx-timeline-card__top">
            <div>
              <strong>${escapeHtml(item.payerLabel ?? "Paycheck")}</strong>
              <p>${escapeHtml(item.date ?? "No date")}</p>
            </div>
            <div class="fx-timeline-card__amount">
              <strong>${money(item.usableAmount ?? 0)}</strong>
              <p>usable</p>
            </div>
          </div>
          <div class="fx-timeline-card__allocations">
            ${allocations.length
              ? allocations.map((allocation) => `<span>${escapeHtml(allocation.label)} · ${money(allocation.amount)}</span>`).join("")
              : `<span>No allocations captured.</span>`}
          </div>
          <p class="muted">Left after allocations: <strong>${money(item.amountLeftAfterAllocations ?? 0)}</strong></p>
        </article>
      `;
    })
    .join("")}</div>`;
}

function renderReserveHoldList(items: PlannerReserveAllocationLine[], emptyCopy: string) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyCopy)}</p>`;
  return `<div class="fx-mini-list">${items
    .map((item) => {
      const meta = [item.dueDate, item.sourcePayDate ? `Reserve from ${item.sourcePayDate}` : ""].filter(Boolean).join(" · ");
      return `
        <article class="fx-mini-list__item">
          <div>
            <strong>${escapeHtml(item.label)}</strong>
            <p>${escapeHtml(meta || "Held in reserve toward an obligation.")}</p>
          </div>
          <span>${money(item.amount)}</span>
        </article>
      `;
    })
    .join("")}</div>`;
}

function renderDebtSummaryList(plan: PlannerPlan) {
  const rows = plan.debtSummary ?? [];
  if (!rows.length) return `<p class="muted">No debt summary lines in this plan snapshot.</p>`;
  return `<div class="fx-mini-list">${rows
    .map(
      (d) => `
      <article class="fx-mini-list__item">
        <div><strong>${escapeHtml(d.label)}</strong><p>Balance remaining</p></div>
        <span>${money(d.balanceLeft)}</span>
      </article>
    `,
    )
    .join("")}</div>`;
}

function renderGoalProgressGrid(plan: PlannerPlan) {
  const goals = plan.goalProgress ?? [];
  if (!goals.length) return `<p class="muted">No savings or goal progress in this snapshot.</p>`;
  return `<div class="fx-goal-grid">${goals
    .map(
      (g) => `
      <article class="fx-goal-card">
        <p class="fx-goal-card__label">${escapeHtml(g.label)}</p>
        <p class="fx-goal-card__amt">${money(g.currentAmount)} <span class="muted">/ ${money(g.targetAmount)}</span></p>
        <div class="fx-goal-card__bar" role="presentation" aria-hidden="true">
          <span style="width:${Math.round(Math.min(1, Math.max(0, g.progressRatio)) * 100)}%"></span>
        </div>
        <p class="muted fx-goal-card__meta">${money(g.remainingAmount)} to go · ~${g.paychecksNeeded ?? "—"} paychecks</p>
      </article>
    `,
    )
    .join("")}</div>`;
}

function renderSignedInInfoPage(route: RouteId) {
  switch (route) {
    case "privacy":
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">Legal</p>
          <h2>Privacy Policy</h2>
          <p class="muted">Last updated ${LEGAL_EFFECTIVE_DATE_DISPLAY}. Counsel review recommended before launch.</p>
          <div class="fx-doc__card fx-doc__prose" style="margin-top:14px">
            ${privacyPolicyProseHtml()}
          </div>
        </section>
      `;
    case "terms":
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">Legal</p>
          <h2>Terms &amp; Conditions</h2>
          <p class="muted">Last updated ${LEGAL_EFFECTIVE_DATE_DISPLAY}. Counsel review recommended before launch.</p>
          <div class="fx-doc__card fx-doc__prose" style="margin-top:14px">
            ${termsOfServiceProseHtml()}
          </div>
        </section>
      `;
    case "about":
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">About</p>
          <h2>One planner, many platforms</h2>
          <p class="muted">The canonical planning engine lives in BillPayer shared Kotlin code. This website renders the same plan through Supabase-backed state.</p>
        </section>
      `;
    case "contact":
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">Contact</p>
          <h2>Support</h2>
          <p class="muted">Wire this to email or a helpdesk when you are ready for production support.</p>
        </section>
      `;
    default:
      return "";
  }
}

function renderAppHome(plannerState: PlannerStateRow | null, plan: PlannerPlan | null) {
  if (!plan) {
    return `
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">Home</p>
        <h2>No synced planner yet</h2>
        <p class="muted">Supabase auth, database, and bank connections are ready. Next step is syncing BillPayer’s deterministic <code>PlannerSnapshot</code> and <code>PlannerPlan</code> into <code>planner_snapshots</code> so the web app can render the same safe-to-spend and timeline.</p>
      </section>
    `;
  }

  const safe = planSafeToSpend(plan);
  const protectedTotal = planProtectedAmount(plan);
  const shortAmount = planAmountShort(plan);
  const warnings = planWarnings(plan);
  const nextActions = planNextActions(plan);
  const nextPaycheck = plan.nextPaycheckNeed;
  const scenarioSummaries = plan.scenarioSummaries ?? [];

  return `
    <section class="fx-app-hero fx-panel fx-panel--highlight">
      <div>
        <p class="fx-eyebrow">Home</p>
        <h1>Safe to spend</h1>
        <p class="fx-app-hero__value">${money(safe)}</p>
        <p class="muted">Deterministic result from the BillPayer shared planner, synced through Supabase.</p>
      </div>
      <div class="fx-app-hero__meta">
        <span>Protected: <strong>${money(protectedTotal)}</strong></span>
        <span>Short: <strong>${money(shortAmount)}</strong></span>
        <span>Mode: <strong>${escapeHtml(plan.selectedScenarioMode ?? "FIXED")}</strong></span>
      </div>
      ${scenarioSummaries.length
        ? `<div class="fx-scenario-strip">${scenarioSummaries
            .slice(0, 4)
            .map(
              (summary) => `<span class="fx-scenario-pill${summary.feasible ? "" : " is-risk"}">${escapeHtml(summary.label)} · ${
                summary.feasible ? "working" : "short"
              }</span>`,
            )
            .join("")}</div>`
        : ""}
    </section>

    <div class="fx-metric-grid">
      <section class="fx-metric-card">
        <p class="fx-metric-card__label">Next paycheck need</p>
        <strong>${money(nextPaycheck?.targetToStayOnPlan ?? 0)}</strong>
        <p>${escapeHtml(nextPaycheck?.coverageSummary ?? "No paycheck guidance available yet.")}</p>
      </section>
      <section class="fx-metric-card">
        <p class="fx-metric-card__label">Survival floor</p>
        <strong>${money(nextPaycheck?.minimumToSurvive ?? 0)}</strong>
        <p>Minimum needed to stay protected.</p>
      </section>
      <section class="fx-metric-card">
        <p class="fx-metric-card__label">Ideal accelerate</p>
        <strong>${money(nextPaycheck?.idealToAccelerate ?? 0)}</strong>
        <p>Optional upside for faster catch-up or debt payoff.</p>
      </section>
    </div>

    <div class="fx-layout fx-layout--split">
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Warnings</p>
          <h2>What needs attention</h2>
          ${renderStringList(warnings, "No active warnings.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Pay now</p>
          <h2>Must be handled next</h2>
          ${renderDueRecommendationList(plan.whatMustBePaidNow ?? [], "No immediate pay-now items.")}
        </section>
      </div>
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Suggested actions</p>
          <h2>Best next moves</h2>
          ${renderStringList(nextActions, "No next-action suggestions yet.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Due soon</p>
          <h2>Upcoming protected load</h2>
          ${renderDueRecommendationList(plan.dueSoon ?? [], "Nothing due soon right now.")}
        </section>
      </div>
    </div>

    <section class="fx-panel">
      <p class="fx-eyebrow">Planner source</p>
      <h2>Synced state</h2>
      <p class="muted">Updated <strong>${escapeHtml(plannerState?.updated_at ?? "—")}</strong> from <strong>${escapeHtml(plannerState?.source_platform ?? "unknown")}</strong> using schema <strong>${escapeHtml(plannerState?.planner_schema_version ?? "billpayer-shared-v1")}</strong>.</p>
    </section>
  `;
}

function renderPlannerWorkspace(plannerState: PlannerStateRow | null, plan: PlannerPlan | null) {
  const syncDisabled = state.plannerSyncBusy || state.busy;
  const loadErr = state.plannerLoadError
    ? `<div class="banner banner--alert" role="alert">${escapeHtml(state.plannerLoadError)}</div>`
    : "";

  if (!plan) {
    return `
      <div class="fx-stack fx-stack--planner">
        ${loadErr}
        <section class="fx-panel fx-panel--highlight">
          <div class="fx-planner-head__row">
            <div>
              <p class="fx-eyebrow">Planner</p>
              <h2>Connect Supabase + sync a plan row</h2>
              <p class="muted">
                This screen reads your latest <code>planner_snapshots</code> row for your user id (JSON <code>plan</code> column = BillPayer <code>PlannerPlan</code>).
                Math stays on the shared engine; the web app only renders what Postgres returns.
              </p>
            </div>
            <div class="fx-planner-head__actions">
              <button type="button" class="secondary" id="btn-refresh-planner" ${syncDisabled ? "disabled" : ""}>${state.plannerSyncBusy ? "Loading…" : "Reload from Supabase"}</button>
            </div>
          </div>
        </section>
      </div>
    `;
  }

  const dash = plan.dashboard;
  const safe = planSafeToSpend(plan);
  const protectedTotal = planProtectedAmount(plan);
  const shortAmount = planAmountShort(plan);
  const liquidity = planSafeLiquidity(plan);
  const warnings = planWarnings(plan);
  const nextActions = planNextActions(plan);
  const nextPaycheck = plan.nextPaycheckNeed;
  const scenarioSummaries = plan.scenarioSummaries ?? [];

  return `
    <div class="fx-stack fx-stack--planner">
      ${loadErr}
      <section class="fx-panel fx-panel--highlight">
        <div class="fx-planner-head__row">
          <div>
            <p class="fx-eyebrow">Planner · from Supabase</p>
            <h2>Safe to spend</h2>
            <p class="fx-app-hero__value">${money(safe)}</p>
            <p class="muted">Row updated <strong>${escapeHtml(plannerState?.updated_at ?? "—")}</strong> · platform <strong>${escapeHtml(plannerState?.source_platform ?? "unknown")}</strong> · schema <strong>${escapeHtml(plannerState?.planner_schema_version ?? "billpayer-shared-v1")}</strong></p>
          </div>
          <div class="fx-planner-head__actions">
            <button type="button" class="secondary" id="btn-refresh-planner" ${syncDisabled ? "disabled" : ""}>${state.plannerSyncBusy ? "Syncing…" : "Reload from Supabase"}</button>
            <p class="muted">Engine recalc: <strong>${escapeHtml(plan.lastRecalculatedAt ?? plannerState?.source_updated_at ?? "—")}</strong></p>
          </div>
        </div>
        <div class="fx-app-hero__meta">
          <span>Protected: <strong>${money(protectedTotal)}</strong></span>
          <span>Short: <strong>${money(shortAmount)}</strong></span>
          <span>Liquidity: <strong>${money(liquidity)}</strong></span>
          <span>Scenario: <strong>${escapeHtml(plan.selectedScenarioMode ?? "FIXED")}</strong></span>
        </div>
        ${scenarioSummaries.length
          ? `<div class="fx-scenario-strip">${scenarioSummaries
              .slice(0, 6)
              .map(
                (summary) =>
                  `<span class="fx-scenario-pill${summary.feasible ? "" : " is-risk"}">${escapeHtml(summary.label)} · ${
                    summary.feasible ? "feasible" : "tight"
                  }</span>`,
              )
              .join("")}</div>`
          : ""}
      </section>

      <div class="fx-metric-grid">
        <section class="fx-metric-card">
          <p class="fx-metric-card__label">Target (stay on plan)</p>
          <strong>${money(nextPaycheck?.targetToStayOnPlan ?? 0)}</strong>
          <p>${escapeHtml(nextPaycheck?.coverageSummary ?? "Next paycheck coverage")}</p>
        </section>
        <section class="fx-metric-card">
          <p class="fx-metric-card__label">Survival floor</p>
          <strong>${money(nextPaycheck?.minimumToSurvive ?? 0)}</strong>
          <p>Minimum before discretionary spend.</p>
        </section>
        <section class="fx-metric-card">
          <p class="fx-metric-card__label">Accelerate</p>
          <strong>${money(nextPaycheck?.idealToAccelerate ?? 0)}</strong>
          <p>Optional push for catch-up / debt.</p>
        </section>
      </div>

      <div class="fx-planner-obligations">
        <section class="fx-panel">
          <p class="fx-eyebrow">Dashboard · overdue</p>
          <h2>Overdue now</h2>
          ${renderDueRecommendationList(dash?.overdueNow ?? [], "Nothing flagged overdue in this snapshot.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Dashboard · today</p>
          <h2>Due today</h2>
          ${renderDueRecommendationList(dash?.dueToday ?? [], "Nothing due today in this snapshot.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Dashboard · before next pay</p>
          <h2>Before next paycheck</h2>
          ${renderDueRecommendationList(dash?.dueBeforeNextPaycheck ?? [], "No items in this bucket.")}
        </section>
      </div>

      <div class="fx-layout fx-layout--split">
        <div class="fx-stack">
          <section class="fx-panel">
            <p class="fx-eyebrow">Guidance</p>
            <h2>Warnings</h2>
            ${renderStringList(warnings, "No planner warnings.")}
          </section>
          <section class="fx-panel">
            <p class="fx-eyebrow">Guidance</p>
            <h2>Best next moves</h2>
            ${renderStringList(nextActions, "No suggested actions in this plan.")}
          </section>
          <section class="fx-panel">
            <p class="fx-eyebrow">Reserves</p>
            <h2>Cash held back</h2>
            ${renderReserveHoldList(dash?.reservesHeld ?? [], "No reserve lines in this snapshot.")}
          </section>
        </div>
        <div class="fx-stack">
          <section class="fx-panel fx-panel--highlight">
            <p class="fx-eyebrow">Paycheck window</p>
            <h2>Current paycheck card</h2>
            ${renderTimelineList(plan.currentPaycheckCard ? [plan.currentPaycheckCard] : [], "No current paycheck card.")}
          </section>
          <section class="fx-panel">
            <p class="fx-eyebrow">Timeline</p>
            <h2>Upcoming paychecks</h2>
            ${renderTimelineList(plan.timeline?.slice(0, 10) ?? [], "No timeline rows yet.")}
          </section>
        </div>
      </div>

      <div class="fx-layout fx-layout--split">
        <section class="fx-panel">
          <p class="fx-eyebrow">Pay flow</p>
          <h2>Must pay now</h2>
          ${renderDueRecommendationList(plan.whatMustBePaidNow ?? [], "No immediate must-pay items.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Pay flow</p>
          <h2>Due soon</h2>
          ${renderDueRecommendationList(plan.dueSoon ?? [], "Nothing in the due-soon list.")}
        </section>
      </div>

      <section class="fx-panel">
        <p class="fx-eyebrow">Goals</p>
        <h2>Goal progress</h2>
        ${renderGoalProgressGrid(plan)}
      </section>

      <div class="fx-layout fx-layout--split">
        <section class="fx-panel">
          <p class="fx-eyebrow">Debt</p>
          <h2>Balances from plan</h2>
          ${renderDebtSummaryList(plan)}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Forecast</p>
          <h2>Catch-up signals</h2>
          ${renderStringList(
            (plan.catchUpAnalytics ?? []).slice(0, 8).map((item) => {
              const extra = item.impactIfExtraMoneyAdded ? ` · ${item.impactIfExtraMoneyAdded}` : "";
              return `${item.label}: ${item.projectedCatchUpDate ?? "pending"}${extra}`;
            }),
            "No catch-up analytics in this snapshot.",
          )}
        </section>
      </div>

      <section class="fx-panel">
        <p class="fx-eyebrow">Engine metadata</p>
        <h2>Planner run</h2>
        <div class="fx-inline-list fx-inline-list--plain">
          <li>Last trigger: <strong>${escapeHtml(plan.lastTrigger ?? "—")}</strong></li>
          <li>Debt-free date: <strong>${escapeHtml(plan.debtFreeDate ?? "—")}</strong></li>
          <li>Ending planning cash: <strong>${money(plan.endingPlanningCash ?? 0)}</strong></li>
          <li>Extra payoff (safe): <strong>${money(plan.safeExtraPayoffAmount ?? 0)}</strong></li>
          <li>Overdue remaining (live): <strong>${money(plan.liveOverdueRemainingTotal ?? 0)}</strong></li>
          <li>Engine version: <strong>${escapeHtml(plannerState?.planner_engine_version ?? "—")}</strong></li>
        </div>
      </section>
    </div>
  `;
}

function renderBillsWorkspace(plan: PlannerPlan | null) {
  if (!plan) {
    return `
      <section class="fx-panel">
        <p class="fx-eyebrow">Bills</p>
        <h2>No planner-backed bill data yet</h2>
        <p class="muted">This page will render the same due-now, due-soon, overdue, and delayable lists the Android app already computes.</p>
      </section>
    `;
  }

  return `
    <div class="fx-layout fx-layout--split">
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Bills</p>
          <h2>Must pay now</h2>
          ${renderDueRecommendationList(plan.whatMustBePaidNow ?? [], "No must-pay items right now.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Due soon</p>
          <h2>Protected upcoming items</h2>
          ${renderDueRecommendationList(plan.dueSoon ?? [], "Nothing urgent coming up.")}
        </section>
      </div>
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Delay options</p>
          <h2>What can wait</h2>
          ${renderDueRecommendationList(plan.whatCanBeDelayed ?? [], "No delay candidates.")}
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Non-payday obligations</p>
          <h2>Carry-forward + reserves</h2>
          ${renderDueRecommendationList(
            (plan.nonPaydayObligations ?? []).map((item) => ({
              label: item.label,
              amount: item.remainingAmount ?? item.amount,
              dueDate: item.effectiveDueDate,
              rationale: `${item.status ?? "PLANNED"}${item.daysOverdue ? ` · ${item.daysOverdue}d overdue` : ""}`,
            })),
            "No non-payday obligations queued.",
          )}
        </section>
      </div>
    </div>
  `;
}

function renderAccountsWorkspace(
  rows: string[],
  txRows: string[],
  tellerReady: boolean,
  busy: boolean,
  stateError: string | null,
) {
  return `
    <section class="fx-panel">
      <p class="fx-eyebrow">Accounts</p>
      <h2>Connect and refresh real balances</h2>
      <p class="muted">This is the Supabase + Teller layer from the website stack. It remains the shared backend entrypoint while the planner stays canonical in BillPayer.</p>
      <div class="row">
        <button type="button" id="btn-teller" ${busy ? "disabled" : ""}>Connect my bank</button>
        <button type="button" class="secondary" id="btn-refresh" ${busy ? "disabled" : ""}>Refresh data</button>
      </div>
      ${
        !tellerReady
          ? `<p class="error" style="margin-top:12px">Bank link needs <strong>VITE_TELLER_APP_ID</strong> in <code>bank-portal/.env</code> (restart dev or rebuild; required at build time for production).</p>`
          : ""
      }
      ${stateError && rows.length === 0 ? `<p class="error" style="margin-top:12px">${escapeHtml(stateError)}</p>` : ""}
    </section>

    <div class="fx-layout fx-layout--split">
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Accounts</p>
          <h2>Linked money sources</h2>
          ${rows.length ? `<div class="list">${rows.join("")}</div>` : `<p class="muted">Link a bank above to see checking, savings, and more—where your paychecks actually land.</p>`}
        </section>
      </div>
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Activity</p>
          <h2>Transactions</h2>
          <div class="tx-feed">
            ${txRows.length ? txRows.join("") : `<p class="muted" style="padding:16px;margin:0">Connect an account and pick it above to load your stream.</p>`}
          </div>
        </section>
      </div>
    </div>
  `;
}

function renderSettingsWorkspace(
  profile: Profile | null,
  accent: string,
  mode: "dark" | "light",
  busy: boolean,
  plannerState: PlannerStateRow | null,
) {
  return `
    <div class="fx-layout fx-layout--split">
      <div class="fx-stack">
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">Settings</p>
          <h2>Profile + appearance</h2>
          <p class="muted">Keep the Supabase profile layer and theme settings in one place while the deterministic planner stays read-only.</p>
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
              <button type="submit" ${busy ? "disabled" : ""}>Save profile</button>
            </div>
            ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
          </form>
        </section>

        <section class="fx-panel">
          <p class="fx-eyebrow">Theme</p>
          <h2>Vault colors</h2>
          <p class="muted">Presets inspired by cash, bullion, and momentum—or dial in your own accent.</p>
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
          <p class="fx-eyebrow">Planner sync</p>
          <h2>Canonical state contract</h2>
          <div class="fx-inline-list fx-inline-list--plain">
            <li>Schema: <strong>${escapeHtml(plannerState?.planner_schema_version ?? "billpayer-shared-v1")}</strong></li>
            <li>Engine: <strong>${escapeHtml(plannerState?.planner_engine_version ?? "not recorded")}</strong></li>
            <li>Platform: <strong>${escapeHtml(plannerState?.source_platform ?? "unknown")}</strong></li>
            <li>App version: <strong>${escapeHtml(plannerState?.source_app_version ?? "unknown")}</strong></li>
            <li>Source updated: <strong>${escapeHtml(plannerState?.source_updated_at ?? plannerState?.updated_at ?? "—")}</strong></li>
          </div>
          <p class="muted">The website should render the same planner output the BillPayer shared engine already computed, instead of inventing parallel math here.</p>
        </section>
      </div>
    </div>
  `;
}

function renderApp() {
  const profile = state.profile;
  const accent = profile?.accent_color ?? DEFAULT_ACCENT;
  const mode = profile?.theme_mode === "light" ? "light" : "dark";
  const plannerState = toPlannerStateRow(state.plannerSnapshot);
  const plan = plannerPlan(plannerState);
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

  const routeForNav = APP_PRIMARY_ROUTES.has(state.route) ? state.route : "home";
  const appNav = `
    <nav class="fx-app-nav" aria-label="App navigation">
      ${appNavLink("home", "Home", routeForNav)}
      ${appNavLink("planner", "Planner", routeForNav)}
      ${appNavLink("bills", "Bills", routeForNav)}
      ${appNavLink("accounts", "Accounts", routeForNav)}
      ${appNavLink("settings", "Settings", routeForNav)}
    </nav>
  `;

  const routeBody =
    state.route === "planner"
      ? renderPlannerWorkspace(plannerState, plan)
      : state.route === "bills"
        ? renderBillsWorkspace(plan)
        : state.route === "accounts"
          ? renderAccountsWorkspace(rows, txRows, tellerConfigured(), state.busy, state.error)
          : state.route === "settings"
            ? renderSettingsWorkspace(profile, accent, mode, state.busy, plannerState)
            : state.route === "privacy" || state.route === "terms" || state.route === "about" || state.route === "contact"
              ? renderSignedInInfoPage(state.route)
              : renderAppHome(plannerState, plan);

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
          ${appNav}
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
        ${routeBody}
        <footer class="fx-app-footer">
          <a href="#/privacy">Privacy</a>
          <a href="#/terms">Terms</a>
          <span>Planner truth: BillPayer shared engine · Backend truth: Supabase</span>
        </footer>
      </div>
    </div>
  `;
}

function render() {
  landingParallaxTeardown?.();
  landingParallaxTeardown = null;

  state.route = readRouteFromHash();

  if (!state.session && APP_ONLY_ROUTES.has(state.route)) {
    state.authModalOpen = true;
    state.route = "home";
    if (window.location.hash !== "#/" && window.location.hash !== "") {
      window.location.hash = "#/";
    }
  }

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
  if (state.route === "home") bindLandingParallax();

  document.getElementById("btn-hero-cta")?.addEventListener("click", () => openAuthModal());
  document.getElementById("btn-open-auth")?.addEventListener("click", () => openAuthModal());
  document.querySelectorAll<HTMLElement>(".js-open-auth").forEach((el) => {
    el.addEventListener("click", () => openAuthModal());
  });

  // If you navigate away from Home while modal is open, keep it usable.
  document.querySelectorAll<HTMLAnchorElement>("[data-nav]").forEach((a) => {
    a.addEventListener("click", () => {
      // Close modal when navigating between content pages (user intent is reading).
      if (!state.recoveryMode) state.authModalOpen = false;
    });
  });

  document.querySelector<HTMLFormElement>("#form-contact")?.addEventListener("submit", (e) => {
    e.preventDefault();
    state.info = "Message queued (wire this form to email/tickets when ready).";
    state.error = null;
    render();
    setTimeout(() => {
      state.info = null;
      render();
    }, 2200);
  });

  document.getElementById("auth-modal-backdrop")?.addEventListener("click", () => closeAuthModal());
  document.getElementById("auth-modal-close")?.addEventListener("click", () => closeAuthModal());

  const form = document.querySelector<HTMLFormElement>("#form-signin");
  const signup = document.querySelector<HTMLButtonElement>("#btn-signup");
  const magic = document.querySelector<HTMLButtonElement>("#btn-magiclink");
  const forgot = document.querySelector<HTMLButtonElement>("#btn-forgot");
  const recoveryForm = document.querySelector<HTMLFormElement>("#form-recovery");

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
    const { data, error } = await supabase.auth.signInWithPassword({ email, password });
    state.busy = false;
    if (error) {
      state.error = formatAuthError("Sign in", error);
      state.authModalOpen = true;
      render();
      return;
    }
    if (data.session) {
      state.session = data.session;
      state.authModalOpen = false;
      state.error = null;
      try {
        await loadProfile(data.session.user.id);
        await refreshBankData();
      } catch (e) {
        state.error = e instanceof Error ? e.message : String(e);
      }
      render();
    } else {
      state.info =
        "No active session returned. If your project requires email confirmation, open the link in your email first, then try again.";
      state.authModalOpen = true;
      render();
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
      options: { emailRedirectTo: authEmailRedirectUrl() },
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
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: authEmailRedirectUrl(),
    });
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
    const { data, error } = await supabase.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: authEmailRedirectUrl() },
    });
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
    state.plannerSnapshot = null;
    state.plannerLoadError = null;
    state.plannerSyncBusy = false;
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

  document.querySelector<HTMLButtonElement>("#btn-refresh-planner")?.addEventListener("click", () => {
    void reloadPlannerFromSupabase();
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
        await loadPlannerSnapshot();
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
        state.authModalOpen = false;
        try {
          await loadProfile(session.user.id);
          await loadPlannerSnapshot();
          await refreshBankData();
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
        }
      } else {
        state.profile = null;
        state.plannerSnapshot = null;
        state.plannerLoadError = null;
        state.plannerSyncBusy = false;
        state.accounts = [];
        state.transactions = [];
      }
      render();
    });
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    render();
  }

  window.addEventListener("hashchange", () => {
    render();
    if (state.session?.user && state.route === "planner") {
      void reloadPlannerFromSupabase();
    }
  });

  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape" || state.session || !state.authModalOpen) return;
    e.preventDefault();
    closeAuthModal();
  });
}

void init();
