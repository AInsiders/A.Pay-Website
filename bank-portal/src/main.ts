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
import type { PlannerSnapshot } from "./planner-engine-shared";
import {
  currentUserId,
  deleteBill,
  deleteDebt,
  deleteGoal,
  deleteIncomeSource,
  deleteRecurringExpense,
  importLegacySnapshotIntoNormalized,
  loadPlannerSnapshot as loadNormalizedSnapshot,
  recomputeAndPersistPlan,
  saveBill,
  saveDebt,
  saveGoal,
  saveHousingConfig,
  saveIncomeSource,
  savePlannerSettings,
  saveRecurringExpense,
  saveTransactionCategorization,
  linkTransactionToPlannerActual,
  deleteTransactionLinkedActuals,
  type PlannerActualTarget,
} from "./planner-data";
import {
  normalizeTellerTransactions,
  persistAutoCategorizedTransactions,
} from "./transaction-autocategorize";

/** Edge → Teller can be slow (cold start + bank API). Avoid client-side fetch aborting too early. */
const TELLER_DATA_INVOKE_TIMEOUT_MS = 150_000;

type Profile = {
  id: string;
  display_name: string | null;
  accent_color: string | null;
  theme_mode?: "dark" | "light" | null;
};

type RouteId = "home" | "about" | "contact" | "privacy" | "terms" | "planner" | "bills" | "accounts" | "settings";
type WebSetupOption = {
  title: string;
  subtitle: string;
  description: string;
};
type WebSetupGroup = {
  title: string;
  subtitle: string;
  description: string;
  options: WebSetupOption[];
};

const APP_ONLY_ROUTES = new Set<RouteId>(["planner", "bills", "accounts", "settings"]);
const APP_PRIMARY_ROUTES = new Set<RouteId>(["home", "planner", "bills", "accounts", "settings"]);
const PLANNER_SNAPSHOT_SELECT =
  "id, user_id, plan, snapshot, created_at, updated_at, source_platform, source_app_version, source_updated_at, planner_schema_version, planner_engine_version";

const CORE_SETUP_OPTIONS: WebSetupOption[] = [
  {
    title: "Accounts",
    subtitle: "Cash, bank, wallet, and balances",
    description: "Add the balances that tell the planner what money is actually available right now.",
  },
  {
    title: "Income",
    subtitle: "Pay sources, schedules, and variability",
    description: "Add each paycheck source so future cash and timing can be forecast correctly.",
  },
  {
    title: "Bills",
    subtitle: "Hard dues, subscriptions, and due rules",
    description: "Add real bill amounts and due timing so the planner can protect what matters first.",
  },
  {
    title: "Expenses",
    subtitle: "Essential and recurring living costs",
    description: "Add recurring spending like groceries, gas, and other essentials.",
  },
  {
    title: "Debts",
    subtitle: "Balances, due dates, and payoff behavior",
    description: "Add debt balances and minimums so debt pressure and payoff guidance stay accurate.",
  },
  {
    title: "Housing",
    subtitle: "Rent, arrears, and housing setup",
    description: "Set rent or mortgage details so safe-to-spend stays realistic.",
  },
];

const WEB_SETTINGS_GROUPS: WebSetupGroup[] = [
  {
    title: "Setup",
    subtitle: "Accounts, income, bills, expenses, debts, and housing",
    description: "Set up the money inputs the planner needs before it can give reliable answers.",
    options: [
      ...CORE_SETUP_OPTIONS,
      {
        title: "Bank linking",
        subtitle: "Teller Connect",
        description: "Connect your bank here on the Accounts page so balances and transactions can sync in.",
      },
    ],
  },
  {
    title: "Planning",
    subtitle: "Goals, paycheck rules, and planning preferences",
    description: "Shape how extra money, paycheck carve-outs, and planning preferences behave.",
    options: [
      {
        title: "Goals",
        subtitle: "Saved targets that use truly free cash",
        description: "Track savings progress without overriding protected bills and essentials.",
      },
      {
        title: "Paycheck Rules",
        subtitle: "Deductions, savings, and paycheck carve-outs",
        description: "Reduce usable pay before it reaches planning cash.",
      },
      {
        title: "Planning Preferences",
        subtitle: "Buffers, payoff, feasibility, and ordering rules",
        description: "Adjust safety floors, reserve behavior, and payoff style.",
      },
    ],
  },
  {
    title: "App",
    subtitle: "Notifications and organization",
    description: "Control reminders and the labels that keep your data easier to read.",
    options: [
      {
        title: "Organization",
        subtitle: "Categories and custom labels",
        description: "Keep data grouped and named in ways that match real life.",
      },
      {
        title: "Notifications",
        subtitle: "Payday and planning reminders",
        description: "Reminder settings live here once web editing expands.",
      },
    ],
  },
  {
    title: "Data",
    subtitle: "Backup, import, export, and reset",
    description: "Protect your data and restore it when you move devices or need a clean reset.",
    options: [
      {
        title: "Backup & Reset",
        subtitle: "Import, export, and reset app data",
        description: "Use the same live planner model when backing up or resetting.",
      },
    ],
  },
];

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
  { id: "apay", label: "A.Pay cyan", hex: "#12C8FF" },
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
  plannerSnapshotDraft: string;
  plannerSnapshotDirty: boolean;
  plannerSnapshotSaveBusy: boolean;
  plannerSnapshotSaveError: string | null;
  normalizedSnapshot: PlannerSnapshot | null;
  normalizedSnapshotBusy: boolean;
  normalizedSnapshotError: string | null;
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
  /** Currently open form editor on Settings (bill/income/etc) or null. */
  settingsEditor: SettingsEditorState | null;
  /** Currently open "adjust category" dialog for a synced bank transaction. */
  categorizeEditor: { txId: string; description: string; merchant: string | null; amount: number; postedDate: string | null } | null;
} = {
  session: null,
  profile: null,
  plannerSnapshot: null,
  plannerSnapshotDraft: "",
  plannerSnapshotDirty: false,
  plannerSnapshotSaveBusy: false,
  plannerSnapshotSaveError: null,
  normalizedSnapshot: null,
  normalizedSnapshotBusy: false,
  normalizedSnapshotError: null,
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
  settingsEditor: null,
  categorizeEditor: null,
};

type SettingsEditorState =
  | { kind: "bill"; id?: string }
  | { kind: "income"; id?: string }
  | { kind: "debt"; id?: string }
  | { kind: "expense"; id?: string }
  | { kind: "goal"; id?: string }
  | { kind: "housing" }
  | { kind: "planner-settings" };

const app = document.querySelector<HTMLDivElement>("#app")!;

/** Cleans pointer/scroll listeners when leaving the guest landing view. */
let landingParallaxTeardown: (() => void) | null = null;

const DEFAULT_ACCENT = "#12C8FF";

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

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function createDefaultPlannerSnapshot(): Record<string, unknown> {
  return {
    today: todayIsoDate(),
    accounts: [],
    incomeSources: [],
    paychecks: [],
    paycheckActions: [],
    billPayments: [],
    debtTransactions: [],
    expenseSpends: [],
    housingPayments: [],
    cashAdjustments: [],
    bills: [],
    debts: [],
    expenses: [],
    housingConfig: null,
    housingBuckets: [],
    goals: [],
    deductionRules: [],
    categories: [],
    labels: [],
    demoModeState: {
      id: "demo_state",
      mode: "ONBOARDING",
      selectedDemoId: null,
      demoImportedAt: null,
      lastModeChangedAt: new Date().toISOString(),
    },
    notificationSettings: {
      id: "notification_settings",
      paydayNotificationsEnabled: false,
      recalculateRemindersEnabled: false,
      paydayLeadMinutes: 60,
      recalculateReminderHour: 18,
      recalculateReminderMinute: 0,
      funMessageCursor: 0,
      updatedAt: new Date().toISOString(),
    },
    exportMetadata: {
      id: "export_metadata",
      schemaVersion: 1,
      appVersion: "bank-portal",
      lastExportAt: null,
      lastImportAt: null,
      lastFileName: null,
    },
    settings: {
      targetBuffer: 0,
      planStartDate: null,
      planEndDate: null,
      planHorizonDays: 36500,
      currency: "USD",
      timezone: "UTC",
      safetyFloorCash: 0,
      roundingMode: "NEAREST_CENT",
      optimizationGoal: "BALANCED",
      sameDayIncomeBeforeSameDayBills: true,
      reserveNearFutureWindowDays: 21,
      allowNegativeCash: false,
      priorityOrder: [
        "ESSENTIALS",
        "OVERDUE_ITEMS",
        "HARD_BILLS_AND_DEBTS",
        "CURRENT_RENT",
        "RENT_ARREARS",
        "BORROW_REPAYMENTS",
        "NEAR_FUTURE_RESERVES",
        "EXTRA_DEBT_PAYOFF",
        "FUTURE_RENT_PREPAY",
        "SAVINGS",
      ],
      planningStyle: "BALANCED",
      payoffMode: "SNOWBALL",
      housingPaymentMode: "MINIMUM_CURRENT",
      housingPayoffTargetMode: "REGULAR_DEBTS_ONLY",
      plannerMode: null,
      selectedScenarioMode: "FIXED",
      readOnlyCalculatedFields: [
        "current_paycheck_allocation",
        "next_paycheck_amount_needed",
        "survival_amount",
        "ideal_amount",
        "amount_left",
        "debt_balances_left",
        "arrears_left",
        "projected_debt_free_date",
        "warnings",
        "safe_extra_payoff",
        "safe_to_spend_now",
        "protected_amount",
        "safe_reborrow_amount",
        "goal_progress",
        "goal_timeline",
        "out_of_debt_state",
        "catch_up_time_estimates",
        "plan_mode_results",
      ],
      notificationPermissionAsked: false,
      lastRecalculatedAt: null,
      debtFreeLatched: false,
      debtFreeScreenDismissed: false,
    },
    tellerEnrollments: [],
  };
}

function plannerSnapshotPretty(value: unknown): string {
  return JSON.stringify(value ?? createDefaultPlannerSnapshot(), null, 2);
}

function coercePlannerSnapshotShape(value: unknown): Record<string, unknown> {
  const base = createDefaultPlannerSnapshot();
  if (!value || typeof value !== "object" || Array.isArray(value)) return base;
  const raw = value as Record<string, unknown>;
  return {
    ...base,
    ...raw,
    today: typeof raw.today === "string" ? raw.today : base.today,
    accounts: Array.isArray(raw.accounts) ? raw.accounts : base.accounts,
    incomeSources: Array.isArray(raw.incomeSources) ? raw.incomeSources : base.incomeSources,
    paychecks: Array.isArray(raw.paychecks) ? raw.paychecks : base.paychecks,
    paycheckActions: Array.isArray(raw.paycheckActions) ? raw.paycheckActions : base.paycheckActions,
    billPayments: Array.isArray(raw.billPayments) ? raw.billPayments : base.billPayments,
    debtTransactions: Array.isArray(raw.debtTransactions) ? raw.debtTransactions : base.debtTransactions,
    expenseSpends: Array.isArray(raw.expenseSpends) ? raw.expenseSpends : base.expenseSpends,
    housingPayments: Array.isArray(raw.housingPayments) ? raw.housingPayments : base.housingPayments,
    cashAdjustments: Array.isArray(raw.cashAdjustments) ? raw.cashAdjustments : base.cashAdjustments,
    bills: Array.isArray(raw.bills) ? raw.bills : base.bills,
    debts: Array.isArray(raw.debts) ? raw.debts : base.debts,
    expenses: Array.isArray(raw.expenses) ? raw.expenses : base.expenses,
    housingBuckets: Array.isArray(raw.housingBuckets) ? raw.housingBuckets : base.housingBuckets,
    goals: Array.isArray(raw.goals) ? raw.goals : base.goals,
    deductionRules: Array.isArray(raw.deductionRules) ? raw.deductionRules : base.deductionRules,
    categories: Array.isArray(raw.categories) ? raw.categories : base.categories,
    labels: Array.isArray(raw.labels) ? raw.labels : base.labels,
    tellerEnrollments: Array.isArray(raw.tellerEnrollments) ? raw.tellerEnrollments : base.tellerEnrollments,
    settings:
      raw.settings && typeof raw.settings === "object" && !Array.isArray(raw.settings)
        ? { ...(base.settings as Record<string, unknown>), ...(raw.settings as Record<string, unknown>) }
        : base.settings,
    notificationSettings:
      raw.notificationSettings && typeof raw.notificationSettings === "object" && !Array.isArray(raw.notificationSettings)
        ? {
            ...(base.notificationSettings as Record<string, unknown>),
            ...(raw.notificationSettings as Record<string, unknown>),
          }
        : base.notificationSettings,
    exportMetadata:
      raw.exportMetadata && typeof raw.exportMetadata === "object" && !Array.isArray(raw.exportMetadata)
        ? { ...(base.exportMetadata as Record<string, unknown>), ...(raw.exportMetadata as Record<string, unknown>) }
        : base.exportMetadata,
    demoModeState:
      raw.demoModeState && typeof raw.demoModeState === "object" && !Array.isArray(raw.demoModeState)
        ? { ...(base.demoModeState as Record<string, unknown>), ...(raw.demoModeState as Record<string, unknown>) }
        : base.demoModeState,
  };
}

function syncPlannerSnapshotDraft(force = false) {
  const row = toPlannerStateRow(state.plannerSnapshot);
  const nextDraft = plannerSnapshotPretty(row?.snapshot ?? createDefaultPlannerSnapshot());
  if (force || !state.plannerSnapshotDirty || !state.plannerSnapshotDraft.trim()) {
    state.plannerSnapshotDraft = nextDraft;
    state.plannerSnapshotDirty = false;
    state.plannerSnapshotSaveError = null;
  }
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
    await syncTellerAccountsToPlanner(state.accounts as Record<string, unknown>[]);
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

/**
 * Upsert Teller accounts into `bank_accounts` so the planner sees them and
 * transactions can be auto-categorized against a known account. Best-effort;
 * errors are logged but do not block bank data from rendering.
 */
async function syncTellerAccountsToPlanner(accounts: Record<string, unknown>[]): Promise<void> {
  if (!state.session?.user?.id) return;
  const userId = state.session.user.id;
  for (const a of accounts) {
    const id = String(a.id ?? "").trim();
    if (!id) continue;
    const inst = (a.institution ?? {}) as Record<string, unknown>;
    const enrollmentId = a.enrollment_id ? String(a.enrollment_id) : null;
    const row = {
      user_id: userId,
      id,
      teller_enrollment_id: enrollmentId,
      teller_linked_account_id: id,
      institution_name: inst.name ? String(inst.name) : null,
      name: String(a.name ?? "Account"),
      type: String(a.type ?? "depository"),
      subtype: a.subtype ? String(a.subtype) : null,
      mask: a.last_four ? String(a.last_four) : null,
      currency: String(a.currency ?? "USD"),
      current_balance: typeof a.balance === "object" && a.balance && "available" in (a.balance as Record<string, unknown>)
        ? Number((a.balance as Record<string, unknown>).available ?? 0)
        : 0,
      available_balance: typeof a.balance === "object" && a.balance && "available" in (a.balance as Record<string, unknown>)
        ? Number((a.balance as Record<string, unknown>).available ?? 0)
        : 0,
      include_in_planning: true,
      protected_from_payoff: false,
      last_synced_at: new Date().toISOString(),
    };
    const { error } = await supabase.from("bank_accounts").upsert(row, { onConflict: "user_id,id" });
    if (error) console.warn("bank_accounts upsert failed", error.message);
  }
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
    await autoCategorizeTransactionsAndReplan(state.transactions as unknown[]);
  } catch (e) {
    state.error = formatAuthError("Transaction load", e, { edgeFunction: "teller-data" });
    state.transactions = [];
  } finally {
    state.busy = false;
    render();
  }
}

/**
 * Persist fetched Teller transactions into `bank_transactions`, run the
 * deterministic auto-categorizer against the current planner snapshot, upsert
 * `transaction_categorizations` and optional actuals (bill_payments, etc.),
 * then recompute the plan so Home/Planner/Bills reflect them.
 */
async function autoCategorizeTransactionsAndReplan(rawTransactions: unknown[]): Promise<void> {
  if (!state.session?.user?.id) return;
  const userId = state.session.user.id;
  if (!Array.isArray(rawTransactions) || rawTransactions.length === 0) return;
  try {
    const snapshot = state.normalizedSnapshot ?? (await loadNormalizedSnapshot(userId));
    state.normalizedSnapshot = snapshot;
    const normalized = normalizeTellerTransactions(
      rawTransactions,
      state.selectedAccountId ?? null,
    );
    if (normalized.length === 0) return;
    const summary = await persistAutoCategorizedTransactions(userId, normalized, snapshot);
    if (summary.saved > 0) {
      state.info = `Auto-categorized ${summary.categorized}/${summary.saved} transactions (${summary.matched} confident, ${summary.asActuals} posted as planner actuals).`;
      await loadNormalizedAndRecompute({ persist: true });
    }
  } catch (e) {
    console.warn("auto-categorize failed", e);
  }
}

async function loadPlannerSnapshot() {
  state.plannerLoadError = null;
  if (!state.session?.user?.id) {
    state.plannerSnapshot = null;
    syncPlannerSnapshotDraft(true);
    return;
  }
  const { data, error } = await supabase
    .from("planner_snapshots")
    .select(PLANNER_SNAPSHOT_SELECT)
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
  syncPlannerSnapshotDraft(false);
}

async function reloadPlannerFromSupabase() {
  if (!state.session?.user?.id) return;
  state.plannerSyncBusy = true;
  render();
  try {
    await loadPlannerSnapshot();
    await loadNormalizedAndRecompute();
  } finally {
    state.plannerSyncBusy = false;
    render();
  }
}

async function loadNormalizedAndRecompute(options: { persist?: boolean } = { persist: true }) {
  const userId = state.session?.user?.id ?? (await currentUserId());
  if (!userId) {
    state.normalizedSnapshot = null;
    return;
  }
  state.normalizedSnapshotBusy = true;
  state.normalizedSnapshotError = null;
  render();
  try {
    // First load to see what's there.
    let snapshot = await loadNormalizedSnapshot(userId);
    const totalNormalized =
      snapshot.bills.length +
      snapshot.incomeSources.length +
      snapshot.debts.length +
      snapshot.expenses.length +
      snapshot.goals.length +
      snapshot.accounts.length +
      snapshot.housingBuckets.length +
      (snapshot.housingConfig ? 1 : 0);

    // If normalized tables are empty but an Android snapshot exists on planner_snapshots,
    // import it so the web app renders the same data.
    if (totalNormalized === 0) {
      const legacy = state.plannerSnapshot && typeof state.plannerSnapshot === "object"
        ? (state.plannerSnapshot as Record<string, unknown>).snapshot as Record<string, unknown> | undefined
        : undefined;
      if (legacy && Object.keys(legacy).length > 0) {
        try {
          const result = await importLegacySnapshotIntoNormalized(userId, legacy);
          if (result.importedEntities.length > 0) {
            state.info = `Imported planner data from app: ${result.importedEntities.join(", ")}.`;
            snapshot = await loadNormalizedSnapshot(userId);
          }
        } catch (e) {
          console.warn("legacy snapshot import failed", e);
        }
      }
    }

    if (options.persist) {
      const { plan, snapshot: finalSnapshot } = await recomputeAndPersistPlan(userId);
      state.normalizedSnapshot = finalSnapshot;
      state.plannerSnapshot = {
        ...(typeof state.plannerSnapshot === "object" && state.plannerSnapshot ? state.plannerSnapshot : {}),
        snapshot: finalSnapshot,
        plan,
        updated_at: new Date().toISOString(),
      };
      syncPlannerSnapshotDraft(true);
    } else {
      state.normalizedSnapshot = snapshot;
    }
  } catch (e) {
    state.normalizedSnapshotError = e instanceof Error ? e.message : String(e);
  } finally {
    state.normalizedSnapshotBusy = false;
    render();
  }
}

async function withRecompute<T>(fn: () => Promise<T>, successMessage?: string): Promise<T | null> {
  state.error = null;
  state.info = null;
  state.normalizedSnapshotBusy = true;
  render();
  try {
    const result = await fn();
    await loadNormalizedAndRecompute({ persist: true });
    if (successMessage) state.info = successMessage;
    return result;
  } catch (e) {
    state.error = e instanceof Error ? e.message : String(e);
    return null;
  } finally {
    state.normalizedSnapshotBusy = false;
    render();
  }
}

async function savePlannerSnapshotDraft() {
  if (!state.session?.user?.id) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(state.plannerSnapshotDraft);
  } catch (e) {
    state.plannerSnapshotSaveError = `Planner data must be valid JSON before saving. ${e instanceof Error ? e.message : ""}`.trim();
    render();
    return;
  }

  const snapshot = coercePlannerSnapshotShape(parsed);
  const row = toPlannerStateRow(state.plannerSnapshot);
  state.plannerSnapshotSaveBusy = true;
  state.plannerSnapshotSaveError = null;
  state.error = null;
  render();
  const payload = {
    user_id: state.session.user.id,
    snapshot,
    plan: null,
    source_platform: "web",
    source_app_version: "bank-portal",
    source_updated_at: new Date().toISOString(),
    planner_schema_version: row?.planner_schema_version ?? "billpayer-shared-v1",
    planner_engine_version: null,
  };
  const { data, error } = await supabase
    .from("planner_snapshots")
    .upsert(payload, { onConflict: "user_id" })
    .select(PLANNER_SNAPSHOT_SELECT)
    .single();
  state.plannerSnapshotSaveBusy = false;
  if (error) {
    state.plannerSnapshotSaveError = error.message;
    render();
    return;
  }
  state.plannerSnapshot = data ?? payload;
  state.plannerLoadError = null;
  state.plannerSnapshotDirty = false;
  syncPlannerSnapshotDraft(true);
  state.info = "Planner inputs saved for this account. Planner output will refresh after the shared engine recalculates.";
  render();
}

function resetPlannerSnapshotDraftToCurrent() {
  syncPlannerSnapshotDraft(true);
  render();
}

function seedPlannerSnapshotDraftWithTemplate() {
  state.plannerSnapshotDraft = plannerSnapshotPretty(createDefaultPlannerSnapshot());
  state.plannerSnapshotDirty = true;
  state.plannerSnapshotSaveError = null;
  render();
}

function formatPlannerSnapshotDraft() {
  try {
    const parsed = JSON.parse(state.plannerSnapshotDraft);
    state.plannerSnapshotDraft = plannerSnapshotPretty(coercePlannerSnapshotShape(parsed));
    state.plannerSnapshotDirty = true;
    state.plannerSnapshotSaveError = null;
  } catch (e) {
    state.plannerSnapshotSaveError = `Could not format planner data. ${e instanceof Error ? e.message : ""}`.trim();
  }
  render();
}

function parseSectionJsonField(form: FormData, field: string): unknown {
  const raw = String(form.get(field) ?? "").trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function collectPlannerSnapshotFromSectionForm(formEl: HTMLFormElement): Record<string, unknown> {
  const form = new FormData(formEl);
  const current = coercePlannerSnapshotShape(toPlannerStateRow(state.plannerSnapshot)?.snapshot ?? createDefaultPlannerSnapshot());
  return coercePlannerSnapshotShape({
    ...current,
    today: String(form.get("planner-section-today") ?? current.today ?? todayIsoDate()),
    accounts: parseSectionJsonField(form, "planner-section-accounts"),
    incomeSources: parseSectionJsonField(form, "planner-section-incomeSources"),
    bills: parseSectionJsonField(form, "planner-section-bills"),
    expenses: parseSectionJsonField(form, "planner-section-expenses"),
    debts: parseSectionJsonField(form, "planner-section-debts"),
    housingConfig: parseSectionJsonField(form, "planner-section-housingConfig"),
    housingBuckets: parseSectionJsonField(form, "planner-section-housingBuckets"),
    paychecks: parseSectionJsonField(form, "planner-section-paychecks"),
    paycheckActions: parseSectionJsonField(form, "planner-section-paycheckActions"),
    billPayments: parseSectionJsonField(form, "planner-section-billPayments"),
    debtTransactions: parseSectionJsonField(form, "planner-section-debtTransactions"),
    expenseSpends: parseSectionJsonField(form, "planner-section-expenseSpends"),
    housingPayments: parseSectionJsonField(form, "planner-section-housingPayments"),
    cashAdjustments: parseSectionJsonField(form, "planner-section-cashAdjustments"),
    goals: parseSectionJsonField(form, "planner-section-goals"),
    deductionRules: parseSectionJsonField(form, "planner-section-deductionRules"),
    settings: parseSectionJsonField(form, "planner-section-settings"),
    categories: parseSectionJsonField(form, "planner-section-categories"),
    labels: parseSectionJsonField(form, "planner-section-labels"),
    notificationSettings: parseSectionJsonField(form, "planner-section-notificationSettings"),
    exportMetadata: parseSectionJsonField(form, "planner-section-exportMetadata"),
    demoModeState: parseSectionJsonField(form, "planner-section-demoModeState"),
  });
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

function renderSetupOptionList(items: WebSetupOption[], emptyCopy: string) {
  if (!items.length) return `<p class="muted">${escapeHtml(emptyCopy)}</p>`;
  return `<div class="fx-mini-list">${items
    .map(
      (item) => `
        <article class="fx-mini-list__item">
          <div>
            <strong>${escapeHtml(item.title)}</strong>
            <p>${escapeHtml(`${item.subtitle} — ${item.description}`)}</p>
          </div>
        </article>
      `,
    )
    .join("")}</div>`;
}

function jsonFieldValue(value: unknown): string {
  return JSON.stringify(value ?? null, null, 2);
}

function renderPlannerSectionJsonField(
  id: string,
  label: string,
  help: string,
  value: unknown,
  rows = 8,
) {
  return `
    <label class="field">
      ${escapeHtml(label)}
      <textarea id="${escapeHtml(id)}" name="${escapeHtml(id)}" rows="${rows}" spellcheck="false" style="width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace">${escapeHtml(
        jsonFieldValue(value),
      )}</textarea>
      <span class="muted">${escapeHtml(help)}</span>
    </label>
  `;
}

function renderSetupGroups(groups: WebSetupGroup[]) {
  const mid = Math.ceil(groups.length / 2);
  const columns = [groups.slice(0, mid), groups.slice(mid)];
  return `<div class="fx-layout fx-layout--split">${columns
    .map(
      (column) => `
        <div class="fx-stack">
          ${column
            .map(
              (group) => `
                <section class="fx-panel">
                  <p class="fx-eyebrow">${escapeHtml(group.title)}</p>
                  <h2>${escapeHtml(group.subtitle)}</h2>
                  <p class="muted">${escapeHtml(group.description)}</p>
                  ${renderSetupOptionList(group.options, "No options in this group yet.")}
                </section>
              `,
            )
            .join("")}
        </div>
      `,
    )
    .join("")}</div>`;
}

function renderSetupStarter(
  eyebrow: string,
  title: string,
  body: string,
  secondaryTitle: string,
  secondaryBody: string,
) {
  return `
    <div class="fx-stack">
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">${escapeHtml(eyebrow)}</p>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(body)}</p>
      </section>
      <div class="fx-layout fx-layout--split">
        <section class="fx-panel">
          <p class="fx-eyebrow">Add first</p>
          <h2>Planner inputs</h2>
          ${renderSetupOptionList(CORE_SETUP_OPTIONS, "No setup items yet.")}
          <p class="muted" style="margin-top:12px">Open <a href="#/settings">Settings</a> for the full checklist, or use the Android app to enter the data today.</p>
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Then</p>
          <h2>${escapeHtml(secondaryTitle)}</h2>
          <p class="muted">${escapeHtml(secondaryBody)}</p>
          <p class="muted">After the same account has planner data, this web app can render the same safe-to-spend and timeline automatically.</p>
        </section>
      </div>
    </div>
  `;
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
  const snap = state.normalizedSnapshot;
  if (!plan) {
    const quickAdd = `
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">Start here</p>
        <h2>Add your money setup</h2>
        <p class="muted">The planner needs these to show a real safe-to-spend amount. You can also edit them from Settings or the Android app.</p>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">
          <button type="button" data-settings-add="income">Add income source</button>
          <button type="button" data-settings-add="bill">Add bill</button>
          <button type="button" data-settings-add="debt" class="secondary">Add debt</button>
          <button type="button" data-settings-add="expense" class="secondary">Add expense</button>
          <button type="button" data-settings-add="goal" class="secondary">Add goal</button>
          <button type="button" data-settings-add="housing" class="secondary">Set housing</button>
        </div>
        ${snap ? `<p class="muted" style="margin-top:12px">Currently on file: ${snap.incomeSources.length} income · ${snap.bills.length} bills · ${snap.debts.length} debts · ${snap.expenses.length} expenses · ${snap.goals.length} goals${snap.housingConfig ? " · housing set" : ""}.</p>` : ""}
      </section>
    `;
    return `
      <div class="fx-stack">
        ${quickAdd}
        ${renderSetupStarter(
          "Home",
          "You have not added enough information yet",
          "A.Pay needs your core money setup before it can show a real safe-to-spend amount here.",
          "Sync the planner",
          "Once those inputs exist on the same signed-in account, the latest planner snapshot will appear here automatically.",
        )}
      </div>
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
    const snap = state.normalizedSnapshot;
    const hasAny = snap && (snap.bills.length + snap.incomeSources.length + snap.debts.length + snap.expenses.length + snap.goals.length) > 0;
    return `
      <div class="fx-stack fx-stack--planner">
        ${loadErr}
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">Planner</p>
          <h2>${hasAny ? "Press recompute to generate a plan" : "You have not added enough information yet"}</h2>
          <p class="muted">${hasAny
            ? "You have planner inputs on file. Recompute builds timeline, safe-to-spend, and due lists from them."
            : "Add at least one income source, some bills, and your housing info so the planner can forecast."}</p>
          <div class="row" style="gap:8px;flex-wrap:wrap;margin-top:10px">
            <button type="button" id="btn-recompute-plan" ${state.normalizedSnapshotBusy ? "disabled" : ""}>${state.normalizedSnapshotBusy ? "Recomputing…" : "Recompute plan"}</button>
            <button type="button" class="secondary" id="btn-refresh-planner" ${syncDisabled ? "disabled" : ""}>${state.plannerSyncBusy ? "Loading…" : "Reload from Supabase"}</button>
            <button type="button" data-settings-add="income" class="secondary">Add income source</button>
            <button type="button" data-settings-add="bill" class="secondary">Add bill</button>
            <button type="button" data-settings-add="housing" class="secondary">Set housing</button>
          </div>
          ${state.normalizedSnapshotError ? `<p class="error">${escapeHtml(state.normalizedSnapshotError)}</p>` : ""}
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
            <button type="button" id="btn-recompute-plan" ${state.normalizedSnapshotBusy ? "disabled" : ""}>${state.normalizedSnapshotBusy ? "Recomputing…" : "Recompute plan"}</button>
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
  const snap = state.normalizedSnapshot;
  const billRows = snap?.bills ?? [];
  const addSection = `
    <section class="fx-panel">
      <div class="fx-planner-head__row">
        <div>
          <p class="fx-eyebrow">Bills</p>
          <h2>Your bills</h2>
          <p class="muted">The planner uses this list to protect cash before it becomes safe-to-spend.</p>
        </div>
        <div class="fx-planner-head__actions">
          <button type="button" data-settings-add="bill">Add bill</button>
        </div>
      </div>
      ${billRows.length
        ? `<div class="fx-mini-list">${billRows.map(renderBillRow).join("")}</div>`
        : `<p class="muted">No bills yet. Add Rent, Electricity, Phone, etc. so the planner can protect them.</p>`}
    </section>
  `;

  if (!plan) {
    return `
      <div class="fx-stack">
        ${addSection}
        ${renderSetupStarter(
          "Bills",
          "Plan guidance unlocks after setup",
          "Add bills above and income sources under Settings, then press Recompute plan to generate timeline and due lists.",
          "What will show up here",
          "After setup, this page will show what must be paid now, what is due soon, and what can safely wait.",
        )}
      </div>
    `;
  }

  return `
    <div class="fx-stack">
      ${addSection}
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
      <h2>Accounts and bank connections</h2>
      <p class="muted">Connect a bank here to pull live balances and transactions, then use Settings to finish the rest of your planner setup.</p>
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
          ${
            rows.length
              ? `<div class="list">${rows.join("")}</div>`
              : `<div class="fx-stack">
                  <p class="muted">No linked or refreshed accounts yet. Connect a bank above, then open <a href="#/settings">Settings</a> to work through the same setup checklist the app uses.</p>
                  ${renderSetupOptionList(CORE_SETUP_OPTIONS.slice(0, 3), "No starter items yet.")}
                </div>`
          }
        </section>
      </div>
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Activity</p>
          <h2>Transactions</h2>
          <div class="tx-feed">
            ${
              txRows.length
                ? txRows.join("")
                : `<p class="muted" style="padding:16px;margin:0">${
                    rows.length
                      ? "Pick an account above to load its transactions."
                      : "Transactions will appear here after you connect a bank, refresh, and choose an account."
                  }</p>`
            }
          </div>
        </section>
      </div>
    </div>
  `;
}

// ========================================================================
// Normalized snapshot CRUD renderers (bills/income/debts/expenses/goals)
// ========================================================================

function escapeAttr(s: unknown): string {
  return escapeHtml(String(s ?? ""));
}

function ruleSummary(rule: { type?: string; anchorDate?: string; dayOfMonth?: number; intervalDays?: number } | null | undefined): string {
  if (!rule?.type) return "Not scheduled";
  const anchor = rule.anchorDate ? ` (anchor ${rule.anchorDate})` : "";
  switch (rule.type) {
    case "ONE_TIME": return `One-time${anchor}`;
    case "DAILY": return `Daily${anchor}`;
    case "WEEKLY": return `Weekly${anchor}`;
    case "BIWEEKLY": return `Every 2 weeks${anchor}`;
    case "MONTHLY": return `Monthly${rule.dayOfMonth ? ` on day ${rule.dayOfMonth}` : anchor}`;
    case "SEMI_MONTHLY": return `Twice monthly${anchor}`;
    case "QUARTERLY": return `Quarterly${anchor}`;
    case "YEARLY": return `Yearly${anchor}`;
    case "EVERY_X_DAYS": return `Every ${rule.intervalDays ?? 7} days${anchor}`;
    case "CUSTOM_INTERVAL": return `Custom ${rule.intervalDays ?? 30} days${anchor}`;
    default: return String(rule.type);
  }
}

function renderCrudListSection(opts: {
  title: string; eyebrow: string; description: string; addKind: SettingsEditorState["kind"];
  items: string[]; emptyCopy: string;
}) {
  return `
    <section class="fx-panel">
      <div class="fx-planner-head__row">
        <div>
          <p class="fx-eyebrow">${escapeHtml(opts.eyebrow)}</p>
          <h2>${escapeHtml(opts.title)}</h2>
          <p class="muted">${escapeHtml(opts.description)}</p>
        </div>
        <div class="fx-planner-head__actions">
          <button type="button" data-settings-add="${opts.addKind}" class="secondary">Add new</button>
        </div>
      </div>
      ${opts.items.length
        ? `<div class="fx-mini-list">${opts.items.join("")}</div>`
        : `<p class="muted">${escapeHtml(opts.emptyCopy)}</p>`}
    </section>
  `;
}

function renderBillRow(bill: { id: string; name: string; amountDue: number; minimumDue: number; currentAmountDue: number; recurringRule?: { type?: string; anchorDate?: string; dayOfMonth?: number }; status?: string; paymentPolicy?: string }): string {
  const next = ruleSummary(bill.recurringRule);
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(bill.name)}</strong>
        <p>${money(bill.amountDue)} planned · min ${money(bill.minimumDue)} · ${escapeHtml(next)}${bill.currentAmountDue > 0 ? ` · ${money(bill.currentAmountDue)} due now` : ""}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="bill" data-settings-id="${escapeAttr(bill.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="bill" data-settings-id="${escapeAttr(bill.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderIncomeRow(src: { id: string; name: string; payerLabel?: string; amountRange: { minimum?: number; target?: number; maximum?: number }; recurringRule: { type?: string; anchorDate?: string; dayOfMonth?: number }; nextExpectedPayDate?: string | null; isActive?: boolean }): string {
  const target = src.amountRange.target ?? src.amountRange.minimum ?? 0;
  const active = src.isActive === false ? " · paused" : "";
  const next = src.nextExpectedPayDate ? ` · next ${src.nextExpectedPayDate}` : "";
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(src.name)}</strong>
        <p>${money(target)} ${escapeHtml(ruleSummary(src.recurringRule))}${escapeHtml(next)}${escapeHtml(active)}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="income" data-settings-id="${escapeAttr(src.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="income" data-settings-id="${escapeAttr(src.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderDebtRow(d: { id: string; name: string; lender?: string; currentBalance: number; minimumDue: number; requiredDueDate?: string | null }): string {
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(d.name)}${d.lender ? ` — ${escapeHtml(d.lender)}` : ""}</strong>
        <p>Balance ${money(d.currentBalance)} · min ${money(d.minimumDue)}${d.requiredDueDate ? ` · due ${d.requiredDueDate}` : ""}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="debt" data-settings-id="${escapeAttr(d.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="debt" data-settings-id="${escapeAttr(d.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderExpenseRow(e: { id: string; name: string; amount: number; recurringRule: { type?: string; anchorDate?: string; dayOfMonth?: number }; isEssential?: boolean; categoryLabel?: string }): string {
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(e.name)}</strong>
        <p>${money(e.amount)} · ${escapeHtml(ruleSummary(e.recurringRule))} · ${e.isEssential ? "Essential" : "Optional"}${e.categoryLabel ? ` · ${escapeHtml(e.categoryLabel)}` : ""}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="expense" data-settings-id="${escapeAttr(e.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="expense" data-settings-id="${escapeAttr(e.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderGoalRow(g: { id: string; name: string; targetAmount: number; currentAmount: number; isActive?: boolean }): string {
  const ratio = g.targetAmount > 0 ? Math.min(1, Math.max(0, g.currentAmount / g.targetAmount)) : 0;
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(g.name)}</strong>
        <p>${money(g.currentAmount)} of ${money(g.targetAmount)} · ${Math.round(ratio * 100)}%${g.isActive === false ? " · paused" : ""}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="goal" data-settings-id="${escapeAttr(g.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="goal" data-settings-id="${escapeAttr(g.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderNormalizedSettings(snap: PlannerSnapshot | null): string {
  if (!snap) {
    return `
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">Loading</p>
        <h2>Pulling your planner data…</h2>
        <p class="muted">If this hangs, make sure the latest Supabase migrations (including <code>20260423000000_planner_data_model.sql</code>) have been applied.</p>
      </section>
    `;
  }
  const bills = renderCrudListSection({
    eyebrow: "Setup",
    title: "Bills",
    description: "Hard dues, subscriptions, and recurring amounts. The planner protects these before safe-to-spend.",
    addKind: "bill",
    items: snap.bills.map(renderBillRow),
    emptyCopy: "No bills yet. Add Electricity, Rent, Phone, etc. to start protecting money for them.",
  });
  const income = renderCrudListSection({
    eyebrow: "Setup",
    title: "Income sources",
    description: "Paychecks and other recurring income that fund the plan.",
    addKind: "income",
    items: snap.incomeSources.map(renderIncomeRow),
    emptyCopy: "Add at least one income source so the planner can forecast future paychecks.",
  });
  const debts = renderCrudListSection({
    eyebrow: "Setup",
    title: "Debts",
    description: "Balances and minimums we must protect with cash or paychecks.",
    addKind: "debt",
    items: snap.debts.map(renderDebtRow),
    emptyCopy: "No debts recorded. Add credit cards, loans, or other balances you owe.",
  });
  const expenses = renderCrudListSection({
    eyebrow: "Setup",
    title: "Recurring expenses",
    description: "Essential and optional recurring spending like gas, groceries, and services.",
    addKind: "expense",
    items: snap.expenses.map(renderExpenseRow),
    emptyCopy: "Add groceries, gas, internet, etc. Mark the ones that must stay funded.",
  });
  const goals = renderCrudListSection({
    eyebrow: "Planning",
    title: "Goals",
    description: "Targets that fund from truly free cash without breaking protected bills.",
    addKind: "goal",
    items: snap.goals.map(renderGoalRow),
    emptyCopy: "No goals yet. Add savings targets to direct extra cash once the plan is fully funded.",
  });

  const hc = snap.housingConfig;
  const housing = `
    <section class="fx-panel">
      <div class="fx-planner-head__row">
        <div>
          <p class="fx-eyebrow">Setup</p>
          <h2>Housing</h2>
          <p class="muted">Rent or mortgage payment and arrears buckets.</p>
        </div>
        <div class="fx-planner-head__actions">
          <button type="button" data-settings-add="housing" class="secondary">Edit housing</button>
        </div>
      </div>
      ${hc
        ? `<div class="fx-mini-list">
            <article class="fx-mini-list__item">
              <div><strong>Current payment</strong><p>${money(hc.currentMonthlyRent)} due day ${hc.rentDueDay} · min ${money(hc.minimumAcceptablePayment)} · ${escapeHtml(hc.arrangement ?? "RENT_MONTH_TO_MONTH")}</p></div>
            </article>
          </div>`
        : `<p class="muted">No housing setup yet. Add rent, mortgage, or arrangement details to protect it.</p>`
      }
      ${snap.housingBuckets.length > 0
        ? `<div class="fx-mini-list">${snap.housingBuckets.map((b) => `
            <article class="fx-mini-list__item">
              <div>
                <strong>${escapeHtml(b.label)}</strong>
                <p>${money(b.amountDue)} due · ${money(b.amountPaid)} paid · ${money(Math.max(0, b.amountDue - b.amountPaid))} left${b.dueDate ? ` · due ${escapeHtml(b.dueDate)}` : ""}</p>
              </div>
            </article>
          `).join("")}</div>`
        : ""}
    </section>
  `;

  const plannerSettings = `
    <section class="fx-panel">
      <div class="fx-planner-head__row">
        <div>
          <p class="fx-eyebrow">Planning</p>
          <h2>Planner preferences</h2>
          <p class="muted">Scenario mode, horizon window, and safety buffer.</p>
        </div>
        <div class="fx-planner-head__actions">
          <button type="button" data-settings-add="planner-settings" class="secondary">Edit preferences</button>
        </div>
      </div>
      <div class="fx-mini-list">
        <article class="fx-mini-list__item"><div><strong>Scenario</strong><p>${escapeHtml(snap.settings.selectedScenarioMode ?? "FIXED")}</p></div></article>
        <article class="fx-mini-list__item"><div><strong>Horizon</strong><p>${snap.settings.horizonDays ?? 120} days forecast</p></div></article>
        <article class="fx-mini-list__item"><div><strong>Safety buffer</strong><p>${money(snap.settings.targetBuffer ?? 0)}</p></div></article>
        <article class="fx-mini-list__item"><div><strong>Style</strong><p>${escapeHtml(snap.settings.planningStyle ?? "BALANCED")}</p></div></article>
      </div>
    </section>
  `;

  return `${bills}${income}${debts}${expenses}${goals}${housing}${plannerSettings}`;
}

// ========================================================================
// Editor dialogs (rendered as an overlay when state.settingsEditor is set)
// ========================================================================

function renderEditorFooterButtons(busy: boolean, deletable: boolean): string {
  return `
    <div class="row" style="justify-content:space-between;margin-top:12px">
      <div class="row">
        ${deletable ? `<button type="button" class="secondary" data-settings-editor-delete>Delete</button>` : ""}
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-editor-cancel>Cancel</button>
        <button type="submit" ${busy ? "disabled" : ""}>Save</button>
      </div>
    </div>
  `;
}

function renderRecurringRuleFields(prefix: string, rule?: { type?: string; anchorDate?: string; dayOfMonth?: number; intervalDays?: number }): string {
  const r = rule ?? {};
  const opts = ["ONE_TIME", "DAILY", "WEEKLY", "BIWEEKLY", "SEMI_MONTHLY", "MONTHLY", "QUARTERLY", "YEARLY", "EVERY_X_DAYS"];
  return `
    <div class="field">
      <span style="font-weight:600">Repeats</span>
      <select name="${prefix}_type">
        ${opts.map((o) => `<option value="${o}"${r.type === o ? " selected" : ""}>${o.toLowerCase().replace(/_/g, " ")}</option>`).join("")}
      </select>
    </div>
    <label class="field">Anchor date<input type="date" name="${prefix}_anchor" value="${escapeAttr(r.anchorDate ?? "")}" /></label>
    <label class="field">Day of month (for monthly)<input type="number" name="${prefix}_dayOfMonth" min="1" max="31" value="${escapeAttr(r.dayOfMonth ?? "")}" /></label>
    <label class="field">Interval days (for every-x-days)<input type="number" name="${prefix}_intervalDays" min="1" value="${escapeAttr(r.intervalDays ?? "")}" /></label>
  `;
}

function renderSettingsEditorOverlay(snap: PlannerSnapshot | null): string {
  const editor = state.settingsEditor;
  if (!editor) return "";
  if (!snap && editor.kind !== "housing" && editor.kind !== "planner-settings") return "";

  const busy = state.normalizedSnapshotBusy;
  const find = <T extends { id: string }>(arr: T[] | undefined, id?: string) => arr?.find((x) => x.id === id);

  let title = "Editor";
  let body = "";
  let deletable = false;

  switch (editor.kind) {
    case "bill": {
      const existing = snap && editor.id ? find(snap.bills, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit bill — ${existing.name}` : "Add bill";
      body = `
        <label class="field">Name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        <label class="field">Amount due next cycle<input name="amountDue" type="number" step="0.01" required value="${escapeAttr(existing?.amountDue ?? "")}" /></label>
        <label class="field">Minimum due<input name="minimumDue" type="number" step="0.01" value="${escapeAttr(existing?.minimumDue ?? 0)}" /></label>
        <label class="field">Amount currently due<input name="currentAmountDue" type="number" step="0.01" value="${escapeAttr(existing?.currentAmountDue ?? 0)}" /></label>
        <label class="field">Category<input name="category" value="${escapeAttr(existing?.category ?? "")}" /></label>
        <div class="field">
          <span style="font-weight:600">Policy</span>
          <select name="paymentPolicy">
            <option value="HARD_DUE"${(existing?.paymentPolicy ?? "HARD_DUE") === "HARD_DUE" ? " selected" : ""}>Hard due date (must pay on time)</option>
            <option value="FLEXIBLE_DUE"${existing?.paymentPolicy === "FLEXIBLE_DUE" ? " selected" : ""}>Flexible (can be delayed)</option>
          </select>
        </div>
        <label class="field"><input name="isEssential" type="checkbox"${existing?.isEssential ? " checked" : ""}/> Essential (never delay)</label>
        ${renderRecurringRuleFields("rule", existing?.recurringRule)}
      `;
      break;
    }
    case "income": {
      const existing = snap && editor.id ? find(snap.incomeSources, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit income — ${existing.name}` : "Add income source";
      body = `
        <label class="field">Source name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        <label class="field">Payer label (company)<input name="payerLabel" value="${escapeAttr(existing?.payerLabel ?? "")}" /></label>
        <label class="field">Target usable amount<input name="target" type="number" step="0.01" required value="${escapeAttr(existing?.amountRange.target ?? "")}" /></label>
        <label class="field">Minimum (low scenario)<input name="minimum" type="number" step="0.01" value="${escapeAttr(existing?.amountRange.minimum ?? "")}" /></label>
        <label class="field">Maximum (high scenario)<input name="maximum" type="number" step="0.01" value="${escapeAttr(existing?.amountRange.maximum ?? "")}" /></label>
        <label class="field">Next expected pay date<input type="date" name="nextExpectedPayDate" value="${escapeAttr(existing?.nextExpectedPayDate ?? "")}" /></label>
        <label class="field"><input name="isActive" type="checkbox"${existing?.isActive !== false ? " checked" : ""}/> Active</label>
        ${renderRecurringRuleFields("rule", existing?.recurringRule)}
      `;
      break;
    }
    case "debt": {
      const existing = snap && editor.id ? find(snap.debts, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit debt — ${existing.name}` : "Add debt";
      const linkedAccount = existing?.bankAccountId
        ? snap?.accounts.find((a) => a.id === existing.bankAccountId) ?? null
        : null;
      const liveBalanceLabel = linkedAccount
        ? `$${Math.abs(linkedAccount.currentBalance).toFixed(2)} live from ${linkedAccount.name}`
        : null;
      const accountOptions = (snap?.accounts ?? []).map((a) => {
        const sel = existing?.bankAccountId === a.id ? " selected" : "";
        return `<option value="${escapeAttr(a.id)}"${sel}>${escapeHtml(a.name)} — $${Math.abs(a.currentBalance).toFixed(2)}</option>`;
      }).join("");
      body = `
        <label class="field">Name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        <label class="field">Lender<input name="lender" value="${escapeAttr(existing?.lender ?? "")}" /></label>
        <div class="field">
          <span style="font-weight:600">Linked bank account (optional)</span>
          <select name="bankAccountId">
            <option value="">— none (enter balance manually below) —</option>
            ${accountOptions}
          </select>
          <span class="muted">Pick the credit card or loan account so its live balance drives this debt. Pay-down transactions already show on your bank statement — they do not get added manually here.</span>
        </div>
        ${liveBalanceLabel
          ? `<label class="field">Current balance (from bank)<input type="text" value="${escapeAttr(liveBalanceLabel)}" disabled /><span class="muted">Live value from your linked bank account. Manual balance field below is ignored while linked.</span></label>`
          : `<label class="field">Current balance (manual)<input name="currentBalance" type="number" step="0.01" required value="${escapeAttr(existing?.currentBalance ?? 0)}" /><span class="muted">Only used when no bank account is linked.</span></label>`}
        <input type="hidden" name="currentBalanceFallback" value="${escapeAttr(existing?.currentBalance ?? 0)}" />
        <label class="field">Minimum payment<input name="minimumDue" type="number" step="0.01" value="${escapeAttr(existing?.minimumDue ?? 0)}" /></label>
        <label class="field">Next required due date<input name="requiredDueDate" type="date" value="${escapeAttr(existing?.requiredDueDate ?? "")}" /></label>
        <div class="field">
          <span style="font-weight:600">Type</span>
          <select name="type">
            ${["INSTALLMENT", "REVOLVING", "CREDIT_CARD", "LOAN", "BORROW"].map((t) => `<option value="${t}"${(existing?.type ?? "INSTALLMENT") === t ? " selected" : ""}>${t}</option>`).join("")}
          </select>
        </div>
      `;
      break;
    }
    case "expense": {
      const existing = snap && editor.id ? find(snap.expenses, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit expense — ${existing.name}` : "Add recurring expense";
      body = `
        <label class="field">Name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        <label class="field">Typical amount<input name="amount" type="number" step="0.01" required value="${escapeAttr(existing?.amount ?? "")}" /></label>
        <label class="field">Category label<input name="categoryLabel" value="${escapeAttr(existing?.categoryLabel ?? "")}" /></label>
        <label class="field"><input name="isEssential" type="checkbox"${existing?.isEssential !== false ? " checked" : ""}/> Essential</label>
        ${renderRecurringRuleFields("rule", existing?.recurringRule)}
      `;
      break;
    }
    case "goal": {
      const existing = snap && editor.id ? find(snap.goals, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit goal — ${existing.name}` : "Add goal";
      body = `
        <label class="field">Goal name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        <label class="field">Target amount<input name="targetAmount" type="number" step="0.01" required value="${escapeAttr(existing?.targetAmount ?? "")}" /></label>
        <label class="field">Current progress<input name="currentAmount" type="number" step="0.01" value="${escapeAttr(existing?.currentAmount ?? 0)}" /></label>
        <label class="field"><input name="isActive" type="checkbox"${existing?.isActive !== false ? " checked" : ""}/> Active</label>
      `;
      break;
    }
    case "housing": {
      const existing = snap?.housingConfig;
      title = existing ? "Edit housing" : "Add housing";
      body = `
        <label class="field">Current monthly rent / mortgage<input name="currentMonthlyRent" type="number" step="0.01" required value="${escapeAttr(existing?.currentMonthlyRent ?? "")}" /></label>
        <label class="field">Minimum acceptable payment<input name="minimumAcceptablePayment" type="number" step="0.01" value="${escapeAttr(existing?.minimumAcceptablePayment ?? 0)}" /></label>
        <label class="field">Due day (1–31)<input name="rentDueDay" type="number" min="1" max="31" value="${escapeAttr(existing?.rentDueDay ?? 1)}" /></label>
        <div class="field">
          <span style="font-weight:600">Arrangement</span>
          <select name="arrangement">
            ${["RENT_MONTH_TO_MONTH", "RENT_LEASE", "MORTGAGE", "LAND_CONTRACT", "OTHER"].map((t) => `<option value="${t}"${(existing?.arrangement ?? "RENT_MONTH_TO_MONTH") === t ? " selected" : ""}>${t.toLowerCase().replace(/_/g, " ")}</option>`).join("")}
          </select>
        </div>
      `;
      break;
    }
    case "planner-settings": {
      const s = snap?.settings ?? { targetBuffer: 0, horizonDays: 120, selectedScenarioMode: "FIXED", planningStyle: "BALANCED" };
      title = "Planner preferences";
      body = `
        <label class="field">Safety buffer cash<input name="targetBuffer" type="number" step="0.01" value="${escapeAttr(s.targetBuffer ?? 0)}" /></label>
        <label class="field">Horizon days<input name="horizonDays" type="number" min="30" max="365" value="${escapeAttr(s.horizonDays ?? 120)}" /></label>
        <div class="field">
          <span style="font-weight:600">Scenario mode</span>
          <select name="selectedScenarioMode">
            ${(["FIXED", "LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"] as const).map((m) => `<option value="${m}"${s.selectedScenarioMode === m ? " selected" : ""}>${m.toLowerCase().replace(/_/g, " ")}</option>`).join("")}
          </select>
        </div>
      `;
      break;
    }
  }

  return `
    <div class="fx-auth-modal fx-auth-modal--open" role="dialog" aria-modal="true" aria-labelledby="settings-editor-title">
      <button type="button" class="fx-auth-modal__backdrop" data-settings-editor-cancel aria-label="Close"></button>
      <div class="fx-auth-modal__panel" style="max-width:620px">
        <div class="fx-auth-modal__chrome">
          <h2 id="settings-editor-title" class="fx-auth-modal__title">${escapeHtml(title)}</h2>
          <button type="button" class="fx-auth-modal__close" data-settings-editor-cancel aria-label="Close">×</button>
        </div>
        <form id="form-settings-editor" class="fx-auth-modal__form list" data-editor-kind="${editor.kind}" data-editor-id="${escapeAttr((editor as { id?: string }).id ?? "")}">
          ${body}
          ${renderEditorFooterButtons(busy, deletable)}
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
        </form>
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
  const snapshotSource = plannerState?.snapshot ?? createDefaultPlannerSnapshot();
  const snapshot = coercePlannerSnapshotShape(snapshotSource);
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
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">Setup guide</p>
          <h2>Same options as the app</h2>
          <p class="muted">Use this checklist to see the same Setup, Planning, App, and Data options the Android app exposes today.</p>
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
          <p class="muted">The website and the Android app both read and write this same row. Edits here recompute via the shared engine and sync back to the app.</p>
          <div class="row" style="margin-top:12px">
            <button type="button" id="btn-recompute-plan" ${state.normalizedSnapshotBusy ? "disabled" : ""}>${state.normalizedSnapshotBusy ? "Recomputing…" : "Recompute plan"}</button>
          </div>
          ${state.normalizedSnapshotError ? `<p class="error">${escapeHtml(state.normalizedSnapshotError)}</p>` : ""}
        </section>
      </div>
    </div>

    ${renderNormalizedSettings(state.normalizedSnapshot)}

    <details class="fx-panel" style="margin-top:12px">
      <summary style="cursor:pointer"><strong>Advanced: edit planner snapshot JSON</strong></summary>
      <p class="muted" style="margin-top:8px">For power users and data migration. The friendly forms above are the recommended way to edit.</p>
      ${renderSetupGroups(WEB_SETTINGS_GROUPS)}
    <form id="form-planner-sections" class="fx-stack">
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">Web setup editor</p>
        <h2>Save the same planner sections your app account uses</h2>
        <p class="muted">Edit the planner snapshot section by section below, then save it to this signed-in account. This mirrors the app’s account inputs more directly than the old checklist-only view.</p>
        <div class="row" style="margin-top:12px">
          <button type="submit" ${state.plannerSnapshotSaveBusy ? "disabled" : ""}>${state.plannerSnapshotSaveBusy ? "Saving…" : "Save all sections"}</button>
        </div>
      </section>

      <section class="fx-panel">
        <p class="fx-eyebrow">Setup</p>
        <h2>Core planner inputs</h2>
        <label class="field">
          Today
          <input id="planner-section-today" name="planner-section-today" type="date" value="${escapeHtml(String(snapshot.today ?? todayIsoDate()))}" />
          <span class="muted">Planner snapshot anchor date.</span>
        </label>
        ${renderPlannerSectionJsonField("planner-section-accounts", "Accounts", "Same account list used by the app planner.", snapshot.accounts, 8)}
        ${renderPlannerSectionJsonField("planner-section-incomeSources", "Income sources", "Pay sources, recurring rules, and amount ranges.", snapshot.incomeSources, 8)}
        ${renderPlannerSectionJsonField("planner-section-bills", "Bills", "Due amounts, recurring rules, and bill policies.", snapshot.bills, 8)}
        ${renderPlannerSectionJsonField("planner-section-expenses", "Expenses", "Recurring and essential spending inputs.", snapshot.expenses, 8)}
        ${renderPlannerSectionJsonField("planner-section-debts", "Debts", "Balances, due dates, status, and payoff behavior.", snapshot.debts, 8)}
        ${renderPlannerSectionJsonField("planner-section-housingConfig", "Housing config", "Rent or mortgage setup. Use null if not configured yet.", snapshot.housingConfig, 8)}
        ${renderPlannerSectionJsonField("planner-section-housingBuckets", "Housing buckets", "Current and arrears bucket details.", snapshot.housingBuckets, 8)}
      </section>

      <section class="fx-panel">
        <p class="fx-eyebrow">Activity</p>
        <h2>Recorded activity and actuals</h2>
        ${renderPlannerSectionJsonField("planner-section-paychecks", "Paychecks", "Recorded real or forecasted paychecks.", snapshot.paychecks, 8)}
        ${renderPlannerSectionJsonField("planner-section-paycheckActions", "Paycheck actions", "Bill groups and essential allocations attached to paychecks.", snapshot.paycheckActions, 8)}
        ${renderPlannerSectionJsonField("planner-section-billPayments", "Bill payments", "Payments already made against bills.", snapshot.billPayments, 8)}
        ${renderPlannerSectionJsonField("planner-section-debtTransactions", "Debt transactions", "Debt payments, borrow events, and repayments.", snapshot.debtTransactions, 8)}
        ${renderPlannerSectionJsonField("planner-section-expenseSpends", "Expense spending", "Actual spend entries for recurring expenses.", snapshot.expenseSpends, 8)}
        ${renderPlannerSectionJsonField("planner-section-housingPayments", "Housing payments", "Actual rent or housing payment records.", snapshot.housingPayments, 8)}
        ${renderPlannerSectionJsonField("planner-section-cashAdjustments", "Cash adjustments", "Cash in, cash out, reimbursements, refunds, and corrections.", snapshot.cashAdjustments, 8)}
      </section>

      <section class="fx-panel">
        <p class="fx-eyebrow">Planning</p>
        <h2>Goals, rules, and preferences</h2>
        ${renderPlannerSectionJsonField("planner-section-goals", "Goals", "Savings and target goals.", snapshot.goals, 8)}
        ${renderPlannerSectionJsonField("planner-section-deductionRules", "Paycheck rules", "Mandatory or optional paycheck deductions.", snapshot.deductionRules, 8)}
        ${renderPlannerSectionJsonField("planner-section-settings", "Planner settings", "Planning preferences, reserve rules, scenario mode, and safety settings.", snapshot.settings, 10)}
      </section>

      <section class="fx-panel">
        <p class="fx-eyebrow">App</p>
        <h2>Organization and reminders</h2>
        ${renderPlannerSectionJsonField("planner-section-categories", "Categories", "User-defined categories.", snapshot.categories, 6)}
        ${renderPlannerSectionJsonField("planner-section-labels", "Custom labels", "User-defined labels.", snapshot.labels, 6)}
        ${renderPlannerSectionJsonField("planner-section-notificationSettings", "Notification settings", "Payday and planner reminder settings.", snapshot.notificationSettings, 8)}
      </section>

      <section class="fx-panel">
        <p class="fx-eyebrow">Data</p>
        <h2>Backup and app metadata</h2>
        ${renderPlannerSectionJsonField("planner-section-exportMetadata", "Export metadata", "Backup/import metadata saved in the snapshot.", snapshot.exportMetadata, 6)}
        ${renderPlannerSectionJsonField("planner-section-demoModeState", "Demo mode state", "App mode metadata carried in the canonical snapshot.", snapshot.demoModeState, 6)}
      </section>
    </form>
    <section class="fx-panel fx-panel--highlight">
      <p class="fx-eyebrow">Planner data</p>
      <h2>Save full planner inputs for this account</h2>
      <p class="muted">This editor saves the canonical <code>PlannerSnapshot</code> JSON for your signed-in account, including accounts, income, paychecks, bills, expenses, debts, housing, goals, paycheck rules, categories, labels, notifications, and planner settings.</p>
      <div class="row" style="margin:12px 0">
        <button type="button" class="secondary" id="btn-planner-template" ${state.plannerSnapshotSaveBusy ? "disabled" : ""}>Load starter template</button>
        <button type="button" class="secondary" id="btn-planner-reset" ${state.plannerSnapshotSaveBusy ? "disabled" : ""}>Reset to current saved snapshot</button>
        <button type="button" class="secondary" id="btn-planner-format" ${state.plannerSnapshotSaveBusy ? "disabled" : ""}>Format JSON</button>
        <button type="button" id="btn-planner-save" ${state.plannerSnapshotSaveBusy ? "disabled" : ""}>${state.plannerSnapshotSaveBusy ? "Saving…" : "Save planner inputs"}</button>
      </div>
      <p class="muted">Current row source: <strong>${escapeHtml(plannerState?.source_platform ?? "none yet")}</strong> · planner output: <strong>${plannerState?.plan ? "present" : "none"}</strong>. Saving from web clears any stale plan until the shared planner engine recalculates.</p>
      <label class="field" style="margin-top:12px">
        PlannerSnapshot JSON
        <textarea id="field-planner-snapshot" rows="28" spellcheck="false" style="width:100%;font-family:ui-monospace,SFMono-Regular,Consolas,monospace">${escapeHtml(
          state.plannerSnapshotDraft || plannerSnapshotPretty(snapshotSource),
        )}</textarea>
      </label>
      ${state.plannerSnapshotSaveError ? `<p class="error">${escapeHtml(state.plannerSnapshotSaveError)}</p>` : ""}
    </section>
    </details>
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
    const txId = String(t.id ?? "");
    const merchant = t.details && typeof t.details === "object" && "counterparty" in (t.details as Record<string, unknown>)
      ? String(((t.details as Record<string, unknown>).counterparty as Record<string, unknown>)?.name ?? "")
      : "";
    const n = typeof amt === "number" ? amt : Number(amt);
    const cls = n >= 0 ? "amt-pos" : "amt-neg";
    return `
      <div class="tx">
        <div class="tx-main">
          <div class="tx-title">${escapeHtml(desc)}</div>
          <div class="tx-date">${escapeHtml(date)}</div>
        </div>
        <div class="${cls}">${money(n)}</div>
        <button type="button" class="secondary tx-adjust" data-categorize-tx="${escapeAttr(txId)}" data-categorize-desc="${escapeAttr(desc)}" data-categorize-merchant="${escapeAttr(merchant)}" data-categorize-amount="${escapeAttr(n)}" data-categorize-date="${escapeAttr(date)}" title="Adjust category or link to a bill/debt/expense">Adjust</button>
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
      ${renderSettingsEditorOverlay(state.normalizedSnapshot)}
      ${renderCategorizeOverlay(state.normalizedSnapshot)}
    </div>
  `;
}

function renderCategorizeOverlay(snap: PlannerSnapshot | null): string {
  const c = state.categorizeEditor;
  if (!c) return "";
  const busy = state.normalizedSnapshotBusy;
  const amountLabel = money(c.amount);
  const isCredit = c.amount > 0;
  const billOpts = (snap?.bills ?? []).map((b) =>
    `<option value="BILL:${escapeAttr(b.id)}">Bill · ${escapeHtml(b.name)}</option>`
  ).join("");
  const debtOpts = (snap?.debts ?? []).map((d) =>
    `<option value="DEBT:${escapeAttr(d.id)}">Debt · ${escapeHtml(d.name)}</option>`
  ).join("");
  const expenseOpts = (snap?.expenses ?? []).map((e) =>
    `<option value="EXPENSE:${escapeAttr(e.id)}">Expense · ${escapeHtml(e.name)}</option>`
  ).join("");
  const housingOpts = (snap?.housingBuckets ?? []).map((h) =>
    `<option value="HOUSING:${escapeAttr(h.id)}">Housing · ${escapeHtml(h.label)}</option>`
  ).join("");
  const goalOpts = (snap?.goals ?? []).map((g) =>
    `<option value="GOAL:${escapeAttr(g.id)}">Goal · ${escapeHtml(g.name)}</option>`
  ).join("");
  const cashOpts = isCredit
    ? `<option value="CASH_IN:">Cash in (untracked deposit)</option>`
    : `<option value="CASH_OUT:">Cash out (untracked spend)</option>`;
  return `
    <div class="fx-auth-modal fx-auth-modal--open" role="dialog" aria-modal="true" aria-labelledby="categorize-title">
      <button type="button" class="fx-auth-modal__backdrop" data-categorize-cancel aria-label="Close"></button>
      <div class="fx-auth-modal__panel" style="max-width:620px">
        <div class="fx-auth-modal__chrome">
          <h2 id="categorize-title" class="fx-auth-modal__title">Adjust this transaction</h2>
          <button type="button" class="fx-auth-modal__close" data-categorize-cancel aria-label="Close">×</button>
        </div>
        <form id="form-categorize" class="fx-auth-modal__form list" data-tx-id="${escapeAttr(c.txId)}" data-tx-desc="${escapeAttr(c.description)}" data-tx-merchant="${escapeAttr(c.merchant ?? "")}" data-tx-amount="${escapeAttr(c.amount)}" data-tx-date="${escapeAttr(c.postedDate ?? "")}">
          <p class="muted" style="margin:0 0 4px">This updates how the planner treats a transaction that came from your bank sync. It does <strong>not</strong> create a transaction — only your bank can do that.</p>
          <div class="fx-mini-list" style="margin:8px 0">
            <article class="fx-mini-list__item">
              <div>
                <strong>${escapeHtml(c.description)}</strong>
                <p>${escapeHtml(c.postedDate ?? "")}${c.merchant ? ` · ${escapeHtml(c.merchant)}` : ""}</p>
              </div>
              <span>${amountLabel}</span>
            </article>
          </div>
          <div class="field">
            <span style="font-weight:600">Link to</span>
            <select name="target">
              <option value="UNCATEGORIZED:">(Uncategorized · leave out of planner actuals)</option>
              ${cashOpts}
              ${billOpts}
              ${debtOpts}
              ${expenseOpts}
              ${housingOpts}
              ${goalOpts}
            </select>
            <span class="muted">Picking a bill, debt, expense, or housing bucket posts this transaction as a planner actual so the plan recomputes against it.</span>
          </div>
          <label class="field">Note<input name="note" placeholder="Optional note" /></label>
          <div class="row" style="justify-content:flex-end;margin-top:12px">
            <button type="button" class="secondary" data-categorize-cancel>Cancel</button>
            <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Save adjustment"}</button>
          </div>
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
        </form>
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
  const plannerSnapshotInput = document.querySelector<HTMLTextAreaElement>("#field-planner-snapshot");

  document.querySelector<HTMLButtonElement>("#btn-signout")?.addEventListener("click", async () => {
    state.busy = true;
    render();
    await supabase.auth.signOut();
    state.session = null;
    state.profile = null;
    state.plannerSnapshot = null;
    state.plannerSnapshotDraft = "";
    state.plannerSnapshotDirty = false;
    state.plannerSnapshotSaveBusy = false;
    state.plannerSnapshotSaveError = null;
    state.plannerLoadError = null;
    state.plannerSyncBusy = false;
    state.accounts = [];
    state.transactions = [];
    state.categorizeEditor = null;
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

  document.querySelector<HTMLFormElement>("#form-planner-sections")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      const snapshot = collectPlannerSnapshotFromSectionForm(e.target as HTMLFormElement);
      state.plannerSnapshotDraft = plannerSnapshotPretty(snapshot);
      state.plannerSnapshotDirty = true;
      state.plannerSnapshotSaveError = null;
      await savePlannerSnapshotDraft();
    } catch (err) {
      window.alert(err instanceof Error ? `Could not save planner sections: ${err.message}` : "Could not save planner sections.");
    }
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

  plannerSnapshotInput?.addEventListener("input", () => {
    state.plannerSnapshotDraft = plannerSnapshotInput.value;
    state.plannerSnapshotDirty = true;
    state.plannerSnapshotSaveError = null;
  });

  document.querySelector<HTMLButtonElement>("#btn-planner-save")?.addEventListener("click", () => {
    void savePlannerSnapshotDraft();
  });

  document.querySelector<HTMLButtonElement>("#btn-planner-reset")?.addEventListener("click", () => {
    resetPlannerSnapshotDraftToCurrent();
  });

  document.querySelector<HTMLButtonElement>("#btn-planner-template")?.addEventListener("click", () => {
    seedPlannerSnapshotDraftWithTemplate();
  });

  document.querySelector<HTMLButtonElement>("#btn-planner-format")?.addEventListener("click", () => {
    formatPlannerSnapshotDraft();
  });

  document.querySelectorAll<HTMLButtonElement>("[data-pick-account]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const id = btn.getAttribute("data-pick-account");
      if (!id) return;
      state.selectedAccountId = id;
      void loadTransactions();
    });
  });

  document.querySelector<HTMLButtonElement>("#btn-recompute-plan")?.addEventListener("click", () => {
    void loadNormalizedAndRecompute({ persist: true });
  });

  wireSettingsEditorButtons();
  wireCategorizeButtons();
}

function wireCategorizeButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-categorize-tx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const txId = btn.getAttribute("data-categorize-tx") ?? "";
      if (!txId) return;
      const description = btn.getAttribute("data-categorize-desc") ?? "";
      const merchant = btn.getAttribute("data-categorize-merchant") ?? "";
      const amount = Number(btn.getAttribute("data-categorize-amount") ?? 0);
      const postedDate = btn.getAttribute("data-categorize-date") ?? "";
      state.categorizeEditor = {
        txId,
        description,
        merchant: merchant || null,
        amount: Number.isFinite(amount) ? amount : 0,
        postedDate: postedDate || null,
      };
      state.error = null;
      render();
    });
  });
  document.querySelectorAll<HTMLElement>("[data-categorize-cancel]").forEach((el) => {
    el.addEventListener("click", () => {
      state.categorizeEditor = null;
      state.error = null;
      render();
    });
  });
  document.querySelector<HTMLFormElement>("#form-categorize")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const form = e.target as HTMLFormElement;
    const userId = state.session?.user?.id;
    if (!userId) return;
    const fd = new FormData(form);
    const targetRaw = String(fd.get("target") ?? "UNCATEGORIZED:");
    const [kindRaw, idRaw] = targetRaw.split(":");
    const kind = (kindRaw || "UNCATEGORIZED").toUpperCase() as PlannerActualTarget["kind"];
    const id = (idRaw ?? "").trim();
    const note = String(fd.get("note") ?? "").trim();
    const txId = form.getAttribute("data-tx-id") ?? "";
    const description = form.getAttribute("data-tx-desc") ?? "";
    const merchant = form.getAttribute("data-tx-merchant") ?? "";
    const amount = Number(form.getAttribute("data-tx-amount") ?? 0);
    const postedDate = form.getAttribute("data-tx-date") ?? "";
    if (!txId) return;
    await withRecompute(async () => {
      await saveTransactionCategorization(userId, {
        transactionId: txId,
        categoryKind: kind,
        billId: kind === "BILL" ? id : null,
        debtId: kind === "DEBT" ? id : null,
        expenseId: kind === "EXPENSE" ? id : null,
        goalId: kind === "GOAL" ? id : null,
        housingBucketId: kind === "HOUSING" ? id : null,
        note,
        isUserOverride: true,
      });
      const txRef = {
        id: txId,
        description,
        merchant,
        amount,
        postedDate: postedDate || null,
      };
      if (kind === "BILL" || kind === "DEBT" || kind === "EXPENSE" || kind === "HOUSING") {
        if (id) {
          await linkTransactionToPlannerActual(userId, txId, { kind, id }, txRef, "Manual");
        }
      } else {
        // UNCATEGORIZED, CASH_IN, CASH_OUT, GOAL, INCOME: remove any planner actual tied to this tx
        await deleteTransactionLinkedActuals(userId, txId);
      }
    }, "Transaction adjusted and plan recomputed.");
    state.categorizeEditor = null;
    render();
  });
}

function wireSettingsEditorButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-settings-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-settings-add") as SettingsEditorState["kind"] | null;
      if (!kind) return;
      state.settingsEditor = kind === "housing"
        ? { kind }
        : kind === "planner-settings"
          ? { kind }
          : { kind } as SettingsEditorState;
      state.error = null;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-settings-edit]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-settings-edit") as SettingsEditorState["kind"] | null;
      const id = btn.getAttribute("data-settings-id") ?? undefined;
      if (!kind) return;
      state.settingsEditor = { kind, id } as SettingsEditorState;
      state.error = null;
      render();
    });
  });
  document.querySelectorAll<HTMLButtonElement>("[data-settings-delete]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const kind = btn.getAttribute("data-settings-delete") as SettingsEditorState["kind"] | null;
      const id = btn.getAttribute("data-settings-id");
      if (!kind || !id) return;
      if (!confirm("Remove this item and recompute?")) return;
      const userId = state.session?.user?.id;
      if (!userId) return;
      await withRecompute(async () => {
        switch (kind) {
          case "bill": await deleteBill(userId, id); break;
          case "income": await deleteIncomeSource(userId, id); break;
          case "debt": await deleteDebt(userId, id); break;
          case "expense": await deleteRecurringExpense(userId, id); break;
          case "goal": await deleteGoal(userId, id); break;
        }
      }, "Removed and recomputed.");
    });
  });
  document.querySelectorAll<HTMLElement>("[data-settings-editor-cancel]").forEach((el) => {
    el.addEventListener("click", () => {
      state.settingsEditor = null;
      state.error = null;
      render();
    });
  });

  const editorForm = document.querySelector<HTMLFormElement>("#form-settings-editor");
  if (editorForm) {
    editorForm.addEventListener("submit", (e) => {
      e.preventDefault();
      void submitSettingsEditor(editorForm);
    });
    editorForm.querySelector<HTMLButtonElement>("[data-settings-editor-delete]")?.addEventListener("click", async () => {
      const kind = editorForm.getAttribute("data-editor-kind") as SettingsEditorState["kind"] | null;
      const id = editorForm.getAttribute("data-editor-id") ?? "";
      const userId = state.session?.user?.id;
      if (!kind || !id || !userId) return;
      if (!confirm("Remove this item and recompute?")) return;
      await withRecompute(async () => {
        switch (kind) {
          case "bill": await deleteBill(userId, id); break;
          case "income": await deleteIncomeSource(userId, id); break;
          case "debt": await deleteDebt(userId, id); break;
          case "expense": await deleteRecurringExpense(userId, id); break;
          case "goal": await deleteGoal(userId, id); break;
        }
      }, "Removed and recomputed.");
      state.settingsEditor = null;
      render();
    });
  }
}

async function submitSettingsEditor(form: HTMLFormElement) {
  const kind = form.getAttribute("data-editor-kind") as SettingsEditorState["kind"] | null;
  const id = form.getAttribute("data-editor-id") || undefined;
  const userId = state.session?.user?.id;
  if (!kind || !userId) return;
  const fd = new FormData(form);
  const getStr = (k: string) => String(fd.get(k) ?? "").trim();
  const getNum = (k: string) => {
    const v = fd.get(k);
    if (v === null || v === undefined || v === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const readRule = (prefix: string) => ({
    type: getStr(`${prefix}_type`) as "ONE_TIME" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "SEMI_MONTHLY" | "MONTHLY" | "QUARTERLY" | "YEARLY" | "EVERY_X_DAYS" | "CUSTOM_INTERVAL",
    anchorDate: getStr(`${prefix}_anchor`) || undefined,
    dayOfMonth: getNum(`${prefix}_dayOfMonth`) ?? undefined,
    intervalDays: getNum(`${prefix}_intervalDays`) ?? undefined,
  });

  const result = await withRecompute(async () => {
    switch (kind) {
      case "bill":
        await saveBill(userId, {
          id, name: getStr("name"),
          amountDue: getNum("amountDue") ?? 0,
          minimumDue: getNum("minimumDue") ?? 0,
          currentAmountDue: getNum("currentAmountDue") ?? 0,
          category: getStr("category"),
          isEssential: fd.get("isEssential") === "on",
          paymentPolicy: (getStr("paymentPolicy") as "HARD_DUE" | "FLEXIBLE_DUE") || "HARD_DUE",
          recurringRule: readRule("rule"),
        });
        break;
      case "income":
        await saveIncomeSource(userId, {
          id, name: getStr("name"), payerLabel: getStr("payerLabel"),
          amountRange: { minimum: getNum("minimum") ?? undefined, target: getNum("target") ?? undefined, maximum: getNum("maximum") ?? undefined },
          nextExpectedPayDate: getStr("nextExpectedPayDate") || null,
          isActive: fd.get("isActive") === "on",
          recurringRule: readRule("rule"),
        });
        break;
      case "debt": {
        const bankAccountId = getStr("bankAccountId") || null;
        const manualBalance = getNum("currentBalance") ?? getNum("currentBalanceFallback") ?? 0;
        const linkedAccount = bankAccountId
          ? state.normalizedSnapshot?.accounts.find((a) => a.id === bankAccountId) ?? null
          : null;
        const liveBalance = linkedAccount ? Math.abs(linkedAccount.currentBalance) : null;
        await saveDebt(userId, {
          id, name: getStr("name"), lender: getStr("lender"), type: getStr("type"),
          currentBalance: liveBalance ?? manualBalance,
          minimumDue: getNum("minimumDue") ?? 0,
          requiredDueDate: getStr("requiredDueDate") || null,
          bankAccountId,
        });
        break;
      }
      case "expense":
        await saveRecurringExpense(userId, {
          id, name: getStr("name"), amount: getNum("amount") ?? 0,
          isEssential: fd.get("isEssential") === "on",
          categoryLabel: getStr("categoryLabel"),
          recurringRule: readRule("rule"),
        });
        break;
      case "goal":
        await saveGoal(userId, {
          id, name: getStr("name"),
          targetAmount: getNum("targetAmount") ?? 0,
          currentAmount: getNum("currentAmount") ?? 0,
          isActive: fd.get("isActive") === "on",
        });
        break;
      case "housing":
        await saveHousingConfig(userId, {
          currentMonthlyRent: getNum("currentMonthlyRent") ?? 0,
          minimumAcceptablePayment: getNum("minimumAcceptablePayment") ?? 0,
          rentDueDay: getNum("rentDueDay") ?? 1,
          arrangement: getStr("arrangement"),
        });
        break;
      case "planner-settings":
        await savePlannerSettings(userId, {
          targetBuffer: getNum("targetBuffer") ?? 0,
          horizonDays: getNum("horizonDays") ?? 120,
          selectedScenarioMode: (getStr("selectedScenarioMode") as "FIXED" | "LOWEST_INCOME" | "MOST_EFFICIENT" | "HIGHEST_INCOME") || "FIXED",
        });
        break;
    }
  }, "Saved and recomputed.");

  if (result !== null) {
    state.settingsEditor = null;
    render();
  }
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
        await loadNormalizedAndRecompute({ persist: true });
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
          await loadNormalizedAndRecompute({ persist: true });
          await refreshBankData();
        } catch (e) {
          state.error = e instanceof Error ? e.message : String(e);
        }
      } else {
        state.profile = null;
        state.plannerSnapshot = null;
        state.plannerSnapshotDraft = "";
        state.plannerSnapshotDirty = false;
        state.plannerSnapshotSaveBusy = false;
        state.plannerSnapshotSaveError = null;
        state.plannerLoadError = null;
        state.plannerSyncBusy = false;
        state.normalizedSnapshot = null;
        state.normalizedSnapshotBusy = false;
        state.normalizedSnapshotError = null;
        state.settingsEditor = null;
        state.categorizeEditor = null;
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
