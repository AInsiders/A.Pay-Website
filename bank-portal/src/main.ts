import "./styles.css";
import { isSupabaseConfigured, supabase } from "./supabase";
import type { TellerEnrollmentPayload } from "./teller";

type Profile = {
  id: string;
  display_name: string | null;
  accent_color: string | null;
};

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
};

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Cleans pointer/scroll listeners when leaving the guest landing view. */
let landingParallaxTeardown: (() => void) | null = null;

const DEFAULT_ACCENT = "#5ee7ff";

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
    applyFullTheme(state.profile.accent_color);
    return;
  }
  const email = state.session?.user.email ?? "you";
  const insert = {
    id: userId,
    display_name: email.split("@")[0] ?? "User",
    accent_color: DEFAULT_ACCENT,
  };
  const { data: created, error: insErr } = await supabase.from("profiles").insert(insert).select().single();
  if (insErr) throw insErr;
  state.profile = created as Profile;
  applyFullTheme(insert.accent_color);
}

async function saveProfile(partial: Partial<Pick<Profile, "display_name" | "accent_color">>) {
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
  const { data, error } = await supabase.functions.invoke("teller-data", {
    body: { action: "accounts" },
  });
  state.busy = false;
  if (error) {
    state.error = error.message;
    state.accounts = [];
    render();
    return;
  }
  const payload = data as { accounts?: unknown[]; error?: string };
  if (payload?.error) {
    state.error = payload.error;
    state.accounts = [];
    render();
    return;
  }
  state.accounts = payload.accounts ?? [];
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
  const { data, error } = await supabase.functions.invoke("teller-data", {
    body: { action: "transactions", accountId: state.selectedAccountId },
  });
  state.busy = false;
  if (error) {
    state.error = error.message;
    state.transactions = [];
    render();
    return;
  }
  const payload = data as { transactions?: unknown[]; error?: string };
  if (payload?.error) {
    state.error = payload.error;
    state.transactions = [];
    render();
    return;
  }
  state.transactions = payload.transactions ?? [];
  render();
}

async function fetchNonce(): Promise<string> {
  const { data, error } = await supabase.functions.invoke("teller-nonce", { body: {} });
  if (error) throw new Error(error.message);
  const n = (data as { nonce?: string })?.nonce;
  if (!n) throw new Error("No nonce returned");
  return n;
}

function tellerEnvironment(): string {
  return import.meta.env.VITE_TELLER_ENVIRONMENT || "sandbox";
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
  if (!window.TellerConnect?.setup) {
    state.error = "Teller Connect failed to load.";
    render();
    return;
  }
  state.busy = true;
  state.error = null;
  render();
  let nonce: string;
  try {
    nonce = await fetchNonce();
  } catch (e) {
    state.busy = false;
    state.error = e instanceof Error ? e.message : String(e);
    render();
    return;
  }
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
      const { error } = await supabase.functions.invoke("teller-enrollment-complete", {
        body: { nonce, environment: tellerEnvironment(), payload: enrollment },
      });
      state.busy = false;
      if (error) {
        state.error = error.message;
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
  });
  tc.open();
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
          <form id="form-signin" class="fx-auth-modal__form list">
            <label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@email.com" /></label>
            <label class="field">Password<input name="password" type="password" autocomplete="current-password" required placeholder="••••••••" /></label>
            <div class="row row--stretch">
              <button type="submit" class="fx-btn-block" ${state.busy ? "disabled" : ""}>Enter A.Pay</button>
              <button type="button" class="secondary fx-btn-block" id="btn-signup" ${state.busy ? "disabled" : ""}>Create account</button>
            </div>
            ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
            ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
          </form>
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

        <div class="fx-layout fx-layout--split">
          <div class="fx-stack">
            <section class="fx-panel fx-panel--highlight">
              <p class="fx-eyebrow">Your profile</p>
              <h2>Make A.Pay yours</h2>
              <p class="muted">How you appear in the app and the accent color for your personal “million-dollar” dashboard vibe.</p>
              <form id="form-profile" class="list">
                <label class="field">Display name<input name="display_name" type="text" value="${escapeHtml(profile?.display_name ?? "")}" placeholder="First name or nickname" /></label>
                <input type="hidden" name="accent_color" id="field-accent" value="${escapeHtml(accent)}" />
                <div class="row" style="margin-top:4px">
                  <button type="submit" ${state.busy ? "disabled" : ""}>Save profile</button>
                </div>
                ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
                ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
              </form>
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
                Connect with Teller so deposits, bills, and spending show up where you’re planning. Start in
                <strong>sandbox</strong> until your Teller app is in development or production.
              </p>
              <div class="row">
                <button type="button" id="btn-teller" ${state.busy ? "disabled" : ""}>Connect my bank</button>
                <button type="button" class="secondary" id="btn-refresh" ${state.busy ? "disabled" : ""}>Refresh data</button>
              </div>
              ${state.error && state.accounts.length === 0 ? `<p class="error" style="margin-top:12px">${escapeHtml(state.error)}</p>` : ""}
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
    applyFullTheme(accent_color);
    await saveProfile({ display_name: display_name || null, accent_color });
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
