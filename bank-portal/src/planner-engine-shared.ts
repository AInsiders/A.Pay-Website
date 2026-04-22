// Shared deterministic planner engine used by the website client.
// Pure functions, no external deps. The same logic runs in Edge Functions
// for background recompute (see supabase/functions/planner-recompute).
//
// Inputs: PlannerSnapshot built from Supabase rows.
// Outputs: PlannerPlan that the UI consumes (safe-to-spend, timeline, due lists,
// scenario summaries, goals, etc.).
//
// Keep in sync with supabase/functions/planner-recompute/index.ts when changing
// planner behavior so the web preview and any server-side recompute stay consistent.

import type {
  PlannerAllocationLine,
  PlannerCatchUpAnalytics,
  PlannerDashboardOverview,
  PlannerDebtSummaryItem,
  PlannerDueItemRecommendation,
  PlannerFirstFailure,
  PlannerGoalProgress,
  PlannerNextPaycheckNeed,
  PlannerNonPaydayObligation,
  PlannerPlan,
  PlannerReserveAllocationLine,
  PlannerRiskLevel,
  PlannerScenarioMode,
  PlannerScenarioSummary,
  PlannerSuggestedEssentialLine,
  PlannerTimelinePaycheckPlan,
} from "./planner-state";

// Snapshot shapes — kept here so the engine is self-contained when imported by UI code.
export interface RecurringRule {
  type:
    | "ONE_TIME"
    | "DAILY"
    | "WEEKLY"
    | "BIWEEKLY"
    | "SEMI_MONTHLY"
    | "MONTHLY"
    | "QUARTERLY"
    | "YEARLY"
    | "EVERY_X_DAYS"
    | "CUSTOM_INTERVAL";
  anchorDate?: string;
  intervalDays?: number;
  dayOfMonth?: number;
  semiMonthlyDays?: number[];
}

export interface MonetaryRange {
  minimum?: number;
  target?: number;
  maximum?: number;
}

export interface SnapshotAccount {
  id: string;
  name: string;
  type: string;
  currentBalance: number;
  availableBalance: number;
  includeInPlanning: boolean;
  protectedFromPayoff?: boolean;
  tellerEnrollmentId?: string | null;
  tellerLinkedAccountId?: string | null;
}

export interface SnapshotIncomeSource {
  id: string;
  name: string;
  payerLabel?: string;
  recurringRule: RecurringRule;
  amountRange: MonetaryRange;
  forecastAmountMode?: "FIXED" | "RANGE";
  inputMode?: "GROSS" | "NET" | "USABLE";
  nextExpectedPayDate?: string | null;
  isActive?: boolean;
  isManualOnly?: boolean;
}

export interface SnapshotPaycheck {
  id: string;
  incomeSourceId?: string | null;
  payerLabel?: string;
  date: string;
  amount: number;
  deposited?: boolean;
  accountId?: string | null;
}

export interface SnapshotBill {
  id: string;
  name: string;
  amountDue: number;
  minimumDue: number;
  currentAmountDue: number;
  recurringRule?: RecurringRule;
  category?: string;
  isEssential?: boolean;
  status?: "UPCOMING" | "DUE" | "PAID" | "OVERDUE" | "PARTIAL";
  paymentPolicy?: "HARD_DUE" | "FLEXIBLE_DUE";
}

export interface SnapshotBillPayment {
  id: string;
  billId: string;
  amount: number;
  paymentDate: string;
}

export interface SnapshotDebt {
  id: string;
  name: string;
  lender?: string;
  type?: string;
  currentBalance: number;
  minimumDue: number;
  requiredDueDate?: string | null;
  arrearsAmount?: number;
  /** When set, the planner uses the live `bank_accounts` balance for this id as the debt balance. */
  bankAccountId?: string | null;
}

export interface SnapshotDebtTransaction {
  id: string;
  debtId: string;
  type: "PAYMENT" | "BORROW" | "REPAYMENT";
  amount: number;
  eventDate: string;
}

export interface SnapshotRecurringExpense {
  id: string;
  name: string;
  amount: number;
  recurringRule: RecurringRule;
  isEssential?: boolean;
  isVariable?: boolean;
  allocationMode?: "EVENLY" | "MANUAL" | "ON_DUE_DATE";
  oneTimeDate?: string | null;
  categoryLabel?: string;
}

export interface SnapshotExpenseSpend {
  id: string;
  expenseId: string;
  amount: number;
  spendDate: string;
}

export interface SnapshotHousingConfig {
  currentMonthlyRent: number;
  minimumAcceptablePayment: number;
  rentDueDay: number;
  arrangement?: string;
}

export interface SnapshotHousingBucket {
  id: string;
  label: string;
  monthKey: string;
  amountDue: number;
  amountPaid: number;
  dueDate?: string | null;
  isCurrentBucket?: boolean;
}

export interface SnapshotHousingPayment {
  id: string;
  bucketId: string;
  amount: number;
  paymentDate: string;
}

export interface SnapshotGoal {
  id: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  isActive?: boolean;
}

export interface SnapshotCashAdjustment {
  id: string;
  accountId?: string | null;
  type: string;
  amount: number;
  adjustmentDate: string;
}

/** Matches Android `PaycheckDeductionRule` / `deduction_rules` table. */
export interface SnapshotDeductionRule {
  id: string;
  name: string;
  scope?: "GLOBAL" | "INCOME_SOURCE";
  incomeSourceId?: string | null;
  valueType?: "PERCENTAGE" | "FIXED_AMOUNT";
  fixedAmount?: number;
  percentage?: number;
  status?: string;
  isEnabledByDefault?: boolean;
  notes?: string;
}

/** Matches `user_categories`. */
export interface SnapshotUserCategory {
  id: string;
  name: string;
  kind?: string;
  notes?: string;
}

/** Matches `custom_labels`. */
export interface SnapshotCustomLabel {
  id: string;
  label: string;
  notes?: string;
}

/** Matches Android `NotificationSettings` (persisted in `planner_settings.notification_settings`). */
export interface NotificationSettingsSnapshot {
  id?: string;
  paydayNotificationsEnabled?: boolean;
  recalculateRemindersEnabled?: boolean;
  paydayLeadMinutes?: number;
  recalculateReminderHour?: number;
  recalculateReminderMinute?: number;
}

export interface ExportMetadataSnapshot {
  id?: string;
  schemaVersion?: number;
  appVersion?: string;
  lastExportAt?: string | null;
  lastImportAt?: string | null;
  lastFileName?: string | null;
}

export interface PlannerSettingsSnapshot {
  targetBuffer?: number;
  selectedScenarioMode?: PlannerScenarioMode;
  planningStyle?: string;
  horizonDays?: number;
  /** Extended fields stored in JSON; TS engine may ignore until parity. */
  safetyFloorCash?: number;
  reserveNearFutureWindowDays?: number;
  currency?: string;
  timezone?: string;
  allowNegativeCash?: boolean;
  sameDayIncomeBeforeSameDayBills?: boolean;
  roundingMode?: string;
  optimizationGoal?: string;
  payoffMode?: string;
  housingPaymentMode?: string;
  housingPayoffTargetMode?: string;
  priorityOrder?: string;
}

export interface PlannerSnapshot {
  today: string;
  accounts: SnapshotAccount[];
  incomeSources: SnapshotIncomeSource[];
  paychecks: SnapshotPaycheck[];
  bills: SnapshotBill[];
  billPayments: SnapshotBillPayment[];
  debts: SnapshotDebt[];
  debtTransactions: SnapshotDebtTransaction[];
  expenses: SnapshotRecurringExpense[];
  expenseSpends: SnapshotExpenseSpend[];
  housingConfig?: SnapshotHousingConfig | null;
  housingBuckets: SnapshotHousingBucket[];
  housingPayments: SnapshotHousingPayment[];
  goals: SnapshotGoal[];
  cashAdjustments: SnapshotCashAdjustment[];
  settings: PlannerSettingsSnapshot;
  deductionRules: SnapshotDeductionRule[];
  categories: SnapshotUserCategory[];
  labels: SnapshotCustomLabel[];
  notificationSettings: NotificationSettingsSnapshot;
  exportMetadata: ExportMetadataSnapshot;
}

export const PLANNER_SCHEMA_VERSION = "billpayer-shared-v1";
export const PLANNER_ENGINE_VERSION = "ts-engine-0.2.0";

const DEFAULT_HORIZON_DAYS = 120;
const DUE_SOON_WINDOW_DAYS = 14;

function money(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function formatDollars(n: number): string {
  const abs = Math.abs(n);
  const base = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "-$" : "$") + base;
}

function parseIsoDate(value: string | null | undefined): Date | null {
  if (!value) return null;
  const t = value.trim();
  if (!t) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(t);
  if (m) {
    const out = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
    return Number.isNaN(out.getTime()) ? null : out;
  }
  const parsed = new Date(t);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function toIsoDate(date: Date): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86400000);
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function startOfDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function expandRecurringDates(
  rule: RecurringRule | null | undefined,
  from: Date,
  to: Date,
  maxIterations = 1024,
): Date[] {
  if (!rule) return [];
  const out: Date[] = [];
  const anchor = parseIsoDate(rule.anchorDate ?? null) ?? from;
  const startBoundary = startOfDay(from);
  const endBoundary = startOfDay(to);
  const push = (d: Date) => {
    const day = startOfDay(d);
    if (day.getTime() < startBoundary.getTime()) return;
    if (day.getTime() > endBoundary.getTime()) return;
    out.push(day);
  };
  switch (rule.type) {
    case "ONE_TIME":
      push(anchor);
      break;
    case "DAILY": {
      let cur = anchor;
      let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, 1);
      }
      break;
    }
    case "WEEKLY": {
      let cur = anchor;
      let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, 7);
      }
      break;
    }
    case "BIWEEKLY": {
      let cur = anchor;
      let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, 14);
      }
      break;
    }
    case "EVERY_X_DAYS": {
      const step = Math.max(1, rule.intervalDays ?? 7);
      let cur = anchor;
      let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, step);
      }
      break;
    }
    case "CUSTOM_INTERVAL": {
      const step = Math.max(1, rule.intervalDays ?? 30);
      let cur = anchor;
      let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur);
        cur = addDays(cur, step);
      }
      break;
    }
    case "SEMI_MONTHLY": {
      const days = rule.semiMonthlyDays && rule.semiMonthlyDays.length >= 1 ? rule.semiMonthlyDays : [1, 15];
      let y = startBoundary.getUTCFullYear();
      let mo = startBoundary.getUTCMonth();
      let i = 0;
      while (i++ < maxIterations) {
        let any = false;
        for (const dr of days) {
          const day = Math.min(28, Math.max(1, dr));
          const c = new Date(Date.UTC(y, mo, day));
          if (c.getTime() < startBoundary.getTime()) continue;
          if (c.getTime() > endBoundary.getTime()) return out.sort((a, b) => a.getTime() - b.getTime());
          push(c);
          any = true;
        }
        mo++;
        if (mo > 11) {
          mo = 0;
          y++;
        }
        if (!any && y > endBoundary.getUTCFullYear() + 2) break;
      }
      break;
    }
    case "MONTHLY": {
      const pd = rule.dayOfMonth ?? anchor.getUTCDate();
      let y = startBoundary.getUTCFullYear();
      let mo = startBoundary.getUTCMonth();
      let i = 0;
      while (i++ < maxIterations) {
        const maxDay = new Date(Date.UTC(y, mo + 1, 0)).getUTCDate();
        const day = Math.min(pd, maxDay);
        const c = new Date(Date.UTC(y, mo, day));
        if (c.getTime() >= startBoundary.getTime() && c.getTime() <= endBoundary.getTime()) push(c);
        mo++;
        if (mo > 11) {
          mo = 0;
          y++;
        }
        if (y > endBoundary.getUTCFullYear() + 2) break;
      }
      break;
    }
    case "QUARTERLY": {
      const pd = rule.dayOfMonth ?? anchor.getUTCDate();
      let cur = startOfDay(anchor);
      let i = 0;
      while (i++ < maxIterations && cur.getTime() <= endBoundary.getTime()) {
        if (cur.getTime() >= startBoundary.getTime()) push(cur);
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 3, pd));
      }
      break;
    }
    case "YEARLY": {
      const am = anchor.getUTCMonth();
      const ad = anchor.getUTCDate();
      let y = Math.max(startBoundary.getUTCFullYear(), anchor.getUTCFullYear());
      let i = 0;
      while (i++ < maxIterations) {
        const c = new Date(Date.UTC(y, am, ad));
        if (c.getTime() > endBoundary.getTime()) break;
        if (c.getTime() >= startBoundary.getTime()) push(c);
        y++;
      }
      break;
    }
  }
  return out.sort((a, b) => a.getTime() - b.getTime());
}

function riskForObligation(days: number, isHardDue: boolean): PlannerRiskLevel {
  if (days < 0) return "CRITICAL";
  if (days <= 2) return isHardDue ? "CRITICAL" : "HIGH";
  if (days <= 7) return "HIGH";
  if (days <= 14) return "MEDIUM";
  return "LOW";
}

function scenarioAmount(range: MonetaryRange, mode: PlannerScenarioMode): number {
  const min = range.minimum ?? 0;
  const target = range.target ?? min;
  const max = range.maximum ?? target;
  switch (mode) {
    case "LOWEST_INCOME":
      return min;
    case "HIGHEST_INCOME":
      return max;
    default:
      return target;
  }
}

interface ForecastPaycheck {
  id: string;
  incomeSourceId: string | null;
  payerLabel: string;
  date: Date;
  usableAmount: number;
  forecastedAmount: number;
  enteredAmount: number | null;
}

interface ForecastObligation {
  id: string;
  sourceId: string;
  sourceType: "BILL" | "DEBT" | "EXPENSE" | "RENT" | "BORROW_REPAYMENT";
  label: string;
  dueDate: Date;
  amount: number;
  minimumDue: number;
  isEssential: boolean;
  isHardDue: boolean;
}

function forecastPaychecks(
  snapshot: PlannerSnapshot,
  mode: PlannerScenarioMode,
  today: Date,
  horizon: Date,
): ForecastPaycheck[] {
  const out: ForecastPaycheck[] = [];
  for (const source of snapshot.incomeSources) {
    if (source.isActive === false) continue;
    const rule = source.recurringRule;
    if (!rule) continue;
    const amt = scenarioAmount(source.amountRange, mode);
    const startingAnchor = parseIsoDate(source.nextExpectedPayDate ?? null) ?? today;
    const from = startingAnchor.getTime() < today.getTime() ? today : startingAnchor;
    const dates = expandRecurringDates(rule, from, horizon);
    for (const date of dates) {
      const entered = snapshot.paychecks.find((p) => {
        if (p.incomeSourceId && p.incomeSourceId !== source.id) return false;
        const pDate = parseIsoDate(p.date);
        if (!pDate) return false;
        return startOfDay(pDate).getTime() === startOfDay(date).getTime();
      });
      out.push({
        id: `${source.id}|${toIsoDate(date)}`,
        incomeSourceId: source.id,
        payerLabel: source.payerLabel || source.name,
        date,
        usableAmount: entered ? money(entered.amount) : amt,
        forecastedAmount: amt,
        enteredAmount: entered ? money(entered.amount) : null,
      });
    }
  }
  for (const p of snapshot.paychecks) {
    const pDate = parseIsoDate(p.date);
    if (!pDate || pDate.getTime() < today.getTime() || p.incomeSourceId) continue;
    out.push({
      id: p.id,
      incomeSourceId: null,
      payerLabel: p.payerLabel || "Paycheck",
      date: pDate,
      usableAmount: money(p.amount),
      forecastedAmount: money(p.amount),
      enteredAmount: money(p.amount),
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function paidSumByBill(snapshot: PlannerSnapshot, billId: string): number {
  return snapshot.billPayments
    .filter((p) => p.billId === billId)
    .reduce((s, p) => s + (p.amount || 0), 0);
}

function paidSumByDebt(snapshot: PlannerSnapshot, debtId: string): number {
  return snapshot.debtTransactions
    .filter((t) => t.debtId === debtId && t.type === "PAYMENT")
    .reduce((s, t) => s + (t.amount || 0), 0);
}

function forecastBillObligations(snapshot: PlannerSnapshot, today: Date, horizon: Date): ForecastObligation[] {
  const out: ForecastObligation[] = [];
  for (const bill of snapshot.bills) {
    const paid = paidSumByBill(snapshot, bill.id);
    const isHardDue = (bill.paymentPolicy ?? "HARD_DUE") === "HARD_DUE";
    if (bill.currentAmountDue > 0 && bill.status !== "PAID") {
      const due = parseIsoDate(bill.recurringRule?.anchorDate ?? null) ?? today;
      out.push({
        id: `${bill.id}|${toIsoDate(due)}`,
        sourceId: bill.id,
        sourceType: "BILL",
        label: bill.name,
        dueDate: due,
        amount: money(bill.currentAmountDue),
        minimumDue: money(bill.minimumDue),
        isEssential: bill.isEssential ?? false,
        isHardDue,
      });
    }
    if (bill.recurringRule) {
      const future = expandRecurringDates(bill.recurringRule, today, horizon);
      for (const d of future) {
        const id = `${bill.id}|${toIsoDate(d)}`;
        if (out.some((x) => x.id === id)) continue;
        const amount = money(bill.amountDue);
        if (amount <= 0) continue;
        if (d.getTime() === today.getTime() && paid >= amount) continue;
        out.push({
          id,
          sourceId: bill.id,
          sourceType: "BILL",
          label: bill.name,
          dueDate: d,
          amount,
          minimumDue: money(bill.minimumDue),
          isEssential: bill.isEssential ?? false,
          isHardDue,
        });
      }
    }
  }
  return out.sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());
}

function forecastDebtObligations(snapshot: PlannerSnapshot, today: Date, horizon: Date): ForecastObligation[] {
  const out: ForecastObligation[] = [];
  for (const debt of snapshot.debts) {
    if (debt.minimumDue <= 0) continue;
    const due = parseIsoDate(debt.requiredDueDate ?? null) ?? today;
    if (due.getTime() > horizon.getTime()) continue;
    out.push({
      id: `${debt.id}|${toIsoDate(due)}`,
      sourceId: debt.id,
      sourceType: "DEBT",
      label: debt.name,
      dueDate: due,
      amount: money(debt.minimumDue),
      minimumDue: money(debt.minimumDue),
      isEssential: false,
      isHardDue: true,
    });
  }
  return out;
}

/**
 * Return the live bank balance that represents the debt's outstanding balance,
 * or `null` if the debt is not linked. Credit-card accounts report the owed
 * amount as a positive `currentBalance`; depository accounts don't make sense
 * as a debt source, so we only honor the link when the account's balance is
 * non-zero so an unsynced account doesn't silently zero out a debt.
 */
function liveBalanceForDebt(
  debt: SnapshotDebt,
  accountsById: Map<string, SnapshotAccount>,
): number | null {
  const linkedId = debt.bankAccountId?.trim();
  if (!linkedId) return null;
  const account = accountsById.get(linkedId);
  if (!account) return null;
  return Math.abs(account.currentBalance);
}

function forecastHousingObligations(snapshot: PlannerSnapshot, today: Date): ForecastObligation[] {
  const out: ForecastObligation[] = [];
  for (const bucket of snapshot.housingBuckets) {
    const remaining = Math.max(0, money(bucket.amountDue - bucket.amountPaid));
    if (remaining <= 0) continue;
    const due = parseIsoDate(bucket.dueDate ?? null) ?? today;
    out.push({
      id: `rent|${bucket.id}`,
      sourceId: bucket.id,
      sourceType: "RENT",
      label: bucket.label || "Housing",
      dueDate: due,
      amount: remaining,
      minimumDue: remaining,
      isEssential: true,
      isHardDue: true,
    });
  }
  return out;
}

function essentialDailyRate(expense: SnapshotRecurringExpense): number {
  const rule = expense.recurringRule;
  const amount = expense.amount || 0;
  switch (rule?.type) {
    case "DAILY":
      return amount;
    case "WEEKLY":
      return amount / 7;
    case "BIWEEKLY":
      return amount / 14;
    case "MONTHLY":
      return amount / 30;
    case "SEMI_MONTHLY":
      return amount / 15;
    case "QUARTERLY":
      return amount / 91;
    case "YEARLY":
      return amount / 365;
    case "EVERY_X_DAYS":
    case "CUSTOM_INTERVAL":
      return amount / Math.max(1, rule.intervalDays ?? 30);
    default:
      return 0;
  }
}

function totalCashAvailable(snapshot: PlannerSnapshot): number {
  return snapshot.accounts
    .filter((a) => a.includeInPlanning)
    .reduce((s, a) => s + a.availableBalance, 0);
}

function essentialsBetween(snapshot: PlannerSnapshot, from: Date, to: Date): number {
  if (to.getTime() <= from.getTime()) return 0;
  const days = daysBetween(from, to);
  let total = 0;
  for (const expense of snapshot.expenses) {
    if (!expense.isEssential) continue;
    total += essentialDailyRate(expense) * days;
  }
  return money(total);
}

/** Actual essential spends in [from, to] inclusive (UTC day boundaries). */
function spentOnExpenseInWindow(snapshot: PlannerSnapshot, expenseId: string, from: Date, to: Date): number {
  const f = startOfDay(from).getTime();
  const t = startOfDay(to).getTime();
  let sum = 0;
  for (const s of snapshot.expenseSpends) {
    if (s.expenseId !== expenseId) continue;
    const d = parseIsoDate(s.spendDate);
    if (!d) continue;
    const x = startOfDay(d).getTime();
    if (x >= f && x <= t) sum += s.amount || 0;
  }
  return money(sum);
}

/**
 * Split `safeToSpendNow` across essential categories by remaining interval budget
 * (spec §9 suggested use).
 */
function buildSuggestedEssentialUse(
  snapshot: PlannerSnapshot,
  today: Date,
  intervalDays: number,
  safeToSpendNow: number,
): PlannerSuggestedEssentialLine[] {
  if (safeToSpendNow <= 0) return [];
  const essentials = snapshot.expenses.filter((e) => e.isEssential);
  if (!essentials.length) return [];
  const lookbackDays = Math.max(1, Math.min(intervalDays, 90));
  const spendFrom = addDays(today, -(lookbackDays - 1));
  const lines: PlannerSuggestedEssentialLine[] = [];
  for (const e of essentials) {
    const dr = essentialDailyRate(e);
    const intervalBudget = money(dr * intervalDays);
    const spentLookback = spentOnExpenseInWindow(snapshot, e.id, spendFrom, today);
    const remainingBudget = Math.max(0, money(intervalBudget - spentLookback));
    lines.push({
      expenseId: e.id,
      label: e.name,
      intervalDays,
      dailyRate: money(dr),
      intervalBudget,
      spentLookback,
      remainingBudget,
      suggestedFromSafeToSpend: 0,
    });
  }
  const weights = lines.map((row) =>
    row.remainingBudget > 0 ? row.remainingBudget : Math.max(0.01, money(row.dailyRate * intervalDays * 0.25)),
  );
  const sumW = weights.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return [];
  for (let i = 0; i < lines.length; i++) {
    const raw = money(safeToSpendNow * (weights[i] / sumW));
    lines[i].suggestedFromSafeToSpend = lines[i].remainingBudget > 0
      ? money(Math.min(raw, lines[i].remainingBudget))
      : money(raw);
  }
  const totalSuggested = money(lines.reduce((s, r) => s + r.suggestedFromSafeToSpend, 0));
  if (totalSuggested > safeToSpendNow + 0.01) {
    const scale = safeToSpendNow / Math.max(totalSuggested, 0.01);
    for (const row of lines) row.suggestedFromSafeToSpend = money(row.suggestedFromSafeToSpend * scale);
  }
  return lines.filter((r) => r.suggestedFromSafeToSpend > 0.005 || r.remainingBudget > 0);
}

/** Sum hard obligations with due date on or before `boundary` (inclusive). Includes overdue. */
function sumHardDueOnOrBefore(obligations: ForecastObligation[], boundary: Date): number {
  const b = startOfDay(boundary).getTime();
  return money(
    obligations.filter((o) => o.isHardDue && startOfDay(o.dueDate).getTime() <= b).reduce((s, o) => s + o.amount, 0),
  );
}

function dueRec(o: ForecastObligation, today: Date): PlannerDueItemRecommendation {
  const days = daysBetween(today, o.dueDate);
  return {
    sourceId: o.sourceId,
    label: o.label,
    amount: o.amount,
    dueDate: toIsoDate(o.dueDate),
    riskLevel: riskForObligation(days, o.isHardDue),
    rationale: days < 0
      ? `${Math.abs(days)} day(s) overdue`
      : days === 0
        ? "Due today"
        : `Due in ${days} day(s)`,
  };
}

function buildTimeline(
  snapshot: PlannerSnapshot,
  paychecks: ForecastPaycheck[],
  obligations: ForecastObligation[],
): PlannerTimelinePaycheckPlan[] {
  const timeline: PlannerTimelinePaycheckPlan[] = [];
  let cash = totalCashAvailable(snapshot);
  for (let i = 0; i < paychecks.length; i++) {
    const p = paychecks[i];
    const next = paychecks[i + 1];
    const intervalEnd = next ? next.date : addDays(p.date, 30);
    const essentialsNeeded = essentialsBetween(snapshot, p.date, intervalEnd);
    const dueInWindow = obligations.filter((o) =>
      o.dueDate.getTime() >= p.date.getTime() && o.dueDate.getTime() < intervalEnd.getTime()
    );
    const payNowList: PlannerAllocationLine[] = dueInWindow
      .filter((o) => o.isHardDue)
      .map((o) => ({
        sourceId: o.sourceId,
        label: o.label,
        bucket: o.sourceType === "DEBT"
          ? "DEBT_MINIMUM"
          : o.sourceType === "RENT"
            ? "HOUSING_CURRENT"
            : "BILL",
        amount: o.amount,
        rationale: `Due ${toIsoDate(o.dueDate)} - covered from ${p.payerLabel}`,
      }));
    const reserveNowList: PlannerReserveAllocationLine[] = obligations
      .filter((o) => o.dueDate.getTime() >= intervalEnd.getTime())
      .slice(0, 5)
      .map((o) => ({
        obligationId: o.id,
        sourceId: o.sourceId,
        label: o.label,
        amount: o.amount,
        dueDate: toIsoDate(o.dueDate),
        sourcePayDate: toIsoDate(p.date),
        reserveKind: o.sourceType,
      }));
    const allocations: PlannerAllocationLine[] = [];
    if (essentialsNeeded > 0) {
      allocations.push({
        label: "Essentials",
        bucket: "ESSENTIALS",
        amount: essentialsNeeded,
        rationale: "Daily living costs until next paycheck.",
      });
    }
    allocations.push(...payNowList);
    const usable = p.usableAmount;
    const startingCash = cash;
    const allocated = allocations.reduce((s, a) => s + a.amount, 0);
    const amountLeft = money(Math.max(0, usable - allocated));
    cash = money(cash + amountLeft);
    timeline.push({
      date: toIsoDate(p.date),
      payerLabel: p.payerLabel,
      sourceId: p.incomeSourceId,
      enteredAmount: p.enteredAmount,
      forecastedAmount: p.forecastedAmount,
      deductionAmount: 0,
      usableAmount: usable,
      startingCash,
      allocations,
      payNowList,
      reserveNowList,
      amountLeftAfterAllocations: amountLeft,
      endingAvailableCash: cash,
      endingReservedCash: reserveNowList.reduce((s, r) => s + r.amount, 0),
    });
  }
  return timeline;
}

export function buildPlannerPlan(snapshot: PlannerSnapshot): PlannerPlan {
  const today = parseIsoDate(snapshot.today) ?? startOfDay(new Date());
  const horizonDays = snapshot.settings.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const horizon = addDays(today, horizonDays);
  const mode: PlannerScenarioMode = snapshot.settings.selectedScenarioMode ?? "FIXED";
  const safetyFloor = snapshot.settings.targetBuffer ?? 0;

  const paychecks = forecastPaychecks(snapshot, mode, today, horizon);
  const obligations = [
    ...forecastBillObligations(snapshot, today, horizon),
    ...forecastDebtObligations(snapshot, today, horizon),
    ...forecastHousingObligations(snapshot, today),
  ].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const cash = totalCashAvailable(snapshot);
  const futureIncomeTotal = paychecks.reduce((s, p) => s + p.usableAmount, 0);
  const essentialsThroughHorizon = essentialsBetween(snapshot, today, horizon);
  const hardDueHorizon = money(
    obligations
      .filter((o) => o.isHardDue && o.dueDate.getTime() <= horizon.getTime())
      .reduce((s, o) => s + o.amount, 0),
  );
  const overdueTotal = money(
    obligations.filter((o) => o.dueDate.getTime() < today.getTime()).reduce((s, o) => s + o.amount, 0),
  );
  /** Long-window protected load (no double-count overdue vs hard horizon). */
  const legacyProtectedTotal = money(essentialsThroughHorizon + hardDueHorizon);

  const nextPaycheck = paychecks[0] ?? null;
  const nextIncomeBoundary = nextPaycheck ? startOfDay(nextPaycheck.date) : horizon;
  const intervalDaysUntilNextIncome = Math.max(1, daysBetween(today, nextIncomeBoundary));
  const essentialsDueForCurrentInterval = nextPaycheck
    ? essentialsBetween(snapshot, today, nextPaycheck.date)
    : essentialsBetween(snapshot, today, horizon);
  const hardDueBeforeNextIncome = sumHardDueOnOrBefore(obligations, nextIncomeBoundary);

  const timeline = buildTimeline(snapshot, paychecks, obligations);
  const crossPaycheckReserveTotal = money(
    (timeline[0]?.reserveNowList ?? []).reduce((s, r) => s + r.amount, 0),
  );
  const requiredCashNow = money(essentialsDueForCurrentInterval + hardDueBeforeNextIncome + crossPaycheckReserveTotal);

  const safeToSpendNow = Math.max(0, money(cash - requiredCashNow - safetyFloor));
  const amountShort = Math.max(0, money(requiredCashNow + safetyFloor - cash));
  const safeToSpendAfterNextDeposit = nextPaycheck
    ? Math.max(0, money(cash + nextPaycheck.usableAmount - requiredCashNow - safetyFloor))
    : safeToSpendNow;

  const nextPayDate = nextPaycheck?.date ?? null;

  const overdueNow = obligations
    .filter((o) => o.dueDate.getTime() < today.getTime())
    .map((o) => dueRec(o, today));
  const dueToday = obligations
    .filter((o) => o.dueDate.getTime() === today.getTime())
    .map((o) => dueRec(o, today));
  const dueBeforeNextPaycheck = nextPayDate
    ? obligations
      .filter((o) =>
        o.dueDate.getTime() > today.getTime() && o.dueDate.getTime() <= nextPayDate.getTime()
      )
      .map((o) => dueRec(o, today))
    : [];
  const dueSoonCutoff = addDays(today, DUE_SOON_WINDOW_DAYS);
  const dueSoon = obligations
    .filter((o) =>
      o.dueDate.getTime() > today.getTime() && o.dueDate.getTime() <= dueSoonCutoff.getTime()
    )
    .map((o) => dueRec(o, today));

  const whatMustBePaidNow = [
    ...overdueNow,
    ...dueToday,
    ...dueBeforeNextPaycheck.filter((d) => d.riskLevel === "CRITICAL" || d.riskLevel === "HIGH"),
  ];
  const whatCanBeDelayed = obligations
    .filter((o) => !o.isHardDue && o.dueDate.getTime() > today.getTime())
    .slice(0, 10)
    .map((o) => dueRec(o, today));

  const reservesHeld = timeline.flatMap((row) => row.reserveNowList ?? []).slice(0, 12);

  const accountsById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const debtItems: PlannerDebtSummaryItem[] = [];
  let debtTotal = 0;
  for (const d of snapshot.debts) {
    const paid = paidSumByDebt(snapshot, d.id);
    const liveBalance = liveBalanceForDebt(d, accountsById);
    const sourceBalance = liveBalance ?? d.currentBalance;
    const bal = Math.max(0, money(sourceBalance - paid));
    debtTotal += bal;
    debtItems.push({ label: d.name, balanceLeft: bal });
  }
  for (const b of snapshot.housingBuckets) {
    const rem = Math.max(0, money(b.amountDue - b.amountPaid));
    if (rem > 0) debtTotal += rem;
  }
  const isOutOfDebt = debtTotal <= 0;

  const warnings: string[] = [];
  if (snapshot.incomeSources.length === 0) {
    warnings.push("No income sources yet. Add one under Accounts -> Income so the planner can forecast.");
  }
  if (snapshot.accounts.filter((a) => a.includeInPlanning).length === 0) {
    warnings.push("No bank accounts are included in planning. Link a bank or toggle an account on.");
  }
  if (amountShort > 0) {
    warnings.push(
      nextPaycheck
        ? `Wallet is short ${formatDollars(amountShort)} for essentials + hard dues + reserves before ${toIsoDate(nextPaycheck.date)} (safety buffer included).`
        : `Wallet is short ${formatDollars(amountShort)} for the current planning checkpoint (safety buffer included).`,
    );
    if (nextPaycheck && safeToSpendAfterNextDeposit > 0 && safeToSpendNow <= 0) {
      warnings.push(
        `After your ${toIsoDate(nextPaycheck.date)} paycheck (~${formatDollars(nextPaycheck.usableAmount)}), estimated flexible headroom is ${formatDollars(safeToSpendAfterNextDeposit)} if nothing else changes.`,
      );
    }
  }
  if (overdueNow.length > 0) {
    warnings.push(`${overdueNow.length} overdue obligation(s) rolling forward - handle before next paycheck.`);
  }

  const nextBestActions: string[] = [];
  if (whatMustBePaidNow.length > 0) {
    nextBestActions.push(
      `Pay ${whatMustBePaidNow.length} critical item(s) before ${nextPayDate ? toIsoDate(nextPayDate) : "next paycheck"}.`,
    );
  }
  if (snapshot.accounts.length === 0) {
    nextBestActions.push("Connect a bank account to sync live balances.");
  }
  if (safeToSpendNow > 0) {
    nextBestActions.push(`Safe to spend today: ${formatDollars(safeToSpendNow)}.`);
  }

  const nextPaycheckNeed: PlannerNextPaycheckNeed = (() => {
    if (!nextPaycheck) {
      return {
        nextExpectedDate: null,
        payerLabel: null,
        minimumToSurvive: 0,
        targetToStayOnPlan: 0,
        idealToAccelerate: 0,
        warning: null,
        coverageSummary: "No upcoming paychecks detected.",
      };
    }
    const windowEnd = paychecks[1]?.date ?? addDays(nextPaycheck.date, 14);
    const essentials = essentialsBetween(snapshot, nextPaycheck.date, windowEnd);
    const hardDue = obligations
      .filter((o) =>
        o.isHardDue &&
        o.dueDate.getTime() >= nextPaycheck.date.getTime() &&
        o.dueDate.getTime() < windowEnd.getTime()
      )
      .reduce((s, o) => s + o.amount, 0);
    const survival = money(essentials + overdueTotal);
    const onPlan = money(essentials + hardDue);
    return {
      nextExpectedDate: toIsoDate(nextPaycheck.date),
      payerLabel: nextPaycheck.payerLabel,
      minimumToSurvive: survival,
      targetToStayOnPlan: onPlan,
      idealToAccelerate: money(onPlan * 1.2),
      warning: nextPaycheck.usableAmount < onPlan
        ? `Forecast paycheck (${formatDollars(nextPaycheck.usableAmount)}) is below on-plan target (${formatDollars(onPlan)}).`
        : null,
      coverageSummary:
        `${formatDollars(nextPaycheck.usableAmount)} expected; ${formatDollars(onPlan)} needed to stay on plan.`,
    };
  })();

  const goalProgress: PlannerGoalProgress[] = snapshot.goals
    .filter((g) => g.isActive !== false)
    .map((g) => {
      const target = Math.max(g.targetAmount, 0.01);
      const current = Math.max(0, g.currentAmount);
      const remaining = Math.max(0, money(g.targetAmount - current));
      const ratio = Math.min(1, money(current / target));
      return {
        goalId: g.id,
        label: g.name,
        currentAmount: money(current),
        projectedAmount: money(current),
        targetAmount: money(g.targetAmount),
        remainingAmount: remaining,
        progressRatio: ratio,
      };
    });

  const nonPaydayObligations: PlannerNonPaydayObligation[] = obligations.map((o) => ({
    obligationId: o.id,
    sourceId: o.sourceId,
    label: o.label,
    sourceType: o.sourceType,
    date: toIsoDate(o.dueDate),
    originalDueDate: toIsoDate(o.dueDate),
    effectiveDueDate: toIsoDate(o.dueDate),
    amount: o.amount,
    remainingAmount: o.amount,
    status: o.dueDate.getTime() < today.getTime() ? "OVERDUE" : "PLANNED",
    daysOverdue: o.dueDate.getTime() < today.getTime() ? daysBetween(o.dueDate, today) : 0,
  }));

  const catchUpAnalytics: PlannerCatchUpAnalytics[] = snapshot.debts.slice(0, 5).map((d) => ({
    sourceId: d.id,
    label: d.name,
    projectedCatchUpDate: null,
    daysUntilCatchUp: null,
    impactIfExtraMoneyAdded: d.currentBalance > 0
      ? "Adding $50/pay period shortens payoff."
      : "Debt is current.",
  }));

  /** Surplus after next deposit using that scenario's first paycheck amount (spec §10 / §13). */
  const scenarioWalletSurplus = (m: PlannerScenarioMode): number => {
    const ps = forecastPaychecks(snapshot, m, today, horizon);
    const np = ps[0];
    const eligible = money(cash + (np?.usableAmount ?? 0));
    return money(eligible - requiredCashNow - safetyFloor);
  };

  const scenarioSummaries: PlannerScenarioSummary[] =
    (["LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"] as PlannerScenarioMode[]).map((m) => {
      const surplus = scenarioWalletSurplus(m);
      return {
        label: m === "LOWEST_INCOME" ? "Low" : m === "HIGHEST_INCOME" ? "High" : "Mid",
        scenarioMode: m,
        isLiveCurrent: m === "MOST_EFFICIENT",
        feasible: surplus >= 0,
        firstDateFullyCurrent: null,
        debtFreeDate: null,
        totalBorrowingUsed: 0,
        totalRemainingOverdue: overdueTotal,
        endingFreeCash: surplus,
      };
    });

  const surLow = scenarioWalletSurplus("LOWEST_INCOME");
  const surMid = scenarioWalletSurplus("MOST_EFFICIENT");
  const surHigh = scenarioWalletSurplus("HIGHEST_INCOME");
  if (surLow < 0 && surMid >= 0) {
    warnings.push(
      `Scenario check: Low income is short ${formatDollars(Math.abs(surLow))} before the next deposit; Mid (efficient) clears the checkpoint.`,
    );
  }
  if (surMid < 0 && surHigh >= 0) {
    warnings.push(
      `Scenario check: Mid income is short ${formatDollars(Math.abs(surMid))}; High income clears the checkpoint.`,
    );
  }

  const suggestedEssentialUse = buildSuggestedEssentialUse(
    snapshot,
    today,
    intervalDaysUntilNextIncome,
    safeToSpendNow,
  );

  let firstFailure: PlannerFirstFailure | null = null;
  if (amountShort > 0) {
    const label =
      overdueNow[0]?.label ?? dueToday[0]?.label ?? whatMustBePaidNow[0]?.label ?? "Protected obligations";
    firstFailure = {
      date: toIsoDate(today),
      obligationLabel: label,
      shortage: amountShort,
      minimumRepairHint: `Bring at least ${formatDollars(amountShort)} into checking (or reduce a bill) — then refresh the plan.`,
    };
  }

  const dashboard: PlannerDashboardOverview = {
    overdueNow,
    dueToday,
    dueBeforeNextPaycheck,
    reservesHeld,
    protectedAmount: requiredCashNow,
    safeToSpendNow,
    amountShort,
    nextBestActions,
    intervalDaysUntilNextIncome,
    nextReliableIncomeDate: nextPaycheck ? toIsoDate(nextPaycheck.date) : null,
    essentialsDueForCurrentInterval,
    hardDueBeforeNextIncome,
    crossPaycheckReserveTotal,
    requiredCashNow,
    safeToSpendAfterNextDeposit,
    suggestedEssentialUse,
  };

  return {
    currentPaycheckCard: timeline[0] ?? null,
    nextPaycheckNeed,
    timeline,
    whatMustBePaidNow,
    whatCanBeDelayed,
    nonPaydayObligations,
    debtSummary: debtItems,
    housingCurrentLeft: snapshot.housingBuckets
      .filter((b) => b.isCurrentBucket)
      .reduce((s, b) => s + Math.max(0, money(b.amountDue - b.amountPaid)), 0),
    housingArrearsLeft: snapshot.housingBuckets
      .filter((b) => !b.isCurrentBucket)
      .reduce((s, b) => s + Math.max(0, money(b.amountDue - b.amountPaid)), 0),
    dueSoon,
    dashboard,
    firstFailure,
    warnings,
    debtFreeDate: null,
    isOutOfDebt,
    selectedScenarioMode: mode,
    availableScenarioModes: ["FIXED", "LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"],
    scenarioSummaries,
    catchUpAnalytics,
    safeExtraPayoffAmount: Math.max(0, money(safeToSpendNow - safetyFloor)),
    safeToSpendNow,
    safeLiquidityNow: Math.max(0, money(cash - hardDueBeforeNextIncome)),
    protectedAmount: requiredCashNow,
    goalProgress,
    endingPlanningCash: money(cash + futureIncomeTotal - legacyProtectedTotal),
    liveOverdueRemainingTotal: overdueTotal,
    lastTrigger: "WEB_EDIT",
    lastRecalculatedAt: new Date().toISOString(),
  };
}
