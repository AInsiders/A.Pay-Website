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
  buildPlannerBackupPackage,
  currentUserId,
  deleteAllNormalizedPlannerData,
  deleteBill,
  deleteCustomLabel,
  deleteDebt,
  deleteDeductionRule,
  deleteGoal,
  deleteIncomeSource,
  deleteRecurringExpense,
  deleteUserCategory,
  importLegacySnapshotIntoNormalized,
  importPlannerBackupPackage,
  loadPlannerSnapshot as loadNormalizedSnapshot,
  recomputeAndPersistPlan,
  saveBill,
  saveCustomLabel,
  saveDebt,
  saveDeductionRule,
  saveGoal,
  saveHousingConfig,
  saveIncomeSource,
  savePlannerSettings,
  saveNotificationSettings,
  saveRecurringExpense,
  saveTransactionCategorization,
  saveTransactionSplits,
  saveUserCategory,
  loadTransactionAssignments,
  linkTransactionSplitsToPlannerActuals,
  upsertCategoryRuleFromAdjustment,
  type PlannerActualTarget,
  type PlannerBackupPackage,
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

/** Mirrors Android `SettingsGroup` / `SettingsDestination` IA. */
type SettingsGroupId = "setup" | "planning" | "app" | "data";

type SettingsLeafId =
  | "accounts"
  | "income"
  | "bills"
  | "expenses"
  | "debts"
  | "housing"
  | "goals"
  | "paycheck-rules"
  | "planner-preferences"
  | "profile"
  | "organization"
  | "notifications"
  | "backup";

type SettingsNav =
  | { tier: "home" }
  | { tier: "group"; group: SettingsGroupId }
  | { tier: "leaf"; group: SettingsGroupId; leaf: SettingsLeafId };

const SETTINGS_GROUP_ORDER: SettingsGroupId[] = ["setup", "planning", "app", "data"];

const SETTINGS_GROUP_META: Record<SettingsGroupId, { title: string; subtitle: string; description: string }> = {
  setup: {
    title: "Setup",
    subtitle: "Accounts, income, bills, expenses, debts, and housing",
    description: "Set up the money inputs the planner needs before it can give reliable answers.",
  },
  planning: {
    title: "Planning",
    subtitle: "Goals, paycheck rules, and planning preferences",
    description: "Shape how extra money, paycheck carve-outs, and planning preferences behave.",
  },
  app: {
    title: "App",
    subtitle: "Account, notifications, and organization",
    description: "Profile, reminders, and the labels that keep your data easier to read.",
  },
  data: {
    title: "Data",
    subtitle: "Backup, import, export, and reset",
    description: "Protect your data and restore it when you move devices or need a clean reset.",
  },
};

const SETTINGS_LEAVES: Record<SettingsGroupId, SettingsLeafId[]> = {
  setup: ["accounts", "income", "bills", "expenses", "debts", "housing"],
  planning: ["goals", "paycheck-rules", "planner-preferences"],
  app: ["profile", "organization", "notifications"],
  data: ["backup"],
};

const SETTINGS_LEAF_META: Record<
  SettingsLeafId,
  { title: string; subtitle: string; description: string; openAccounts?: boolean }
> = {
  accounts: {
    title: "Accounts",
    subtitle: "Cash, bank, wallet, and balances",
    description:
      "Manual balances and Teller bank linking (same flow as the Accounts tab) feed cash available, deposit routing, and every live plan update.",
    openAccounts: true,
  },
  income: {
    title: "Income",
    subtitle: "Pay sources, schedules, and variability",
    description: "Income rules drive forecast timing, scenario projections, and paycheck previews.",
  },
  bills: {
    title: "Bills",
    subtitle: "Hard dues, subscriptions, and due rules",
    description:
      "Add each bill you must plan for. For charges already on your bank feed, use Accounts → Tag on the transaction when auto-detect misses.",
  },
  expenses: {
    title: "Expenses",
    subtitle: "Essential and recurring living costs",
    description: "Expenses shape essentials forecasting and tell the planner what normal life costs to expect.",
  },
  debts: {
    title: "Debts",
    subtitle: "Balances, due dates, and payoff behavior",
    description: "Debts influence payoff strategy, feasibility, and re-borrow pressure.",
  },
  housing: {
    title: "Housing",
    subtitle: "Rent, arrears, and housing setup",
    description: "Housing settings shape current due pressure, arrears catch-up, and payment handling.",
  },
  goals: {
    title: "Goals",
    subtitle: "Saved targets that use truly free cash",
    description: "Goals track progress and paycheck timeline estimates without overriding protected obligations.",
  },
  "paycheck-rules": {
    title: "Paycheck rules",
    subtitle: "Deductions, savings, and paycheck carve-outs",
    description: "Paycheck rules reduce usable pay before it reaches planning cash.",
  },
  "planner-preferences": {
    title: "Planning preferences",
    subtitle: "Buffers, payoff, feasibility, and ordering rules",
    description: "Planning preferences adjust reserves, payoff style, safety floors, and housing strategy.",
  },
  profile: {
    title: "Account & profile",
    subtitle: "Display name, theme, and accent",
    description: "How you appear in A.Pay and how the web app looks on this device.",
  },
  organization: {
    title: "Organization",
    subtitle: "Categories and custom labels",
    description: "Categories and labels help group and name real-world data in a cleaner way.",
  },
  notifications: {
    title: "Notifications",
    subtitle: "Payday and planning reminders",
    description:
      "These preferences sync to your account. Push delivery is handled on your phone in the Android app.",
  },
  backup: {
    title: "Backup & reset",
    subtitle: "Import, export, and reset planner data",
    description: "Export a JSON backup compatible with the mobile app, import a backup file, or wipe and start clean.",
  },
};

function isSettingsGroupId(s: string): s is SettingsGroupId {
  return s === "setup" || s === "planning" || s === "app" || s === "data";
}

function parseSettingsNav(hash: string): SettingsNav {
  const parts = hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (parts[0] !== "settings") return { tier: "home" };
  const seg = parts.slice(1);
  if (seg.length === 0) return { tier: "home" };
  const g = seg[0]!;
  if (!isSettingsGroupId(g)) return { tier: "home" };
  if (seg.length === 1) return { tier: "group", group: g };
  const leafSlug = seg[1]!;
  if (leafSlug === "bank-linking") {
    return { tier: "leaf", group: "setup", leaf: "accounts" };
  }
  const allowed = SETTINGS_LEAVES[g];
  const leaf = allowed.find((l) => l === leafSlug);
  if (!leaf) return { tier: "group", group: g };
  return { tier: "leaf", group: g, leaf };
}

function settingsHashFor(nav: SettingsNav): string {
  if (nav.tier === "home") return "#/settings";
  if (nav.tier === "group") return `#/settings/${nav.group}`;
  return `#/settings/${nav.group}/${nav.leaf}`;
}

const APP_ONLY_ROUTES = new Set<RouteId>(["planner", "bills", "accounts", "settings"]);
const APP_PRIMARY_ROUTES = new Set<RouteId>(["home", "planner", "bills", "accounts", "settings"]);

const GUEST_HEADER_LINKS: { route: RouteId; label: string }[] = [
  { route: "home", label: "Home" },
  { route: "about", label: "About" },
  { route: "contact", label: "Contact" },
  { route: "privacy", label: "Privacy" },
  { route: "terms", label: "Terms" },
];

const APP_HEADER_LINKS: { route: RouteId; label: string }[] = [
  { route: "home", label: "Home" },
  { route: "planner", label: "Planner" },
  { route: "bills", label: "Bills" },
  { route: "accounts", label: "Accounts" },
  { route: "settings", label: "Settings" },
];
const PLANNER_SNAPSHOT_SELECT =
  "id, user_id, plan, snapshot, created_at, updated_at, source_platform, source_app_version, source_updated_at, planner_schema_version, planner_engine_version";

const CORE_SETUP_OPTIONS: WebSetupOption[] = [
  {
    title: "Accounts",
    subtitle: "Your cash, checking, and savings",
    description: "What you actually have available right now.",
  },
  {
    title: "Paychecks",
    subtitle: "When and how much you get paid",
    description: "So A.Pay can see when new money comes in.",
  },
  {
    title: "Bills",
    subtitle: "What you owe and when it's due",
    description: "So we can protect the money for each bill first.",
  },
  {
    title: "Expenses",
    subtitle: "Recurring living costs",
    description: "Groceries, gas, subscriptions — the everyday stuff.",
  },
  {
    title: "Debts",
    subtitle: "Balances and minimum payments",
    description: "Credit cards, loans, and anything you owe over time.",
  },
  {
    title: "Housing",
    subtitle: "Rent or mortgage",
    description: "So safe-to-spend keeps this covered first.",
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
  void ctx;
  const raw = err instanceof Error ? err.message || String(err) : String(err);

  let detail: string;
  if (/failed to fetch/i.test(raw)) {
    detail = "Couldn't reach the server. Check your connection and try again.";
  } else if (/failed to send a request to the edge function/i.test(raw)) {
    detail = "Couldn't reach our server right now. Please try again in a moment.";
  } else if (/401|unauthorized|jwt/i.test(raw)) {
    detail = "Your sign-in expired. Please sign out and sign back in.";
  } else if (/403|forbidden/i.test(raw)) {
    detail = "We're not able to complete that right now. Please try again.";
  } else if (/404/i.test(raw)) {
    detail = "Couldn't find that on our server. Please refresh and try again.";
  } else {
    detail = raw;
  }

  return `${prefix}: ${detail}`;
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

  const hint = typeof body.hint === "string" && body.hint.trim() ? body.hint.trim() : "";
  if (hint && hint !== main) lines.push(hint);

  const head = lines.filter(Boolean).join("\n");
  if (!head) {
    if (status === 401) {
      return "Your sign-in expired. Please sign out and sign back in.";
    }
    if (status === 404) {
      return "That resource is not available right now.";
    }
    if (status === 403) {
      return "We're not able to complete that right now.";
    }
    return "Something went wrong. Please try again.";
  }
  return head;
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
            return formatEdgeFunctionJsonBody({}, status);
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
  /** Summary of how each bank transaction is tagged / split, keyed by transaction id. Populated after we load transactions. */
  txAssignments: Record<string, TransactionAssignmentSummary>;
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
  categorizeEditor: {
    txId: string;
    description: string;
    merchant: string | null;
    amount: number;
    postedDate: string | null;
    splits: CategorizeSplitRow[];
    note: string;
    loadingAssignments: boolean;
  } | null;
} = {
  session: null,
  profile: null,
  plannerSnapshot: null,
  plannerSnapshotDraft: "",
  plannerSnapshotDirty: false,
  plannerSnapshotSaveBusy: false,
  plannerSnapshotSaveError: null,
  txAssignments: {},
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
  | { kind: "planner-settings" }
  | { kind: "deduction"; id?: string }
  | { kind: "category"; id?: string }
  | { kind: "label"; id?: string };

/** One row inside the multi-split category editor. `target` is "KIND:id" (e.g. "BILL:uuid") or KIND alone for cash flows. */
interface CategorizeSplitRow {
  id: string;
  target: string;
  amount: number;
  note: string;
}

/** Quick summary we display in the transactions list so the user sees at a glance how each item is categorized. */
interface TransactionAssignmentSummary {
  /** Primary category kind — CASH_IN, CASH_OUT, BILL, DEBT, EXPENSE, HOUSING, GOAL, UNCATEGORIZED, or SPLIT. */
  kind: string;
  /** Human label to show (e.g. the bill/debt/expense name). */
  label: string;
  /** Number of splits if the transaction was split across multiple categories. 0/1 means a single categorization. */
  splitCount: number;
  /** True if the user manually set this (instead of auto-categorize). */
  isUserOverride: boolean;
}

const app = document.querySelector<HTMLDivElement>("#app")!;


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
  const h = window.location.hash.replace(/^#\/?/, "").split("/").filter(Boolean);
  if (h.length === 0) return "home";
  return normalizeRouteId(h[0]!);
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
    await refreshTxAssignmentCache();
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
      const parts: string[] = [];
      parts.push(`Added ${summary.saved} transaction${summary.saved === 1 ? "" : "s"}`);
      if (summary.categorized > 0) parts.push(`auto-tagged ${summary.categorized}`);
      state.info = `${parts.join(" · ")}.`;
      await loadNormalizedAndRecompute({ persist: true });
    }
  } catch (e) {
    console.warn("auto-categorize failed", e);
  }
}

/**
 * Fetch a compact summary of categorizations + split counts for the currently
 * loaded transactions and store it in `state.txAssignments`. The UI reads this
 * to show "Bill · Rent", "Split (3)", or "Tag" on each row.
 */
async function refreshTxAssignmentCache(): Promise<void> {
  const userId = state.session?.user?.id;
  if (!userId) {
    state.txAssignments = {};
    return;
  }
  const txIds = (state.transactions as Record<string, unknown>[])
    .map((t) => String(t.id ?? ""))
    .filter((id) => id.length > 0);
  if (txIds.length === 0) {
    state.txAssignments = {};
    return;
  }
  try {
    const [catRes, splitRes] = await Promise.all([
      supabase
        .from("transaction_categorizations")
        .select("transaction_id, category_kind, bill_id, debt_id, expense_id, goal_id, housing_bucket_id, income_source_id, is_user_override")
        .eq("user_id", userId)
        .in("transaction_id", txIds),
      supabase
        .from("transaction_splits")
        .select("transaction_id")
        .eq("user_id", userId)
        .in("transaction_id", txIds),
    ]);

    const splitCounts: Record<string, number> = {};
    for (const row of splitRes.data ?? []) {
      const key = String((row as Record<string, unknown>).transaction_id ?? "");
      if (!key) continue;
      splitCounts[key] = (splitCounts[key] ?? 0) + 1;
    }

    const snap = state.normalizedSnapshot;
    const nameFor = (kind: string, id: string | null): string => {
      if (!id) return labelForKind(kind);
      if (!snap) return labelForKind(kind);
      if (kind === "BILL") return snap.bills.find((b) => b.id === id)?.name ?? "Bill";
      if (kind === "DEBT") return snap.debts.find((d) => d.id === id)?.name ?? "Debt";
      if (kind === "EXPENSE") return snap.expenses.find((e) => e.id === id)?.name ?? "Expense";
      if (kind === "GOAL") return snap.goals.find((g) => g.id === id)?.name ?? "Goal";
      if (kind === "HOUSING") return snap.housingBuckets.find((h) => h.id === id)?.label ?? "Housing";
      if (kind === "INCOME") {
        const s = snap.incomeSources.find((x) => x.id === id);
        return s?.name?.trim() || s?.payerLabel?.trim() || "Income";
      }
      return labelForKind(kind);
    };

    const out: Record<string, TransactionAssignmentSummary> = {};
    for (const row of catRes.data ?? []) {
      const r = row as Record<string, unknown>;
      const txId = String(r.transaction_id ?? "");
      if (!txId) continue;
      const rawKind = String(r.category_kind ?? "UNCATEGORIZED").toUpperCase();
      const splitCount = splitCounts[txId] ?? 0;
      const effectiveKind = splitCount > 1 ? "SPLIT" : rawKind;
      const idForKind =
        rawKind === "BILL" ? (r.bill_id as string | null)
        : rawKind === "DEBT" ? (r.debt_id as string | null)
        : rawKind === "EXPENSE" ? (r.expense_id as string | null)
        : rawKind === "GOAL" ? (r.goal_id as string | null)
        : rawKind === "HOUSING" ? (r.housing_bucket_id as string | null)
        : rawKind === "INCOME" ? (r.income_source_id as string | null)
        : null;
      out[txId] = {
        kind: effectiveKind,
        label: splitCount > 1 ? `Split (${splitCount})` : nameFor(rawKind, idForKind),
        splitCount,
        isUserOverride: r.is_user_override === true,
      };
    }
    state.txAssignments = out;
  } catch (e) {
    console.warn("failed to load transaction assignments", e);
  }
}

function labelForKind(kind: string): string {
  switch (kind.toUpperCase()) {
    case "BILL": return "Bill";
    case "DEBT": return "Debt";
    case "EXPENSE": return "Expense";
    case "GOAL": return "Goal";
    case "HOUSING": return "Housing";
    case "CASH_IN": return "Cash in";
    case "CASH_OUT": return "Cash out";
    case "INCOME": return "Income";
    case "SPLIT": return "Split";
    case "UNCATEGORIZED": return "Untagged";
    default: return kind.replace(/_/g, " ").toLowerCase();
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
            state.info = `Loaded your app data: ${result.importedEntities.join(", ")}.`;
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
  state.info = "Saved.";
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
    state.error = "Bank linking is not available in this build yet.";
    render();
    return;
  }
  if (!window.TellerConnect?.setup) {
    state.error = "Bank linking could not load. Please check your connection and try again. Ad blockers may be blocking it.";
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

/** Guest top nav — same chrome classes as the signed-in app for visual consistency. */
function guestNavLink(route: RouteId, label: string, current: RouteId) {
  const href = route === "home" ? "#/" : `#/${route}`;
  const active = route === current ? " is-active" : "";
  return `<a class="fx-app-nav__link${active}" href="${href}" data-nav="${route}">${escapeHtml(label)}</a>`;
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
                <select class="fx-select" name="topic" required>
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
        <div class="fx-stack">
          <section class="fx-app-hero fx-panel fx-panel--highlight" aria-labelledby="guest-home-title">
            <div>
              <p class="fx-eyebrow">Home</p>
              <h1 id="guest-home-title">Safe to spend</h1>
              <p class="fx-app-hero__value fx-app-hero__value--guest">Sign in to see yours</p>
              <p class="muted">
                A.Pay maps each paycheck to bills and essentials, holds cross-paycheck reserves, and keeps one honest “safe to spend”
                number up front—the same Home view you get after sign-in.
              </p>
            </div>
            <div class="fx-app-hero__meta">
              <span>Forecast: <strong>paycheck to paycheck</strong></span>
              <span>Bank sync: <strong>Teller</strong></span>
            </div>
            <div class="fx-scenario-strip" aria-label="Highlights">
              <span class="fx-scenario-pill">Liquid cash, spelled out</span>
              <span class="fx-scenario-pill">Bills before “extra”</span>
              <span class="fx-scenario-pill">Live safe-to-spend</span>
            </div>
            <div class="row" style="flex-wrap:wrap;gap:10px;margin-top:6px">
              <button type="button" id="btn-hero-cta">Create account or sign in</button>
              <button type="button" class="secondary js-open-auth">I already have an account</button>
            </div>
          </section>

          <div class="fx-metric-grid" aria-labelledby="guest-value-heading">
            <h2 id="guest-value-heading" class="visually-hidden">Why households use A.Pay</h2>
            <section class="fx-metric-card" aria-labelledby="guest-m1">
              <p class="fx-metric-card__label" id="guest-m1">Forecast</p>
              <strong>Across paydays</strong>
              <p>Map income to upcoming bills so shortfalls show up before they sting—not just today’s balance.</p>
            </section>
            <section class="fx-metric-card" aria-labelledby="guest-m2">
              <p class="fx-metric-card__label" id="guest-m2">Clarity</p>
              <strong>Safe to spend</strong>
              <p>See what is already earmarked for essentials, then spend what is left without guesswork.</p>
            </section>
            <section class="fx-metric-card" aria-labelledby="guest-m3">
              <p class="fx-metric-card__label" id="guest-m3">Sync</p>
              <strong>Real balances</strong>
              <p>Connect with Teller so deposits and debits keep the plan honest over time.</p>
            </section>
          </div>
        </div>
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
  const guestNavBlock = renderHeaderNavigation(
    "guest",
    route,
    `<div class="fx-nav-drawer__extras">
        <button type="button" class="secondary fx-nav-drawer__cta" id="btn-open-auth-drawer">Sign in</button>
      </div>`,
  );
  return `
    <div class="fx-root">
      <div class="fx-grid" aria-hidden="true"></div>
      <div class="fx-scan" aria-hidden="true"></div>
      <div class="fx-noise" aria-hidden="true"></div>

      <div class="shell">
        <header class="fx-header" role="banner">
          <div class="fx-brand">
            <div class="fx-brand__mark" aria-hidden="true"></div>
            <div class="fx-brand__text">
              <span class="fx-brand__name">A.Pay</span>
              <span class="fx-brand__tag">Forecast &amp; cash</span>
            </div>
          </div>
          ${guestNavBlock}
          <div class="fx-header__actions">
            <button type="button" id="btn-open-auth">Sign in</button>
          </div>
        </header>

        ${
          !isSupabaseConfigured
            ? `<div class="banner">A.Pay is in preview mode. Sign-in and bank linking are unavailable until the server is connected.</div>`
            : ""
        }
        ${state.error ? `<div class="banner banner--alert" role="alert">${escapeHtml(state.error)}</div>` : ""}
        ${renderPublicPage(route)}

        <footer class="fx-app-footer">
          <a href="#/privacy">Privacy</a>
          <a href="#/terms">Terms</a>
          <span>© ${new Date().getFullYear()} A.Pay</span>
        </footer>
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
          <p class="fx-auth-modal__lede">Secure sign-in. Your bills, paychecks, and bank link sync to your account.</p>
          ${
            !isSupabaseConfigured
              ? `<div class="banner" style="margin:10px 0 12px">
                  <strong>Preview mode.</strong> Sign-in will come online once this build is fully configured.
                </div>`
              : ""
          }
          <form id="form-signin" class="fx-auth-modal__form list">
            <label class="field">Email<input name="email" type="email" autocomplete="email" required placeholder="you@email.com" /></label>
            <label class="field">Password<input name="password" type="password" autocomplete="current-password" required placeholder="••••••••" /></label>
            <div class="row row--stretch">
              <button type="submit" class="fx-btn-block" ${disabled ? "disabled" : ""}>Sign in</button>
              <button type="button" class="secondary fx-btn-block" id="btn-signup" ${disabled ? "disabled" : ""}>Create account</button>
            </div>
            <div class="row row--stretch">
              <button type="button" class="secondary fx-btn-block" id="btn-magiclink" ${disabled ? "disabled" : ""}>Email me a magic link</button>
              <button type="button" class="secondary fx-btn-block" id="btn-forgot" ${disabled ? "disabled" : ""}>Forgot password</button>
            </div>
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

/** Burger + slide-out drawer (mobile / tablet) and centered pill nav (desktop). */
function renderHeaderNavigation(
  mode: "guest" | "app",
  highlightRoute: RouteId,
  extrasHtml: string,
): string {
  const items = mode === "guest" ? GUEST_HEADER_LINKS : APP_HEADER_LINKS;
  const link = mode === "guest" ? guestNavLink : appNavLink;
  const ariaLabel = mode === "guest" ? "Site" : "App navigation";
  const linksHtml = items.map((it) => link(it.route, it.label, highlightRoute)).join("");
  return `
    <div class="fx-nav-shell">
      <button type="button" class="fx-nav-toggle" id="btn-mobile-nav" aria-expanded="false" aria-controls="fx-nav-drawer" aria-label="Open menu">
        <span class="fx-nav-toggle__icon" aria-hidden="true"></span>
      </button>
      <div class="fx-nav-drawer" id="fx-nav-drawer" aria-label="${escapeHtml(ariaLabel)}">
        <button type="button" class="fx-nav-drawer__backdrop" id="btn-mobile-nav-backdrop" tabindex="-1" aria-label="Close menu"></button>
        <div class="fx-nav-drawer__panel">
          <div class="fx-nav-drawer__head">
            <span class="fx-nav-drawer__title">Menu</span>
            <button type="button" class="fx-nav-drawer__close" id="btn-mobile-nav-close" aria-label="Close menu">×</button>
          </div>
          <nav class="fx-app-nav" aria-label="${escapeHtml(ariaLabel)}">${linksHtml}</nav>
          ${extrasHtml}
        </div>
      </div>
    </div>
  `;
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
          <p class="fx-eyebrow">Start with</p>
          <h2>The basics</h2>
          ${renderSetupOptionList(CORE_SETUP_OPTIONS, "Nothing to add yet.")}
          <p class="muted" style="margin-top:12px">Open <a href="#/settings/setup">Settings → Setup</a> to add them in one guided place.</p>
        </section>
        <section class="fx-panel">
          <p class="fx-eyebrow">Then</p>
          <h2>${escapeHtml(secondaryTitle)}</h2>
          <p class="muted">${escapeHtml(secondaryBody)}</p>
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
          <h2>One plan, everywhere you go</h2>
          <p class="muted">A.Pay is an automatic bill planner and paycheck guide. It connects your income to your bills, shows exactly what is safe to spend, and stays in sync across every device you sign in on.</p>
        </section>
      `;
    case "contact":
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">Contact</p>
          <h2>Support</h2>
          <p class="muted">Reach out to the A.Pay team if you hit a problem or want to suggest an improvement.</p>
        </section>
      `;
    default:
      return "";
  }
}

function renderAppHome(plannerState: PlannerStateRow | null, plan: PlannerPlan | null) {
  void plannerState;
  const snap = state.normalizedSnapshot;
  if (!plan) {
    const quickAdd = `
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">Start here</p>
        <h2>Add your money setup</h2>
        <p class="muted">Tell A.Pay about your paychecks, bills, and housing. That is all it needs to show a real safe-to-spend amount.</p>
        <div class="row" style="flex-wrap:wrap;gap:8px;margin-top:10px">
          <button type="button" data-settings-add="income">Add paycheck</button>
          <button type="button" data-settings-add="bill">Add bill</button>
          <button type="button" data-settings-add="debt" class="secondary">Add debt</button>
          <button type="button" data-settings-add="expense" class="secondary">Add expense</button>
          <button type="button" data-settings-add="goal" class="secondary">Add goal</button>
          <button type="button" data-settings-add="housing" class="secondary">Set housing</button>
        </div>
        ${snap ? `<p class="muted" style="margin-top:12px">Currently on file: ${snap.incomeSources.length} paychecks · ${snap.bills.length} bills · ${snap.debts.length} debts · ${snap.expenses.length} expenses · ${snap.goals.length} goals${snap.housingConfig ? " · housing set" : ""}.</p>` : ""}
      </section>
    `;
    return `
      <div class="fx-stack">
        ${quickAdd}
        ${renderSetupStarter(
          "Home",
          "Not quite enough information yet",
          "A.Pay needs at least a paycheck, a couple of bills, and your housing to build a real plan.",
          "What happens next",
          "As soon as that is in place, this page will show your safe-to-spend amount, what is due soon, and what is handled.",
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
        <p class="muted">What is free after the next-income checkpoint: essentials, hard dues, and cross-paycheck reserves.</p>
      </div>
      <div class="fx-app-hero__meta">
        <span>Required in wallet: <strong>${money(protectedTotal)}</strong></span>
        <span>Short: <strong>${money(shortAmount)}</strong></span>
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

  `;
}

function renderPlannerWorkspace(plannerState: PlannerStateRow | null, plan: PlannerPlan | null) {
  void plannerState;
  const loadErr = state.plannerLoadError
    ? `<div class="banner banner--alert" role="alert">${escapeHtml(state.plannerLoadError)}</div>`
    : "";

  if (!plan) {
    const snap = state.normalizedSnapshot;
    const hasAny = snap && (snap.bills.length + snap.incomeSources.length + snap.debts.length + snap.expenses.length + snap.goals.length) > 0;
    return `
      <div class="fx-planner">
        ${loadErr}
        <section class="fx-paynow-hero">
          <div class="fx-paynow-hero__left">
            <p class="fx-eyebrow">Planner</p>
            <h1>${hasAny ? "Ready to build your plan" : "Let's set up your plan"}</h1>
            <p class="muted">${hasAny
              ? "Your setup is saved. Press the button to build your paycheck-to-paycheck plan."
              : "Add at least one paycheck, a few bills, and your housing so we can map every paycheck to what it must cover."}</p>
          </div>
          <div class="fx-paynow-hero__right">
            <button type="button" id="btn-recompute-plan" ${state.normalizedSnapshotBusy ? "disabled" : ""}>${state.normalizedSnapshotBusy ? "Building…" : "Build my plan"}</button>
            <button type="button" data-settings-add="income" class="secondary">Add paycheck</button>
            <button type="button" data-settings-add="bill" class="secondary">Add bill</button>
            <button type="button" data-settings-add="housing" class="secondary">Set housing</button>
          </div>
        </section>
        ${state.normalizedSnapshotError ? `<p class="error">${escapeHtml(state.normalizedSnapshotError)}</p>` : ""}
      </div>
    `;
  }

  const dash = plan.dashboard;
  const safe = planSafeToSpend(plan);
  const protectedTotal = planProtectedAmount(plan);
  const shortAmount = planAmountShort(plan);
  const overdueList = dash?.overdueNow ?? [];
  const dueTodayList = dash?.dueToday ?? [];
  const nextPaycheck = plan.nextPaycheckNeed;
  const paychecks = plan.timeline ?? [];
  const horizonDays = state.normalizedSnapshot?.settings?.horizonDays ?? 120;

  return `
    <div class="fx-planner">
      ${loadErr}

      <section class="fx-paynow-hero">
        <div class="fx-paynow-hero__left">
          <p class="fx-eyebrow">Safe to spend · right now</p>
          <h1 class="fx-paynow-hero__value ${safe > 0 ? "" : "is-zero"}">${money(safe)}</h1>
          <p class="muted">Wallet checkpoint: essentials to next income, hard dues, and amounts held for bills due after that paycheck.</p>
        </div>
        <div class="fx-paynow-hero__stats">
          <div class="fx-paynow-stat"><span>Required in wallet</span><strong>${money(protectedTotal)}</strong></div>
          <div class="fx-paynow-stat ${shortAmount > 0 ? "is-risk" : ""}"><span>Short</span><strong>${money(shortAmount)}</strong></div>
          <div class="fx-paynow-stat">
            <span>Next paycheck</span>
            <strong>${escapeHtml(nextPaycheck?.nextExpectedDate ?? "—")}</strong>
          </div>
        </div>
        <div class="fx-paynow-hero__actions">
          <button type="button" id="btn-recompute-plan" ${state.normalizedSnapshotBusy ? "disabled" : ""}>${state.normalizedSnapshotBusy ? "Updating…" : "Refresh plan"}</button>
        </div>
      </section>

      ${renderPlannerCheckpointSection(plan)}

      ${overdueList.length > 0 || dueTodayList.length > 0
        ? `<section class="fx-alert-rail">
            ${overdueList.length > 0
              ? `<article class="fx-alert fx-alert--critical">
                  <p class="fx-eyebrow">Overdue · pay first</p>
                  ${renderPlanLineList(overdueList)}
                </article>` : ""}
            ${dueTodayList.length > 0
              ? `<article class="fx-alert">
                  <p class="fx-eyebrow">Due today</p>
                  ${renderPlanLineList(dueTodayList)}
                </article>` : ""}
          </section>`
        : ""}

      ${renderWhatToDoWithLeftover(plan, safe, shortAmount)}

      <section class="fx-paycheck-stack">
        <header class="fx-paycheck-stack__head">
          <div>
            <p class="fx-eyebrow">Paycheck-to-paycheck</p>
            <h2>Each paycheck — what it covers</h2>
          </div>
          <p class="muted">Full plan through your <strong>${horizonDays}-day</strong> horizon (${paychecks.length} pay cycle${paychecks.length === 1 ? "" : "s"}), oldest → newest. Recomputes when you refresh or change income, bills, or balances.</p>
        </header>
        ${paychecks.length > 0
          ? `<div class="fx-paycheck-rail">${paychecks.map((p, i) => renderPaycheckCard(p, i + 1, paychecks.length)).join("")}</div>`
          : `<p class="muted">No upcoming paychecks yet. Add a paycheck in Settings.</p>`}
      </section>

    </div>
  `;
}

function formatReserveKindLabel(kind: string | undefined): string {
  switch (kind) {
    case "BILL":
      return "Bill";
    case "DEBT":
      return "Debt";
    case "RENT":
      return "Housing";
    case "EXPENSE":
      return "Expense";
    default:
      return kind?.replace(/_/g, " ").trim() || "Reserve";
  }
}

/** Interval checkpoint, named reserves, suggested essential split, first failure / post-deposit copy. */
function renderPlannerCheckpointSection(plan: PlannerPlan): string {
  const d = plan.dashboard;
  const required = d?.requiredCashNow ?? planProtectedAmount(plan);
  const essentials = d?.essentialsDueForCurrentInterval;
  const hard = d?.hardDueBeforeNextIncome;
  const cross = d?.crossPaycheckReserveTotal;
  const interval = d?.intervalDaysUntilNextIncome;
  const nextInc = d?.nextReliableIncomeDate;

  const intervalSentence =
    interval != null && nextInc
      ? `Looking ahead <strong>${interval}</strong> days until income on <strong>${escapeHtml(nextInc)}</strong>.`
      : interval != null
        ? `Planning interval: <strong>${interval}</strong> days until the next paycheck.`
        : "";

  const hasSplit =
    essentials != null ||
    hard != null ||
    (cross != null && cross > 0);
  const breakdown = hasSplit
    ? `<div class="fx-checkpoint-rows">
        ${essentials != null ? `<div class="fx-checkpoint-row"><span>Essentials (this interval)</span><strong>${money(essentials)}</strong></div>` : ""}
        ${hard != null ? `<div class="fx-checkpoint-row"><span>Hard dues before next income</span><strong>${money(hard)}</strong></div>` : ""}
        ${cross != null && cross > 0 ? `<div class="fx-checkpoint-row"><span>Cross-paycheck reserves</span><strong>${money(cross)}</strong></div>` : ""}
        <div class="fx-checkpoint-row is-total"><span>Required in wallet</span><strong>${money(required)}</strong></div>
      </div>`
    : `<div class="fx-checkpoint-rows">
        <div class="fx-checkpoint-row is-total"><span>Required in wallet</span><strong>${money(required)}</strong></div>
      </div>`;

  const reserves = (d?.reservesHeld ?? []).slice(0, 8);
  const reserveChips =
    reserves.length > 0
      ? `<div class="fx-reserve-chips" aria-label="Named reserves">${reserves
          .map(
            (r) =>
              `<span class="fx-chip" title="${escapeHtml(r.dueDate ?? "")}"><small>${escapeHtml(formatReserveKindLabel(r.reserveKind))}</small> ${escapeHtml(r.label)} · ${money(r.amount)}</span>`,
          )
          .join("")}</div>`
      : "";

  const essentialsChips = (d?.suggestedEssentialUse ?? []).filter((e) => e.suggestedFromSafeToSpend > 0.005).slice(0, 8);
  const essentialChipsHtml =
    essentialsChips.length > 0
      ? `<p class="muted" style="margin:14px 0 0">If you spend flexible cash, essentials with headroom this interval:</p>
         <div class="fx-essential-chips">${essentialsChips
           .map((e) => `<span class="fx-chip">${escapeHtml(e.label)} · up to ${money(e.suggestedFromSafeToSpend)}</span>`)
           .join("")}</div>`
      : "";

  const after = d?.safeToSpendAfterNextDeposit;
  const nextPay = plan.nextPaycheckNeed?.nextExpectedDate;
  const postDeposit =
    after != null && nextPay && (planAmountShort(plan) > 0 || planSafeToSpend(plan) <= 0)
      ? `<div class="fx-post-deposit">After the <strong>${escapeHtml(nextPay)}</strong> deposit clears, estimated flexible headroom is about <strong>${money(after)}</strong> if nothing else changes.</div>`
      : "";

  const ff = plan.firstFailure;
  const failureBlock =
    ff && (ff.shortage ?? 0) > 0
      ? `<div class="fx-first-failure" role="status">
           <strong>Short on ${escapeHtml(ff.obligationLabel ?? "protected cash")}</strong>
           ${
             ff.minimumRepairHint
               ? `<p class="muted" style="margin:6px 0 0">${escapeHtml(ff.minimumRepairHint)}</p>`
               : `<p class="muted" style="margin:6px 0 0">Short by ${money(ff.shortage ?? 0)}.</p>`
           }
         </div>`
      : "";

  return `
    <section class="fx-panel fx-checkpoint-panel">
      <p class="fx-eyebrow">Wallet checkpoint</p>
      <h3>What cash must cover first</h3>
      ${
        intervalSentence
          ? `<p class="muted" style="margin:8px 0 0">${intervalSentence}</p>`
          : `<p class="muted" style="margin:8px 0 0">Essentials and hard bills are reserved before flexible spending.</p>`
      }
      ${breakdown}
      ${reserveChips}
      ${essentialChipsHtml}
      ${postDeposit}
      ${failureBlock}
    </section>
  `;
}

/**
 * "What to do with what's left" — when safe-to-spend > 0, show concrete,
 * tappable next moves (extra debt payoff, top off goals, save safety buffer,
 * spend freely). When the user is short, show how to recover. Keeps the planner
 * focused on actions, not raw numbers.
 */
function renderWhatToDoWithLeftover(plan: PlannerPlan, safe: number, shortAmount: number): string {
  const snap = state.normalizedSnapshot;
  if (shortAmount > 0) {
    const missing = Math.max(0, shortAmount);
    const tips: string[] = [];
    if ((plan.whatCanBeDelayed ?? []).length > 0) {
      tips.push(`Consider delaying ${plan.whatCanBeDelayed![0].label} by a cycle — frees up ${money(plan.whatCanBeDelayed![0].amount)}.`);
    }
    if ((plan.nextPaycheckNeed?.targetToStayOnPlan ?? 0) > 0) {
      tips.push(`Next paycheck needs ${money(plan.nextPaycheckNeed!.targetToStayOnPlan!)} to stay on plan.`);
    }
    tips.push(`Cut or push back ${money(missing)} of non-essential spending to get current.`);
    return `
      <section class="fx-doplan fx-doplan--short">
        <div class="fx-doplan__head">
          <p class="fx-eyebrow">Action plan</p>
          <h2>Short by ${money(missing)} before the next-income checkpoint</h2>
          <p class="muted">Here's the fastest path back to a safe plan.</p>
        </div>
        <ul class="fx-doplan__list">
          ${tips.map((t) => `<li>${escapeHtml(t)}</li>`).join("")}
        </ul>
      </section>
    `;
  }
  if (safe <= 0) {
    return `
      <section class="fx-doplan">
        <div class="fx-doplan__head">
          <p class="fx-eyebrow">Action plan</p>
          <h2>Plan is balanced — $0 free to move</h2>
          <p class="muted">Everything is protected. No money to redirect right now; check back after the next paycheck.</p>
        </div>
      </section>
    `;
  }
  const actions: { icon: string; title: string; amount: string; detail: string; cta?: string; ctaKind?: string }[] = [];
  // 1. Top-of-mind: debt payoff if there is any
  const debts = (snap?.debts ?? []).filter((d) => (d.currentBalance ?? 0) > 0).slice(0, 2);
  debts.forEach((d) => {
    const suggest = Math.min(safe, Math.max(d.minimumDue ?? 0, Math.round((d.currentBalance ?? 0) * 0.05)));
    if (suggest <= 0) return;
    actions.push({
      icon: "💳",
      title: `Pay extra on ${d.name}`,
      amount: money(suggest),
      detail: `${money(d.currentBalance)} balance · min ${money(d.minimumDue)} each cycle. Extra goes straight to principal.`,
      cta: "Edit debt",
      ctaKind: "debt",
    });
  });
  // 2. Top off goals that are funded from "truly free" cash
  const activeGoals = (snap?.goals ?? []).filter((g) => g.isActive !== false && (g.targetAmount ?? 0) > (g.currentAmount ?? 0)).slice(0, 2);
  activeGoals.forEach((g) => {
    const remaining = Math.max(0, (g.targetAmount ?? 0) - (g.currentAmount ?? 0));
    const suggest = Math.min(safe, remaining, Math.max(25, Math.round(safe * 0.15)));
    if (suggest <= 0) return;
    actions.push({
      icon: "🎯",
      title: `Put into ${g.name}`,
      amount: money(suggest),
      detail: `${money(g.currentAmount)} / ${money(g.targetAmount)} · ${money(remaining)} to finish.`,
      cta: "Edit goal",
      ctaKind: "goal",
    });
  });
  // 3. Safety buffer (always)
  if (safe >= 50) {
    actions.push({
      icon: "🛟",
      title: "Add to your safety buffer",
      amount: money(Math.min(safe, Math.max(100, Math.round(safe * 0.1)))),
      detail: "Protects against unexpected bills and keeps next month's plan stable.",
      cta: "Edit preferences",
      ctaKind: "planner-settings",
    });
  }
  // 4. Free spend (always)
  actions.push({
    icon: "🟢",
    title: "Spend freely",
    amount: money(safe),
    detail: "This amount is not protecting any bill, debt, or essential. It's yours to spend.",
  });
  return `
    <section class="fx-doplan">
      <div class="fx-doplan__head">
        <p class="fx-eyebrow">What to do with ${money(safe)} free</p>
        <h2>Smart moves with your leftover</h2>
        <p class="muted">These are safe because every bill, housing payment, and debt minimum is already protected.</p>
      </div>
      <div class="fx-doplan__grid">
        ${actions.map((a) => `
          <article class="fx-doplan__card">
            <div class="fx-doplan__card-head">
              <span class="fx-doplan__icon" aria-hidden="true">${a.icon}</span>
              <div>
                <strong>${escapeHtml(a.title)}</strong>
                <p class="fx-doplan__amt">${escapeHtml(a.amount)}</p>
              </div>
            </div>
            <p class="muted">${escapeHtml(a.detail)}</p>
            ${a.cta && a.ctaKind ? `<button type="button" class="secondary" data-settings-add="${escapeAttr(a.ctaKind)}">${escapeHtml(a.cta)}</button>` : ""}
          </article>
        `).join("")}
      </div>
    </section>
  `;
}

function renderPlanLineList(items: { label: string; amount: number; dueDate?: string; rationale?: string }[]): string {
  if (!items.length) return `<p class="muted" style="margin:0">Nothing here.</p>`;
  return `<ul class="fx-pay-line-list">${items.slice(0, 6).map((it) => `
    <li class="fx-pay-line">
      <div class="fx-pay-line__main">
        <strong>${escapeHtml(it.label)}</strong>
        <span class="muted">${escapeHtml(it.rationale ?? it.dueDate ?? "")}</span>
      </div>
      <strong class="fx-pay-line__amt">${money(it.amount)}</strong>
    </li>
  `).join("")}</ul>`;
}

function paycheckDateLabel(iso?: string): string {
  if (!iso) return "";
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
  if (!m) return iso;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
}

function bucketLabel(bucket?: string): string {
  switch ((bucket ?? "").toUpperCase()) {
    case "DEDUCTION": return "Deductions";
    case "ESSENTIALS": return "Essentials";
    case "BILL": return "Bills";
    case "DEBT_MINIMUM": return "Debt minimums";
    case "HOUSING_CURRENT": return "Housing";
    case "HOUSING_ARREARS": return "Past-due housing";
    case "BORROW_REPAYMENT": return "Borrow repayment";
    case "RESERVE": return "Reserves";
    case "EXTRA_PAYOFF": return "Extra payoff";
    case "GOAL": return "Goals";
    case "SAVINGS_BUFFER": return "Safety buffer";
    default: return "Other";
  }
}

function renderPaycheckCard(
  p: import("./planner-state").PlannerTimelinePaycheckPlan,
  step?: number,
  total?: number,
): string {
  const allocations = p.allocations ?? [];
  const grouped = new Map<string, { total: number; lines: { label: string; amount: number }[] }>();
  for (const a of allocations) {
    const key = (a.bucket ?? "OTHER").toUpperCase();
    const amount = a.amount ?? 0;
    const entry = grouped.get(key) ?? { total: 0, lines: [] };
    entry.total += amount;
    entry.lines.push({ label: a.label, amount });
    grouped.set(key, entry);
  }
  const bucketOrder = [
    "DEDUCTION",
    "ESSENTIALS",
    "HOUSING_CURRENT",
    "HOUSING_ARREARS",
    "BILL",
    "DEBT_MINIMUM",
    "BORROW_REPAYMENT",
    "RESERVE",
    "EXTRA_PAYOFF",
    "GOAL",
    "SAVINGS_BUFFER",
    "OTHER",
  ];
  const bucketsHtml = bucketOrder
    .filter((k) => grouped.has(k))
    .map((k) => {
      const g = grouped.get(k)!;
      return `
        <div class="fx-pay-bucket">
          <div class="fx-pay-bucket__head">
            <span class="fx-pay-bucket__label">${escapeHtml(bucketLabel(k))}</span>
            <strong class="fx-pay-bucket__total">${money(-g.total)}</strong>
          </div>
          <ul class="fx-pay-bucket__lines">
            ${g.lines
              .sort((a, b) => b.amount - a.amount)
              .map((l) => `<li><span>${escapeHtml(l.label)}</span><span>${money(-l.amount)}</span></li>`)
              .join("")}
          </ul>
        </div>
      `;
    })
    .join("");
  const reserves = p.reserveNowList ?? [];
  const reserveWindowDays = state.normalizedSnapshot?.settings?.reserveNearFutureWindowDays ?? 21;
  const reservesHtml = reserves.length > 0 ? `
    <div class="fx-pay-bucket fx-pay-bucket--reserve">
      <div class="fx-pay-bucket__head">
        <span class="fx-pay-bucket__label">Set aside from this deposit</span>
        <strong class="fx-pay-bucket__total">${money(reserves.reduce((s, r) => s + r.amount, 0))}</strong>
      </div>
      <p class="muted" style="margin:0 0 8px;font-size:0.78rem;line-height:1.35">Only items due <strong>after</strong> your next deposit and within the next <strong>${reserveWindowDays}</strong> days (same window as the app). Nothing from other pay cycles is listed here.</p>
      <ul class="fx-pay-bucket__lines">
        ${reserves.map((r) => `<li><span>${escapeHtml(r.label)} <span class="muted">(${escapeHtml(r.dueDate ?? "")})</span></span><span>${money(r.amount)}</span></li>`).join("")}
      </ul>
    </div>
  ` : "";
  const deductionAmount = p.deductionAmount ?? 0;
  const showDeductionLine = deductionAmount > 0 && !grouped.has("DEDUCTION");
  const deductionHtml = showDeductionLine ? `
    <div class="fx-pay-bucket">
      <div class="fx-pay-bucket__head">
        <span class="fx-pay-bucket__label">Deductions</span>
        <strong class="fx-pay-bucket__total">${money(-deductionAmount)}</strong>
      </div>
    </div>
  ` : "";
  const usable = p.usableAmount ?? 0;
  const left = p.amountLeftAfterAllocations ?? 0;
  const leftClass = left >= 0 ? "fx-pay-foot__amt" : "fx-pay-foot__amt is-risk";
  return `
    <article class="fx-paycheck">
      <header class="fx-paycheck__head">
        <div>
          <span class="fx-paycheck__date">${escapeHtml(paycheckDateLabel(p.date) || p.date || "")}</span>
          <strong class="fx-paycheck__label">${escapeHtml(p.payerLabel ?? "Paycheck")}</strong>
          ${step != null && total != null ? `<span class="fx-paycheck__step">Pay cycle ${step} of ${total}</span>` : ""}
        </div>
        <div class="fx-paycheck__in">
          <span class="muted">Usable pay</span>
          <strong>+${money(usable)}</strong>
        </div>
      </header>
      <div class="fx-pay-body">
        ${deductionHtml}
        ${bucketsHtml || `<p class="muted">Nothing to pay from this paycheck — all allocations cleared.</p>`}
        ${reservesHtml}
      </div>
      <footer class="fx-paycheck__foot">
        <span class="muted">Left over</span>
        <strong class="${leftClass}">${money(left)}</strong>
      </footer>
    </article>
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
      <h2>Your accounts &amp; bank</h2>
      <p class="muted">Connect a bank so A.Pay pulls your real balances and transactions automatically.</p>
      <div class="row">
        <button type="button" id="btn-teller" ${busy ? "disabled" : ""}>Connect my bank</button>
        <button type="button" class="secondary" id="btn-refresh" ${busy ? "disabled" : ""}>Refresh</button>
      </div>
      ${
        !tellerReady
          ? `<p class="muted" style="margin-top:12px">Bank linking is unavailable in this preview build.</p>`
          : ""
      }
      ${stateError && rows.length === 0 ? `<p class="error" style="margin-top:12px">${escapeHtml(stateError)}</p>` : ""}
    </section>

    <div class="fx-layout fx-layout--split">
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Accounts</p>
          <h2>Your accounts</h2>
          ${
            rows.length
              ? `<div class="list">${rows.join("")}</div>`
              : `<p class="muted">No accounts yet. Connect your bank above to pull live balances.</p>`
          }
        </section>
      </div>
      <div class="fx-stack">
        <section class="fx-panel">
          <p class="fx-eyebrow">Activity</p>
          <h2>Transactions</h2>
          <p class="muted" style="margin-top:0">Click <strong>Adjust</strong> on any transaction to tag it or split it across categories.</p>
          <div class="tx-feed">
            ${
              txRows.length
                ? txRows.join("")
                : `<p class="muted" style="padding:16px;margin:0">${
                    rows.length
                      ? "Pick an account above to see its transactions."
                      : "Transactions appear here after you connect your bank."
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
  title: string; eyebrow: string; description: string;
  addKind?: SettingsEditorState["kind"];
  items: string[]; emptyCopy: string;
}) {
  const addBtn = opts.addKind
    ? `<div class="fx-planner-head__actions">
          <button type="button" data-settings-add="${opts.addKind}" class="secondary">Add new</button>
        </div>`
    : "";
  return `
    <section class="fx-panel">
      <div class="fx-planner-head__row">
        <div>
          <p class="fx-eyebrow">${escapeHtml(opts.eyebrow)}</p>
          <h2>${escapeHtml(opts.title)}</h2>
          <p class="muted">${escapeHtml(opts.description)}</p>
        </div>
        ${addBtn}
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

function renderDeductionRow(r: { id: string; name: string; scope?: string; valueType?: string; fixedAmount?: number; percentage?: number; status?: string }): string {
  const vt = r.valueType === "FIXED_AMOUNT" ? `fixed ${money(r.fixedAmount ?? 0)}` : `${r.percentage ?? 0}%`;
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(r.name)}</strong>
        <p>${escapeHtml(r.scope ?? "GLOBAL")} · ${escapeHtml(vt)} · ${escapeHtml(r.status ?? "")}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="deduction" data-settings-id="${escapeAttr(r.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="deduction" data-settings-id="${escapeAttr(r.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderCategoryRow(c: { id: string; name: string; kind?: string }): string {
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(c.name)}</strong>
        <p>${escapeHtml(c.kind ?? "GENERAL")}</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="category" data-settings-id="${escapeAttr(c.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="category" data-settings-id="${escapeAttr(c.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderLabelRow(l: { id: string; label: string }): string {
  return `
    <article class="fx-mini-list__item">
      <div>
        <strong>${escapeHtml(l.label)}</strong>
        <p>Custom label</p>
      </div>
      <div class="row">
        <button type="button" class="secondary" data-settings-edit="label" data-settings-id="${escapeAttr(l.id)}">Edit</button>
        <button type="button" class="secondary" data-settings-delete="label" data-settings-id="${escapeAttr(l.id)}">Remove</button>
      </div>
    </article>
  `;
}

function renderSettingsLoadingBlock(): string {
  return `
      <section class="fx-panel fx-panel--highlight">
        <p class="fx-eyebrow">Loading</p>
        <h2>Pulling your planner data…</h2>
        <p class="muted">If this hangs, make sure the latest Supabase migrations (including <code>20260423000000_planner_data_model.sql</code>) have been applied.</p>
      </section>
    `;
}

function renderHousingPanel(snap: PlannerSnapshot): string {
  const hc = snap.housingConfig;
  return `
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
}

function renderPlannerPrefsSummary(snap: PlannerSnapshot): string {
  return `
    <section class="fx-panel">
      <div class="fx-planner-head__row">
        <div>
          <p class="fx-eyebrow">Planning</p>
          <h2>Planner preferences</h2>
          <p class="muted">Scenario mode, horizon window, safety buffer, and advanced engine knobs.</p>
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
        <article class="fx-mini-list__item"><div><strong>Safety floor cash</strong><p>${money(snap.settings.safetyFloorCash ?? 0)}</p></div></article>
        <article class="fx-mini-list__item"><div><strong>Reserve window (days)</strong><p>${snap.settings.reserveNearFutureWindowDays ?? "—"}</p></div></article>
      </div>
    </section>
  `;
}

function renderSettingsLeafInner(snap: PlannerSnapshot, leaf: SettingsLeafId): string {
  const openAccountsCta = `
    <section class="fx-panel">
      <p class="fx-eyebrow">Accounts</p>
      <h2>Manage on the Accounts tab</h2>
      <p class="muted">Balances, bank linking (Teller), and transaction tagging all live together so you can connect the bank and categorize charges in one place.</p>
      <p style="margin-top:12px"><a class="fx-inline-link" href="#/accounts">Open Accounts</a></p>
    </section>
  `;
  switch (leaf) {
    case "accounts":
      return openAccountsCta;
    case "income":
      return renderCrudListSection({
        eyebrow: "Setup",
        title: "Income",
        description: "Paychecks and other recurring income that fund the plan.",
        addKind: "income",
        items: snap.incomeSources.map(renderIncomeRow),
        emptyCopy: "Add at least one income source so the planner can forecast future paychecks.",
      });
    case "bills": {
      const hint = `
        <p class="muted" style="margin-bottom:14px">
          Already see the charge on your bank statement? Open
          <a href="#/accounts">Accounts</a>, pick the account, then use <strong>Tag</strong> on the transaction to match it to a bill (or split it) when auto-detect does not pick it up.
        </p>`;
      return `${hint}${renderCrudListSection({
        eyebrow: "Setup",
        title: "Bills",
        description: "Hard dues, subscriptions, and recurring amounts. The planner protects these before safe-to-spend.",
        addKind: "bill",
        items: snap.bills.map(renderBillRow),
        emptyCopy: "No bills yet. Add Electricity, Rent, Phone, etc. to start protecting money for them.",
      })}`;
    }
    case "expenses":
      return renderCrudListSection({
        eyebrow: "Setup",
        title: "Recurring expenses",
        description: "Essential and optional recurring spending like gas, groceries, and services.",
        addKind: "expense",
        items: snap.expenses.map(renderExpenseRow),
        emptyCopy: "Add groceries, gas, internet, etc. Mark the ones that must stay funded.",
      });
    case "debts":
      return renderCrudListSection({
        eyebrow: "Setup",
        title: "Debts",
        description: "Balances and minimums we must protect with cash or paychecks.",
        addKind: "debt",
        items: snap.debts.map(renderDebtRow),
        emptyCopy: "No debts recorded. Add credit cards, loans, or other balances you owe.",
      });
    case "housing":
      return renderHousingPanel(snap);
    case "goals":
      return renderCrudListSection({
        eyebrow: "Planning",
        title: "Goals",
        description: "Targets that fund from truly free cash without breaking protected bills.",
        addKind: "goal",
        items: snap.goals.map(renderGoalRow),
        emptyCopy: "No goals yet. Add savings targets to direct extra cash once the plan is fully funded.",
      });
    case "paycheck-rules":
      return renderCrudListSection({
        eyebrow: "Planning",
        title: "Paycheck rules",
        description: "Deductions and carve-outs that reduce usable pay before planning runs.",
        addKind: "deduction",
        items: snap.deductionRules.map(renderDeductionRow),
        emptyCopy: "No deduction rules yet. Add taxes, retirement, or other paycheck subtractions.",
      });
    case "planner-preferences":
      return renderPlannerPrefsSummary(snap);
    case "organization": {
      const cats = renderCrudListSection({
        eyebrow: "App",
        title: "Categories",
        description: "User-defined categories for grouping planner data.",
        addKind: "category",
        items: snap.categories.map(renderCategoryRow),
        emptyCopy: "No custom categories yet.",
      });
      const labs = renderCrudListSection({
        eyebrow: "App",
        title: "Custom labels",
        description: "Short labels you can attach for clearer reporting.",
        addKind: "label",
        items: snap.labels.map(renderLabelRow),
        emptyCopy: "No custom labels yet.",
      });
      return `${cats}${labs}`;
    }
    case "notifications": {
      const n = snap.notificationSettings;
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">App</p>
          <h2>Notification preferences</h2>
          <p class="muted">Saved to your account. Push delivery runs on the Android app.</p>
          <form id="form-notification-settings" class="list" style="margin-top:12px">
            <label class="field fx-checkbox">
              <input type="checkbox" name="paydayNotificationsEnabled"${n.paydayNotificationsEnabled ? " checked" : ""}/>
              <span>Payday reminders</span>
            </label>
            <label class="field fx-checkbox">
              <input type="checkbox" name="recalculateRemindersEnabled"${n.recalculateRemindersEnabled ? " checked" : ""}/>
              <span>Planning / recalculate reminders</span>
            </label>
            <label class="field">Minutes before payday to remind<input type="number" name="paydayLeadMinutes" min="0" step="15" value="${escapeAttr(n.paydayLeadMinutes ?? 60)}" /></label>
            <label class="field">Reminder hour (0–23)<input type="number" name="recalculateReminderHour" min="0" max="23" value="${escapeAttr(n.recalculateReminderHour ?? 18)}" /></label>
            <label class="field">Reminder minute (0–59)<input type="number" name="recalculateReminderMinute" min="0" max="59" value="${escapeAttr(n.recalculateReminderMinute ?? 0)}" /></label>
            <div class="row" style="margin-top:8px">
              <button type="submit" ${state.normalizedSnapshotBusy ? "disabled" : ""}>Save notification settings</button>
            </div>
          </form>
        </section>
      `;
    }
    case "backup":
      return `
        <section class="fx-panel">
          <p class="fx-eyebrow">Data</p>
          <h2>Backup &amp; reset</h2>
          <p class="muted">Export a JSON file (same shape as the Android app backup). Import replaces all planner rows for this account. Reset deletes everything — export first.</p>
          <div class="row" style="flex-wrap:wrap;gap:10px;margin-top:14px">
            <button type="button" id="btn-backup-export">Export backup</button>
            <button type="button" class="secondary" id="btn-backup-import">Import backup…</button>
            <input type="file" id="input-backup-import" accept="application/json,.json" style="display:none" />
            <button type="button" class="danger" id="btn-backup-reset">Reset all planner data…</button>
          </div>
        </section>
      `;
    case "profile":
      return ""; // rendered by renderSettingsProfileSection in workspace
    default:
      return "";
  }
}

function renderSettingsBreadcrumb(nav: SettingsNav): string {
  if (nav.tier === "home") {
    return `<nav class="fx-settings-breadcrumb" aria-label="Settings"><span class="muted">Settings</span></nav>`;
  }
  if (nav.tier === "group") {
    const meta = SETTINGS_GROUP_META[nav.group];
    return `<nav class="fx-settings-breadcrumb" aria-label="Settings">
      <a href="#/settings">Settings</a>
      <span aria-hidden="true"> / </span>
      <span>${escapeHtml(meta.title)}</span>
    </nav>`;
  }
  const gmeta = SETTINGS_GROUP_META[nav.group];
  const lmeta = SETTINGS_LEAF_META[nav.leaf];
  return `<nav class="fx-settings-breadcrumb" aria-label="Settings">
      <a href="#/settings">Settings</a>
      <span aria-hidden="true"> / </span>
      <a href="#/settings/${nav.group}">${escapeHtml(gmeta.title)}</a>
      <span aria-hidden="true"> / </span>
      <span>${escapeHtml(lmeta.title)}</span>
    </nav>`;
}

function renderSettingsProfileSection(profile: Profile | null, accent: string, mode: "dark" | "light", busy: boolean): string {
  return `
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">App</p>
          <h2>Account &amp; profile</h2>
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
            <div class="field">
              <span style="font-weight:600">Accent color</span>
              <div class="fx-theme-grid" id="theme-presets" role="group" aria-label="Theme presets">
                ${themePresetButtons(accent)}
              </div>
              <div class="fx-color-row" style="margin-top:8px">
                <label class="field">Custom accent<input id="field-color-picker" type="color" value="${escapeHtml(accent)}" aria-label="Custom accent color" /></label>
              </div>
            </div>
            <div class="row" style="margin-top:4px">
              <button type="submit" ${busy ? "disabled" : ""}>Save profile</button>
            </div>
            ${state.info ? `<p class="success">${escapeHtml(state.info)}</p>` : ""}
          </form>
        </section>
  `;
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

function renderChoiceSegment(
  fieldName: string,
  legend: string,
  current: string,
  options: Array<{ value: string; label: string }>,
): string {
  const cur = options.some((o) => o.value === current) ? current : options[0]?.value ?? current;
  return `
    <div class="field field--choice">
      <span class="field__legend">${escapeHtml(legend)}</span>
      <input type="hidden" name="${escapeAttr(fieldName)}" value="${escapeAttr(cur)}" />
      <div class="fx-seg fx-seg--wrap" role="radiogroup" aria-label="${escapeAttr(legend)}">
        ${options
          .map((o) => {
            const active = o.value === cur;
            return `<button type="button" class="fx-seg__btn${active ? " is-active" : ""}" data-choice-seg data-choice-field="${escapeAttr(fieldName)}" data-choice-value="${escapeAttr(o.value)}" role="radio" aria-checked="${active ? "true" : "false"}">${escapeHtml(o.label)}</button>`;
          })
          .join("")}
      </div>
    </div>
  `;
}

function renderRecurringRuleFields(prefix: string, rule?: { type?: string; anchorDate?: string; dayOfMonth?: number; intervalDays?: number }): string {
  const r = rule ?? {};
  const opts: Array<{ value: string; label: string }> = [
    { value: "ONE_TIME", label: "One time only" },
    { value: "DAILY", label: "Every day" },
    { value: "WEEKLY", label: "Every week" },
    { value: "BIWEEKLY", label: "Every 2 weeks" },
    { value: "SEMI_MONTHLY", label: "Twice a month" },
    { value: "MONTHLY", label: "Every month" },
    { value: "QUARTERLY", label: "Every 3 months" },
    { value: "YEARLY", label: "Every year" },
    { value: "EVERY_X_DAYS", label: "Every X days" },
  ];
  const ruleType = r.type && opts.some((o) => o.value === r.type) ? r.type : "MONTHLY";
  return `
    ${renderChoiceSegment(`${prefix}_type`, "How often", ruleType, opts)}
    <label class="field">Next date<input type="date" name="${prefix}_anchor" value="${escapeAttr(r.anchorDate ?? "")}" /></label>
    <label class="field">Day of the month (if monthly)<input type="number" name="${prefix}_dayOfMonth" min="1" max="31" placeholder="e.g. 15" value="${escapeAttr(r.dayOfMonth ?? "")}" /></label>
    <label class="field">Every how many days (if "Every X days")<input type="number" name="${prefix}_intervalDays" min="1" placeholder="e.g. 10" value="${escapeAttr(r.intervalDays ?? "")}" /></label>
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
        ${renderChoiceSegment("paymentPolicy", "Policy", existing?.paymentPolicy ?? "HARD_DUE", [
          { value: "HARD_DUE", label: "On time" },
          { value: "FLEXIBLE_DUE", label: "Flexible" },
        ])}
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
          <select class="fx-select" name="bankAccountId">
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
        ${renderChoiceSegment(
          "type",
          "Debt type",
          existing?.type ?? "INSTALLMENT",
          [
            { value: "INSTALLMENT", label: "Installment" },
            { value: "REVOLVING", label: "Revolving" },
            { value: "CREDIT_CARD", label: "Card" },
            { value: "LOAN", label: "Loan" },
            { value: "BORROW", label: "Borrow" },
          ],
        )}
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
        ${renderChoiceSegment(
          "arrangement",
          "Arrangement",
          existing?.arrangement ?? "RENT_MONTH_TO_MONTH",
          [
            { value: "RENT_MONTH_TO_MONTH", label: "Rent (monthly)" },
            { value: "RENT_LEASE", label: "Rent (lease)" },
            { value: "MORTGAGE", label: "Mortgage" },
            { value: "LAND_CONTRACT", label: "Land contract" },
            { value: "OTHER", label: "Other" },
          ],
        )}
      `;
      break;
    }
    case "deduction": {
      const existing = snap && editor.id ? find(snap.deductionRules, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit deduction — ${existing.name}` : "Add paycheck deduction";
      body = `
        <label class="field">Name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        ${renderChoiceSegment("scope", "Applies to", existing?.scope ?? "GLOBAL", [
          { value: "GLOBAL", label: "All paychecks" },
          { value: "INCOME_SOURCE", label: "One income" },
        ])}
        <label class="field">Income source id (if scoped)<input name="incomeSourceId" value="${escapeAttr(existing?.incomeSourceId ?? "")}" placeholder="UUID from Income list" /></label>
        ${renderChoiceSegment("valueType", "Value type", existing?.valueType ?? "PERCENTAGE", [
          { value: "PERCENTAGE", label: "% of gross" },
          { value: "FIXED_AMOUNT", label: "Fixed $" },
        ])}
        <label class="field">Percentage (0–1 if decimal, or use whole e.g. 0.15 for 15%)<input name="percentage" type="number" step="0.0001" value="${escapeAttr(existing?.percentage ?? 0)}" /></label>
        <label class="field">Fixed amount<input name="fixedAmount" type="number" step="0.01" value="${escapeAttr(existing?.fixedAmount ?? 0)}" /></label>
        ${renderChoiceSegment("status", "Status", existing?.status ?? "MANDATORY", [
          { value: "MANDATORY", label: "Mandatory" },
          { value: "OPTIONAL", label: "Optional" },
        ])}
        <label class="field"><input name="isEnabledByDefault" type="checkbox"${existing?.isEnabledByDefault !== false ? " checked" : ""}/> Enabled by default</label>
        <label class="field">Notes<input name="notes" value="${escapeAttr(existing?.notes ?? "")}" /></label>
      `;
      break;
    }
    case "category": {
      const existing = snap && editor.id ? find(snap.categories, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit category — ${existing.name}` : "Add category";
      body = `
        <label class="field">Name<input name="name" required value="${escapeAttr(existing?.name ?? "")}" /></label>
        <label class="field">Kind<input name="kind" value="${escapeAttr(existing?.kind ?? "GENERAL")}" placeholder="GENERAL" /></label>
        <label class="field">Notes<input name="notes" value="${escapeAttr(existing?.notes ?? "")}" /></label>
      `;
      break;
    }
    case "label": {
      const existing = snap && editor.id ? find(snap.labels, editor.id) : undefined;
      deletable = Boolean(existing);
      title = existing ? `Edit label — ${existing.label}` : "Add custom label";
      body = `
        <label class="field">Label text<input name="label" required value="${escapeAttr(existing?.label ?? "")}" /></label>
        <label class="field">Notes<input name="notes" value="${escapeAttr(existing?.notes ?? "")}" /></label>
      `;
      break;
    }
    case "planner-settings": {
      const s = snap?.settings ?? { targetBuffer: 0, horizonDays: 120, selectedScenarioMode: "FIXED", planningStyle: "BALANCED" };
      title = "Planner preferences";
      body = `
        <label class="field">Safety buffer (extra cash target)<input name="targetBuffer" type="number" step="0.01" value="${escapeAttr(s.targetBuffer ?? 0)}" /></label>
        <label class="field">Safety floor — minimum cash to keep<input name="safetyFloorCash" type="number" step="0.01" value="${escapeAttr(s.safetyFloorCash ?? 0)}" /></label>
        <label class="field">Horizon days<input name="horizonDays" type="number" min="30" max="365" value="${escapeAttr(s.horizonDays ?? 120)}" /></label>
        <label class="field">Reserve near-future window (days)<input name="reserveNearFutureWindowDays" type="number" min="1" max="60" value="${escapeAttr(s.reserveNearFutureWindowDays ?? 21)}" /></label>
        ${renderChoiceSegment("selectedScenarioMode", "Scenario mode", s.selectedScenarioMode ?? "FIXED", [
          { value: "FIXED", label: "Typical pay" },
          { value: "LOWEST_INCOME", label: "Low pay" },
          { value: "MOST_EFFICIENT", label: "Balanced" },
          { value: "HIGHEST_INCOME", label: "High pay" },
        ])}
        ${renderChoiceSegment("planningStyle", "Planning style", s.planningStyle ?? "BALANCED", [
          { value: "BALANCED", label: "Balanced" },
          { value: "SURVIVAL", label: "Survival" },
          { value: "AGGRESSIVE_SAVE", label: "Save harder" },
        ])}
        ${renderChoiceSegment("optimizationGoal", "Optimization goal", s.optimizationGoal ?? "BALANCED", [
          { value: "STAY_CURRENT", label: "Stay current" },
          { value: "CATCH_UP_FAST", label: "Catch up" },
          { value: "PAY_DEBT_FAST", label: "Pay debt" },
          { value: "MINIMIZE_BORROWING", label: "Less borrowing" },
          { value: "BALANCED", label: "Balanced" },
        ])}
        ${renderChoiceSegment("payoffMode", "Debt payoff order", s.payoffMode ?? "SNOWBALL", [
          { value: "SNOWBALL", label: "Smallest first" },
          { value: "AVALANCHE", label: "Highest APR" },
          { value: "CUSTOM", label: "Custom order" },
        ])}
        ${renderChoiceSegment("housingPaymentMode", "Housing payment", s.housingPaymentMode ?? "MINIMUM_CURRENT", [
          { value: "MINIMUM_CURRENT", label: "Minimum due" },
          { value: "FULL_CURRENT", label: "Full amount" },
        ])}
        ${renderChoiceSegment(
          "housingPayoffTargetMode",
          "Housing in debt payoff",
          s.housingPayoffTargetMode ?? "REGULAR_DEBTS_ONLY",
          [
            { value: "REGULAR_DEBTS_ONLY", label: "Debts only" },
            { value: "INCLUDE_HOUSING_ARREARS", label: "Include arrears" },
          ],
        )}
        <label class="field">Currency (ISO)<input name="currency" value="${escapeAttr(s.currency ?? "USD")}" /></label>
        <label class="field">IANA timezone<input name="timezone" value="${escapeAttr(s.timezone ?? "UTC")}" placeholder="America/Chicago" /></label>
        <label class="field fx-checkbox"><input name="allowNegativeCash" type="checkbox"${s.allowNegativeCash ? " checked" : ""}/> Allow plan to go negative (advanced)</label>
        <label class="field fx-checkbox"><input name="sameDayIncomeBeforeSameDayBills" type="checkbox"${(s.sameDayIncomeBeforeSameDayBills ?? true) ? " checked" : ""}/> Same day: income before bills</label>
        <label class="field">Engine priority order (comma-separated)<input name="priorityOrder" value="${escapeAttr(s.priorityOrder ?? "")}" placeholder="ESSENTIALS,OVERDUE_ITEMS,..." /></label>
      `;
      break;
    }
  }

  return `
    <div class="fx-auth-modal fx-auth-modal--open" role="dialog" aria-modal="true" aria-labelledby="settings-editor-title">
      <button type="button" class="fx-auth-modal__backdrop" data-settings-editor-cancel aria-label="Close"></button>
      <div class="fx-auth-modal__panel fx-form-modal-panel">
        <div class="fx-auth-modal__chrome">
          <h2 id="settings-editor-title" class="fx-auth-modal__title">${escapeHtml(title)}</h2>
          <button type="button" class="fx-auth-modal__close" data-settings-editor-cancel aria-label="Close">×</button>
        </div>
        <div class="fx-form-modal-body">
          <form id="form-settings-editor" class="fx-auth-modal__form list fx-settings-editor-form" data-editor-kind="${editor.kind}" data-editor-id="${escapeAttr((editor as { id?: string }).id ?? "")}">
            ${body}
            ${renderEditorFooterButtons(busy, deletable)}
            ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
          </form>
        </div>
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
  settingsNav: SettingsNav,
) {
  void plannerState;
  const snap = state.normalizedSnapshot;

  if (settingsNav.tier === "home") {
    const cards = SETTINGS_GROUP_ORDER.map((gid) => {
      const m = SETTINGS_GROUP_META[gid];
      return `
        <a class="fx-settings-group-card fx-panel" href="#/settings/${gid}">
          <p class="fx-eyebrow">${escapeHtml(m.title)}</p>
          <h2>${escapeHtml(m.subtitle)}</h2>
          <p class="muted">${escapeHtml(m.description)}</p>
        </a>`;
    }).join("");
    return `
    <div class="fx-settings">
      ${renderSettingsBreadcrumb(settingsNav)}
      <div class="fx-settings__body fx-settings__body--home">
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">Settings</p>
          <h1>Planner setup</h1>
          <p class="muted">Same sections as the mobile app. Pick a group to add or edit accounts, bills, planning rules, and more.</p>
        </section>
        <div class="fx-settings-group-grid">${cards}</div>
      </div>
    </div>`;
  }

  if (settingsNav.tier === "group") {
    const g = settingsNav.group;
    const meta = SETTINGS_GROUP_META[g];
    const leaves = SETTINGS_LEAVES[g].map((leaf) => {
      const lm = SETTINGS_LEAF_META[leaf];
      return `
        <a class="fx-mini-list__item fx-settings-leaf-row" href="#/settings/${g}/${leaf}">
          <div>
            <strong>${escapeHtml(lm.title)}</strong>
            <p class="muted">${escapeHtml(lm.subtitle)} — ${escapeHtml(lm.description)}</p>
          </div>
        </a>`;
    }).join("");
    return `
    <div class="fx-settings">
      ${renderSettingsBreadcrumb(settingsNav)}
      <div class="fx-settings__body">
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">${escapeHtml(meta.title)}</p>
          <h1>${escapeHtml(meta.subtitle)}</h1>
          <p class="muted">${escapeHtml(meta.description)}</p>
        </section>
        <div class="fx-mini-list">${leaves}</div>
      </div>
    </div>`;
  }

  const leaf = settingsNav.leaf;
  const lmeta = SETTINGS_LEAF_META[leaf];
  const bodyInner = !snap
    ? renderSettingsLoadingBlock()
    : leaf === "profile"
      ? renderSettingsProfileSection(profile, accent, mode, busy)
      : renderSettingsLeafInner(snap, leaf);

  return `
    <div class="fx-settings">
      ${renderSettingsBreadcrumb(settingsNav)}
      <div class="fx-settings__body">
        <section class="fx-panel fx-panel--highlight">
          <p class="fx-eyebrow">${escapeHtml(SETTINGS_GROUP_META[settingsNav.group].title)}</p>
          <h1>${escapeHtml(lmeta.title)}</h1>
          <p class="muted">${escapeHtml(lmeta.description)}</p>
        </section>
        ${bodyInner}
      </div>
    </div>`;
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
    const assignment = state.txAssignments[txId];
    const tagClass = !assignment || assignment.kind === "UNCATEGORIZED"
      ? "tx-tag tx-tag--untagged"
      : assignment.kind === "SPLIT"
        ? "tx-tag tx-tag--split"
        : "tx-tag";
    const tagLabel = assignment?.label ?? "Not tagged";
    const btnLabel = assignment && assignment.kind !== "UNCATEGORIZED" ? "Edit" : "Tag";
    return `
      <div class="tx">
        <div class="tx-main">
          <div class="tx-title">${escapeHtml(desc)}</div>
          <div class="tx-date">${escapeHtml(date)}${merchant ? ` · ${escapeHtml(merchant)}` : ""}</div>
          <span class="${tagClass}">${escapeHtml(tagLabel)}</span>
        </div>
        <div class="${cls}">${money(n)}</div>
        <button type="button" class="secondary tx-adjust" data-categorize-tx="${escapeAttr(txId)}" data-categorize-desc="${escapeAttr(desc)}" data-categorize-merchant="${escapeAttr(merchant)}" data-categorize-amount="${escapeAttr(n)}" data-categorize-date="${escapeAttr(date)}">${btnLabel}</button>
      </div>
    `;
  });

  const busy = state.busy
    ? `<span class="fx-busy-hint"><span class="fx-spinner" aria-hidden="true"></span> Syncing…</span>`
    : "";

  const routeForNav = APP_PRIMARY_ROUTES.has(state.route) ? state.route : "home";
  const appNavBlock = renderHeaderNavigation(
    "app",
    routeForNav,
    `<div class="fx-nav-drawer__extras">
        <p class="fx-nav-drawer__user muted">${escapeHtml(profile?.display_name ?? state.session?.user.email ?? "Member")}</p>
        <button type="button" class="danger js-signout" ${state.busy ? "disabled" : ""}>Sign out</button>
      </div>`,
  );

  const routeBody =
    state.route === "planner"
      ? renderPlannerWorkspace(plannerState, plan)
      : state.route === "bills"
        ? renderBillsWorkspace(plan)
        : state.route === "accounts"
          ? renderAccountsWorkspace(rows, txRows, tellerConfigured(), state.busy, state.error)
          : state.route === "settings"
            ? renderSettingsWorkspace(profile, accent, mode, state.busy, plannerState, parseSettingsNav(window.location.hash))
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
          ${appNavBlock}
          <div class="fx-header__actions">
            <span class="fx-pill"><strong>${escapeHtml(profile?.display_name ?? state.session?.user.email ?? "Member")}</strong></span>
            ${busy}
            <button type="button" class="danger js-signout" id="btn-signout" ${state.busy ? "disabled" : ""}>Sign out</button>
          </div>
        </header>

        ${
          !isSupabaseConfigured
            ? `<div class="banner">A.Pay is in preview mode. Sign-in and bank linking are unavailable until the server is connected.</div>`
            : ""
        }
        ${state.error ? `<div class="banner banner--alert" role="alert">${escapeHtml(state.error)}</div>` : ""}
        ${routeBody}
        <footer class="fx-app-footer">
          <a href="#/privacy">Privacy</a>
          <a href="#/terms">Terms</a>
          <span>© ${new Date().getFullYear()} A.Pay</span>
        </footer>
      </div>
      ${renderSettingsEditorOverlay(state.normalizedSnapshot)}
      ${renderCategorizeOverlay(state.normalizedSnapshot)}
    </div>
  `;
}

function categoryTargetOptions(snap: PlannerSnapshot | null, isCredit: boolean, selected: string): string {
  const opt = (value: string, label: string) =>
    `<option value="${escapeAttr(value)}"${value === selected ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const optgroup = (label: string, items: string[]) =>
    items.length ? `<optgroup label="${escapeAttr(label)}">${items.join("")}</optgroup>` : "";

  const cash = isCredit ? [opt("CASH_IN:", "Cash in (untracked)")] : [opt("CASH_OUT:", "Cash out (untracked)")];

  if (isCredit) {
    const income = (snap?.incomeSources ?? []).filter((s) => s.isActive !== false).map((s) => {
      const label = s.name?.trim() || s.payerLabel?.trim() || "Income source";
      return opt(`INCOME:${s.id}`, label);
    });
    return [
      opt("UNCATEGORIZED:", "— pick a category —"),
      optgroup("Income (match to a paycheck source)", income),
      optgroup("Other", cash),
    ].join("");
  }

  const bills = (snap?.bills ?? []).map((b) => opt(`BILL:${b.id}`, b.name));
  const debts = (snap?.debts ?? []).map((d) => opt(`DEBT:${d.id}`, d.name));
  const expenses = (snap?.expenses ?? []).map((e) => opt(`EXPENSE:${e.id}`, e.name));
  const housing = (snap?.housingBuckets ?? []).map((h) => opt(`HOUSING:${h.id}`, h.label));
  const goals = (snap?.goals ?? []).map((g) => opt(`GOAL:${g.id}`, g.name));

  return [
    opt("UNCATEGORIZED:", "— pick a category —"),
    optgroup("Bills", bills),
    optgroup("Debts", debts),
    optgroup("Expenses", expenses),
    optgroup("Housing", housing),
    optgroup("Goals", goals),
    optgroup("Other", cash),
  ].join("");
}

function renderSplitRow(
  row: CategorizeSplitRow,
  index: number,
  snap: PlannerSnapshot | null,
  isCredit: boolean,
  canRemove: boolean,
): string {
  const categoryOptions = categoryTargetOptions(snap, isCredit, row.target);
  return `
    <div class="fx-splits__row" data-split-id="${escapeAttr(row.id)}">
      <label class="field">
        <span style="font-weight:600">${index === 0 ? "Category" : `Category ${index + 1}`}</span>
        <select class="fx-select" data-split-field="target">${categoryOptions}</select>
      </label>
      <label class="field">
        <span style="font-weight:600">Amount</span>
        <input type="number" step="0.01" min="0" data-split-field="amount" value="${escapeAttr(row.amount.toFixed(2))}" />
      </label>
      <button
        type="button"
        class="danger fx-splits__remove"
        data-split-action="remove"
        ${canRemove ? "" : "disabled"}
        title="${canRemove ? "Remove this split" : "At least one row is required"}"
        aria-label="Remove split"
      >×</button>
    </div>
  `;
}

function renderCategorizeOverlay(snap: PlannerSnapshot | null): string {
  const c = state.categorizeEditor;
  if (!c) return "";
  const busy = state.normalizedSnapshotBusy;
  const transactionAmount = Math.abs(c.amount);
  const isCredit = c.amount > 0;
  const splitsTotal = c.splits.reduce((sum, s) => sum + (Number.isFinite(s.amount) ? Math.abs(s.amount) : 0), 0);
  const remaining = Math.round((transactionAmount - splitsTotal) * 100) / 100;
  const totalsClass = Math.abs(remaining) < 0.01
    ? "fx-splits__totals--good"
    : remaining < 0
      ? "fx-splits__totals--bad"
      : "";

  const splitRows = c.splits.map((row, i) =>
    renderSplitRow(row, i, snap, isCredit, c.splits.length > 1),
  ).join("");

  const hasSingleCategory = c.splits.length === 1 && c.splits[0].target !== "UNCATEGORIZED:";
  const displayLabel = c.merchant || c.description;

  return `
    <div class="fx-auth-modal fx-auth-modal--open" role="dialog" aria-modal="true" aria-labelledby="categorize-title">
      <button type="button" class="fx-auth-modal__backdrop" data-categorize-cancel aria-label="Close"></button>
      <div class="fx-auth-modal__panel fx-form-modal-panel fx-form-modal-panel--wide">
        <div class="fx-auth-modal__chrome">
          <h2 id="categorize-title" class="fx-auth-modal__title">Tag this transaction</h2>
          <button type="button" class="fx-auth-modal__close" data-categorize-cancel aria-label="Close">×</button>
        </div>
        <div class="fx-form-modal-body">
        <form id="form-categorize" class="fx-auth-modal__form list">
          <div class="fx-mini-list" style="margin:0 0 6px">
            <article class="fx-mini-list__item">
              <div>
                <strong>${escapeHtml(c.description)}</strong>
                <p>${escapeHtml(c.postedDate ?? "")}${c.merchant ? ` · ${escapeHtml(c.merchant)}` : ""}</p>
              </div>
              <span>${money(c.amount)}</span>
            </article>
          </div>

          <p class="muted" style="margin:0">Pick a category for this transaction. Split it across more than one by pressing <strong>+ Add another category</strong>.</p>

          ${c.loadingAssignments
            ? `<p class="muted">Loading existing tags…</p>`
            : `<div class="fx-splits">${splitRows}</div>`}

          <button type="button" class="secondary fx-splits__add" data-split-action="add">+ Add another category</button>

          <div class="fx-splits__totals ${totalsClass}">
            <span>Transaction total: <strong>${money(transactionAmount)}</strong></span>
            <span>Tagged: <strong>${money(splitsTotal)}</strong></span>
            <span>Remaining: <strong>${money(remaining)}</strong></span>
          </div>

          <label class="field">Note (optional)<input data-categorize-note value="${escapeAttr(c.note)}" placeholder="e.g. Split between rent and utilities" /></label>

          <label class="field fx-checkbox" data-categorize-learn-row ${hasSingleCategory ? "" : `style="display:none"`}>
            <input type="checkbox" data-categorize-learn checked />
            <span>Always tag "${escapeHtml(displayLabel)}" this way in the future</span>
          </label>

          <div class="row" style="justify-content:flex-end;margin-top:12px">
            <button type="button" class="secondary" data-categorize-cancel>Cancel</button>
            <button type="submit" ${busy ? "disabled" : ""}>${busy ? "Saving…" : "Save"}</button>
          </div>
          ${state.error ? `<p class="error">${escapeHtml(state.error)}</p>` : ""}
        </form>
        </div>
      </div>
    </div>
  `;
}

function render() {
  document.body.classList.remove("fx-mobile-nav-open");
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

function setMobileNavOpen(open: boolean) {
  const drawer = document.getElementById("fx-nav-drawer");
  const toggle = document.getElementById("btn-mobile-nav");
  if (!drawer || !toggle) return;
  drawer.classList.toggle("is-open", open);
  toggle.setAttribute("aria-expanded", open ? "true" : "false");
  toggle.setAttribute("aria-label", open ? "Close menu" : "Open menu");
  document.body.classList.toggle("fx-mobile-nav-open", open);
}

function wireMobileNav() {
  const drawer = document.getElementById("fx-nav-drawer");
  const toggle = document.getElementById("btn-mobile-nav");
  if (!drawer || !toggle) return;
  const close = () => setMobileNavOpen(false);
  const open = () => setMobileNavOpen(true);
  toggle.addEventListener("click", () => {
    drawer.classList.contains("is-open") ? close() : open();
  });
  document.getElementById("btn-mobile-nav-backdrop")?.addEventListener("click", close);
  document.getElementById("btn-mobile-nav-close")?.addEventListener("click", close);
  drawer.querySelectorAll<HTMLAnchorElement>(".fx-app-nav__link").forEach((a) => {
    a.addEventListener("click", close);
  });
  document.getElementById("btn-open-auth-drawer")?.addEventListener("click", () => {
    close();
    openAuthModal();
  });
}

function wireAuth() {
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
    state.info = "Thanks — we'll get back to you.";
    state.error = null;
    render();
    setTimeout(() => {
      state.info = null;
      render();
    }, 2200);
  });

  document.getElementById("auth-modal-backdrop")?.addEventListener("click", () => closeAuthModal());
  document.getElementById("auth-modal-close")?.addEventListener("click", () => closeAuthModal());

  wireMobileNav();

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

  const signOutHandler = async () => {
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
  };
  document.querySelectorAll<HTMLButtonElement>(".js-signout").forEach((btn) => {
    btn.addEventListener("click", signOutHandler);
  });

  wireMobileNav();

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

  document.querySelector<HTMLFormElement>("#form-notification-settings")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const userId = state.session?.user?.id;
    if (!userId) return;
    const fd = new FormData(e.target as HTMLFormElement);
    try {
      await saveNotificationSettings(userId, {
        paydayNotificationsEnabled: fd.get("paydayNotificationsEnabled") === "on",
        recalculateRemindersEnabled: fd.get("recalculateRemindersEnabled") === "on",
        paydayLeadMinutes: Math.trunc(Number(fd.get("paydayLeadMinutes")) || 0),
        recalculateReminderHour: Math.trunc(Number(fd.get("recalculateReminderHour")) || 0),
        recalculateReminderMinute: Math.trunc(Number(fd.get("recalculateReminderMinute")) || 0),
      });
      state.info = "Notification preferences saved.";
      await loadNormalizedAndRecompute({ persist: true });
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    render();
  });

  document.querySelector<HTMLButtonElement>("#btn-backup-export")?.addEventListener("click", async () => {
    const userId = state.session?.user?.id;
    if (!userId) return;
    try {
      state.busy = true;
      render();
      const pkg = await buildPlannerBackupPackage(userId, "web-bank-portal");
      const blob = new Blob([JSON.stringify(pkg, null, 2)], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = `apay-backup-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      URL.revokeObjectURL(a.href);
      state.info = "Backup downloaded.";
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.busy = false;
    render();
  });

  const backupImportInput = document.querySelector<HTMLInputElement>("#input-backup-import");
  document.querySelector<HTMLButtonElement>("#btn-backup-import")?.addEventListener("click", () => {
    backupImportInput?.click();
  });
  backupImportInput?.addEventListener("change", async () => {
    const file = backupImportInput.files?.[0];
    const userId = state.session?.user?.id;
    if (!file || !userId) return;
    if (!confirm("Import replaces ALL planner data for this account with the backup file. Continue?")) {
      backupImportInput.value = "";
      return;
    }
    try {
      state.busy = true;
      render();
      const text = await file.text();
      const parsed = JSON.parse(text) as PlannerBackupPackage;
      if (typeof parsed.schemaVersion !== "number" || !parsed.snapshot) {
        throw new Error("Invalid backup file.");
      }
      await importPlannerBackupPackage(userId, parsed);
      await loadNormalizedAndRecompute({ persist: true });
      await refreshBankData();
      state.info = "Backup imported. Your planner was rebuilt from the file.";
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    backupImportInput.value = "";
    state.busy = false;
    render();
  });

  document.querySelector<HTMLButtonElement>("#btn-backup-reset")?.addEventListener("click", async () => {
    const userId = state.session?.user?.id;
    if (!userId) return;
    if (!confirm("Delete ALL planner data for this account? This cannot be undone. Export a backup first if you need a copy.")) return;
    try {
      state.busy = true;
      render();
      await deleteAllNormalizedPlannerData(userId);
      await loadNormalizedAndRecompute({ persist: true });
      state.info = "Planner data reset.";
    } catch (err) {
      state.error = err instanceof Error ? err.message : String(err);
    }
    state.busy = false;
    render();
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

/** Convert a DB assignment row into "KIND:id" strings used by the split editor. */
function splitTargetFromAssignment(row: {
  categoryKind: string; billId: string | null; debtId: string | null;
  expenseId: string | null; goalId: string | null; housingBucketId: string | null;
  incomeSourceId: string | null;
}): string {
  const kind = row.categoryKind.toUpperCase();
  switch (kind) {
    case "BILL": return `BILL:${row.billId ?? ""}`;
    case "DEBT": return `DEBT:${row.debtId ?? ""}`;
    case "EXPENSE": return `EXPENSE:${row.expenseId ?? ""}`;
    case "GOAL": return `GOAL:${row.goalId ?? ""}`;
    case "HOUSING": return `HOUSING:${row.housingBucketId ?? ""}`;
    case "INCOME": return `INCOME:${row.incomeSourceId ?? ""}`;
    case "CASH_IN": return "CASH_IN:";
    case "CASH_OUT": return "CASH_OUT:";
    default: return "UNCATEGORIZED:";
  }
}

function parseSplitTarget(value: string): PlannerActualTarget {
  const [kindRaw, idRaw] = value.split(":");
  const kind = (kindRaw || "UNCATEGORIZED").toUpperCase();
  const id = (idRaw ?? "").trim();
  switch (kind) {
    case "BILL": return id ? { kind: "BILL", id } : { kind: "UNCATEGORIZED" };
    case "DEBT": return id ? { kind: "DEBT", id } : { kind: "UNCATEGORIZED" };
    case "EXPENSE": return id ? { kind: "EXPENSE", id } : { kind: "UNCATEGORIZED" };
    case "GOAL": return id ? { kind: "GOAL", id } : { kind: "UNCATEGORIZED" };
    case "HOUSING": return id ? { kind: "HOUSING", id } : { kind: "UNCATEGORIZED" };
    case "INCOME": return id ? { kind: "INCOME", id } : { kind: "UNCATEGORIZED" };
    case "CASH_IN": return { kind: "CASH_IN" };
    case "CASH_OUT": return { kind: "CASH_OUT" };
    default: return { kind: "UNCATEGORIZED" };
  }
}

function newSplitRowLocalId(): string {
  return `split_${Math.random().toString(36).slice(2, 10)}`;
}

/** Read the live split values from the form DOM back into state.categorizeEditor.splits. */
function syncSplitsFromForm(): void {
  const c = state.categorizeEditor;
  if (!c) return;
  const form = document.querySelector<HTMLFormElement>("#form-categorize");
  if (!form) return;
  const rows = form.querySelectorAll<HTMLDivElement>("[data-split-id]");
  const next: CategorizeSplitRow[] = [];
  rows.forEach((el) => {
    const id = el.getAttribute("data-split-id") ?? newSplitRowLocalId();
    const targetEl = el.querySelector<HTMLSelectElement>('[data-split-field="target"]');
    const amountEl = el.querySelector<HTMLInputElement>('[data-split-field="amount"]');
    const target = targetEl?.value ?? "UNCATEGORIZED:";
    const amount = Number(amountEl?.value ?? 0);
    next.push({ id, target, amount: Number.isFinite(amount) ? amount : 0, note: "" });
  });
  if (next.length > 0) c.splits = next;
  const noteEl = form.querySelector<HTMLInputElement>("[data-categorize-note]");
  if (noteEl) c.note = noteEl.value;
}

async function openCategorizeEditor(btn: HTMLButtonElement): Promise<void> {
  const txId = btn.getAttribute("data-categorize-tx") ?? "";
  if (!txId) return;
  const description = btn.getAttribute("data-categorize-desc") ?? "";
  const merchant = btn.getAttribute("data-categorize-merchant") ?? "";
  const amountAttr = Number(btn.getAttribute("data-categorize-amount") ?? 0);
  const amount = Number.isFinite(amountAttr) ? amountAttr : 0;
  const postedDate = btn.getAttribute("data-categorize-date") ?? "";
  const transactionAmount = Math.abs(amount);

  // Show the dialog immediately with a placeholder row so the user sees feedback.
  state.categorizeEditor = {
    txId,
    description,
    merchant: merchant || null,
    amount,
    postedDate: postedDate || null,
    splits: [{ id: newSplitRowLocalId(), target: "UNCATEGORIZED:", amount: transactionAmount, note: "" }],
    note: "",
    loadingAssignments: true,
  };
  state.error = null;
  render();

  // Then try to load any existing categorization + splits the user saved before.
  const userId = state.session?.user?.id;
  if (!userId) {
    if (state.categorizeEditor) state.categorizeEditor.loadingAssignments = false;
    render();
    return;
  }
  try {
    const assignments = await loadTransactionAssignments(userId, txId);
    if (!state.categorizeEditor || state.categorizeEditor.txId !== txId) return;

    let note = "";
    let splits: CategorizeSplitRow[] = [];
    if (assignments.splits.length > 0) {
      splits = assignments.splits.map((s) => ({
        id: newSplitRowLocalId(),
        target: splitTargetFromAssignment({
          categoryKind: s.categoryKind,
          billId: s.billId,
          debtId: s.debtId,
          expenseId: s.expenseId,
          goalId: s.goalId,
          housingBucketId: s.housingBucketId,
          incomeSourceId: s.incomeSourceId,
        }),
        amount: Math.abs(s.amount),
        note: s.note,
      }));
      note = assignments.categorization?.note ?? "";
    } else if (assignments.categorization && assignments.categorization.categoryKind !== "UNCATEGORIZED") {
      splits = [{
        id: newSplitRowLocalId(),
        target: splitTargetFromAssignment({
          categoryKind: assignments.categorization.categoryKind,
          billId: assignments.categorization.billId,
          debtId: assignments.categorization.debtId,
          expenseId: assignments.categorization.expenseId,
          goalId: assignments.categorization.goalId,
          housingBucketId: assignments.categorization.housingBucketId,
          incomeSourceId: assignments.categorization.incomeSourceId,
        }),
        amount: transactionAmount,
        note: "",
      }];
      note = assignments.categorization.note;
    }

    if (splits.length > 0) {
      state.categorizeEditor.splits = splits;
      state.categorizeEditor.note = note;
    }
    state.categorizeEditor.loadingAssignments = false;
    render();
  } catch (e) {
    console.warn("failed to load existing transaction tags", e);
    if (state.categorizeEditor) state.categorizeEditor.loadingAssignments = false;
    render();
  }
}

function wireCategorizeButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-categorize-tx]").forEach((btn) => {
    btn.addEventListener("click", () => {
      void openCategorizeEditor(btn);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-categorize-cancel]").forEach((el) => {
    el.addEventListener("click", () => {
      state.categorizeEditor = null;
      state.error = null;
      render();
    });
  });

  // Add split
  document.querySelectorAll<HTMLButtonElement>('[data-split-action="add"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.categorizeEditor;
      if (!c) return;
      syncSplitsFromForm();
      const used = c.splits.reduce((s, r) => s + (Number.isFinite(r.amount) ? Math.abs(r.amount) : 0), 0);
      const remaining = Math.max(0, Math.round((Math.abs(c.amount) - used) * 100) / 100);
      c.splits = [
        ...c.splits,
        { id: newSplitRowLocalId(), target: "UNCATEGORIZED:", amount: remaining, note: "" },
      ];
      render();
    });
  });

  // Remove split
  document.querySelectorAll<HTMLButtonElement>('[data-split-action="remove"]').forEach((btn) => {
    btn.addEventListener("click", () => {
      const c = state.categorizeEditor;
      if (!c) return;
      const row = btn.closest<HTMLElement>("[data-split-id]");
      const id = row?.getAttribute("data-split-id");
      if (!id) return;
      syncSplitsFromForm();
      if (c.splits.length <= 1) return;
      c.splits = c.splits.filter((s) => s.id !== id);
      render();
    });
  });

  // Recalculate totals when any split field changes (without full re-render so focus is kept).
  document.querySelectorAll<HTMLElement>("#form-categorize [data-split-field], #form-categorize [data-categorize-note]").forEach((el) => {
    el.addEventListener("input", () => {
      syncSplitsFromForm();
      // Only re-render the totals area for performance/focus stability.
      const c = state.categorizeEditor;
      if (!c) return;
      const total = Math.abs(c.amount);
      const tagged = c.splits.reduce((s, r) => s + (Number.isFinite(r.amount) ? Math.abs(r.amount) : 0), 0);
      const remaining = Math.round((total - tagged) * 100) / 100;
      const totals = document.querySelector<HTMLDivElement>(".fx-splits__totals");
      if (totals) {
        totals.classList.remove("fx-splits__totals--good", "fx-splits__totals--bad");
        if (Math.abs(remaining) < 0.01) totals.classList.add("fx-splits__totals--good");
        else if (remaining < 0) totals.classList.add("fx-splits__totals--bad");
        totals.innerHTML = `
          <span>Transaction total: <strong>${money(total)}</strong></span>
          <span>Tagged: <strong>${money(tagged)}</strong></span>
          <span>Remaining: <strong>${money(remaining)}</strong></span>
        `;
      }
      // Show the "always tag" learning row as soon as the user picks a real
      // single category. Hides it again if they switch back to uncategorized
      // or add a second split.
      const learnRow = document.querySelector<HTMLElement>("[data-categorize-learn-row]");
      if (learnRow) {
        const singleReal = c.splits.length === 1 && c.splits[0].target !== "UNCATEGORIZED:" && c.splits[0].target !== "";
        learnRow.style.display = singleReal ? "" : "none";
      }
    });
  });

  document.querySelector<HTMLFormElement>("#form-categorize")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    syncSplitsFromForm();
    const c = state.categorizeEditor;
    const userId = state.session?.user?.id;
    if (!c || !userId) return;

    // Validate: each selected category must have a non-zero amount; at most one UNCATEGORIZED row.
    const cleanSplits: CategorizeSplitRow[] = c.splits
      .filter((r) => Number.isFinite(r.amount) && Math.abs(r.amount) > 0)
      .map((r, i) => ({ ...r, amount: Math.abs(r.amount), note: r.note, id: r.id || newSplitRowLocalId(), position: i } as CategorizeSplitRow & { position?: number }));

    if (cleanSplits.length === 0) {
      state.error = "Enter an amount for at least one category.";
      render();
      return;
    }

    const transactionAmount = Math.abs(c.amount);
    const totalled = cleanSplits.reduce((s, r) => s + r.amount, 0);
    if (totalled - transactionAmount > 0.01) {
      state.error = `Tagged total (${money(totalled)}) is more than the transaction (${money(transactionAmount)}). Reduce one of the amounts.`;
      render();
      return;
    }

    const form = e.target as HTMLFormElement;
    const learnAlways = (form.querySelector<HTMLInputElement>("[data-categorize-learn]")?.checked) ?? false;
    const isSplit = cleanSplits.length > 1;
    const primary = cleanSplits[0];
    const primaryTarget = parseSplitTarget(primary.target);

    await withRecompute(async () => {
      // Primary categorization row for quick display / legacy readers.
      await saveTransactionCategorization(userId, {
        transactionId: c.txId,
        categoryKind: isSplit ? "SPLIT" : primaryTarget.kind,
        billId: !isSplit && primaryTarget.kind === "BILL" ? primaryTarget.id : null,
        debtId: !isSplit && primaryTarget.kind === "DEBT" ? primaryTarget.id : null,
        expenseId: !isSplit && primaryTarget.kind === "EXPENSE" ? primaryTarget.id : null,
        goalId: !isSplit && primaryTarget.kind === "GOAL" ? primaryTarget.id : null,
        housingBucketId: !isSplit && primaryTarget.kind === "HOUSING" ? primaryTarget.id : null,
        incomeSourceId: !isSplit && primaryTarget.kind === "INCOME" ? primaryTarget.id : null,
        note: c.note,
        isUserOverride: true,
      });

      // Persist split rows. When there's only one row we still wipe the splits table so
      // stale data from a previous multi-split save never lingers.
      if (isSplit) {
        await saveTransactionSplits(userId, c.txId, cleanSplits.map((s, i) => {
          const t = parseSplitTarget(s.target);
          return {
            id: s.id,
            position: i,
            amount: s.amount,
            categoryKind: t.kind,
            billId: t.kind === "BILL" ? t.id : null,
            debtId: t.kind === "DEBT" ? t.id : null,
            expenseId: t.kind === "EXPENSE" ? t.id : null,
            goalId: t.kind === "GOAL" ? t.id : null,
            housingBucketId: t.kind === "HOUSING" ? t.id : null,
            incomeSourceId: t.kind === "INCOME" ? t.id : null,
            note: s.note,
          };
        }));
      } else {
        await saveTransactionSplits(userId, c.txId, []);
      }

      // Post planner actuals (bill_payments / debt_transactions / expense_spends / housing_payments)
      // for every split that points at something the planner can protect.
      const txRef = {
        id: c.txId,
        description: c.description,
        merchant: c.merchant ?? "",
        amount: c.amount,
        postedDate: c.postedDate,
      };
      const actuals = cleanSplits.map((s, i) => ({
        index: i,
        target: parseSplitTarget(s.target),
        amount: s.amount,
        note: s.note,
      }));
      await linkTransactionSplitsToPlannerActuals(userId, c.txId, actuals, txRef, "Manual");

      // Teach auto-categorize — only for the single-category case to avoid guessing splits.
      if (learnAlways && !isSplit && primaryTarget.kind !== "UNCATEGORIZED" && primaryTarget.kind !== "CASH_IN" && primaryTarget.kind !== "CASH_OUT") {
        const matcherValue = (c.merchant || c.description || "").trim();
        if (matcherValue) {
          const ruleTargetKind = primaryTarget.kind as "BILL" | "DEBT" | "EXPENSE" | "GOAL" | "HOUSING" | "INCOME";
          const id = "id" in primaryTarget ? primaryTarget.id : "";
          await upsertCategoryRuleFromAdjustment(userId, {
            matcherValue,
            name: `Always tag "${matcherValue}" as ${ruleTargetKind.toLowerCase()}`,
            targetKind: ruleTargetKind,
            targetBillId: ruleTargetKind === "BILL" ? id : null,
            targetDebtId: ruleTargetKind === "DEBT" ? id : null,
            targetExpenseId: ruleTargetKind === "EXPENSE" ? id : null,
            targetGoalId: ruleTargetKind === "GOAL" ? id : null,
            targetHousingBucketId: ruleTargetKind === "HOUSING" ? id : null,
            targetIncomeSourceId: ruleTargetKind === "INCOME" ? id : null,
          });
        }
      }
    }, isSplit ? "Split saved." : "Tagged.");

    await refreshTxAssignmentCache();
    state.categorizeEditor = null;
    render();
  });
}

function wireSettingsEditorButtons() {
  document.querySelectorAll<HTMLButtonElement>("[data-settings-add]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const kind = btn.getAttribute("data-settings-add") as SettingsEditorState["kind"] | null;
      if (!kind) return;
      state.settingsEditor = { kind } as SettingsEditorState;
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
          case "deduction": await deleteDeductionRule(userId, id); break;
          case "category": await deleteUserCategory(userId, id); break;
          case "label": await deleteCustomLabel(userId, id); break;
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
    editorForm.addEventListener("click", (e) => {
      const btn = (e.target as HTMLElement | null)?.closest<HTMLButtonElement>("button[data-choice-seg]");
      if (!btn || !editorForm.contains(btn)) return;
      const field = btn.getAttribute("data-choice-field");
      const val = btn.getAttribute("data-choice-value") ?? "";
      if (!field) return;
      const hidden = editorForm.querySelector<HTMLInputElement>(`input[type="hidden"][name="${field}"]`);
      if (!hidden) return;
      hidden.value = val;
      const group = btn.closest(".fx-seg");
      group?.querySelectorAll<HTMLButtonElement>("button[data-choice-seg]").forEach((b) => {
        const on = b === btn;
        b.classList.toggle("is-active", on);
        b.setAttribute("aria-checked", on ? "true" : "false");
      });
    });
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
          case "deduction": await deleteDeductionRule(userId, id); break;
          case "category": await deleteUserCategory(userId, id); break;
          case "label": await deleteCustomLabel(userId, id); break;
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
      case "deduction":
        await saveDeductionRule(userId, {
          id,
          name: getStr("name"),
          scope: (getStr("scope") as "GLOBAL" | "INCOME_SOURCE") || "GLOBAL",
          incomeSourceId: getStr("incomeSourceId") || null,
          valueType: (getStr("valueType") as "PERCENTAGE" | "FIXED_AMOUNT") || "PERCENTAGE",
          fixedAmount: getNum("fixedAmount") ?? 0,
          percentage: getNum("percentage") ?? 0,
          status: getStr("status") || "MANDATORY",
          isEnabledByDefault: fd.get("isEnabledByDefault") === "on",
          notes: getStr("notes"),
        });
        break;
      case "category":
        await saveUserCategory(userId, {
          id,
          name: getStr("name"),
          kind: getStr("kind") || "GENERAL",
          notes: getStr("notes"),
        });
        break;
      case "label":
        await saveCustomLabel(userId, {
          id,
          label: getStr("label"),
          notes: getStr("notes"),
        });
        break;
      case "planner-settings":
        await savePlannerSettings(userId, {
          targetBuffer: getNum("targetBuffer") ?? 0,
          safetyFloorCash: getNum("safetyFloorCash") ?? 0,
          horizonDays: getNum("horizonDays") ?? 120,
          reserveNearFutureWindowDays: getNum("reserveNearFutureWindowDays") ?? undefined,
          selectedScenarioMode: (getStr("selectedScenarioMode") as "FIXED" | "LOWEST_INCOME" | "MOST_EFFICIENT" | "HIGHEST_INCOME") || "FIXED",
          planningStyle: getStr("planningStyle") || undefined,
          currency: getStr("currency") || undefined,
          timezone: getStr("timezone") || undefined,
          allowNegativeCash: fd.get("allowNegativeCash") === "on",
          sameDayIncomeBeforeSameDayBills: fd.get("sameDayIncomeBeforeSameDayBills") === "on",
          optimizationGoal: getStr("optimizationGoal") || undefined,
          payoffMode: getStr("payoffMode") || undefined,
          housingPaymentMode: getStr("housingPaymentMode") || undefined,
          housingPayoffTargetMode: getStr("housingPayoffTargetMode") || undefined,
          priorityOrder: getStr("priorityOrder") || undefined,
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
    if (e.key !== "Escape") return;
    const drawer = document.getElementById("fx-nav-drawer");
    if (drawer?.classList.contains("is-open")) {
      e.preventDefault();
      setMobileNavOpen(false);
      return;
    }
    if (state.session || !state.authModalOpen) return;
    e.preventDefault();
    closeAuthModal();
  });
}

void init();
