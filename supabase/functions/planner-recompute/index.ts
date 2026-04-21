// Self-contained planner recompute Edge Function.
// Intentionally bundles CORS/helpers/types/engine/loader inline so the Supabase
// bundler does not need to resolve sibling `_shared/**` modules.
//
// The canonical TS sources also live under ../_shared/planner/* so the browser
// can import the same engine for optimistic client-side preview if needed.

import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

// =============================================================
// CORS helpers
// =============================================================

const ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-supabase-authorization, accept, prefer";

function parseExtraOrigins(): string[] {
  const raw = Deno.env.get("ALLOW_APP_ORIGINS")?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

function corsHeadersForRequest(req: Request | undefined): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };
  const origin = req?.headers.get("Origin")?.trim() ?? "";
  if (!origin) return { ...base, "Access-Control-Allow-Origin": "*" };
  const extra = parseExtraOrigins();
  const githubPages = /^https:\/\/[a-z0-9.-]+\.github\.io$/i.test(origin);
  const localhost =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin);
  const allowed = githubPages || localhost || extra.includes(origin);
  if (allowed) return { ...base, "Access-Control-Allow-Origin": origin, Vary: "Origin" };
  return { ...base, "Access-Control-Allow-Origin": "*" };
}

function preflightResponse(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeadersForRequest(req) });
}

function jsonResponse(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersForRequest(req), "Content-Type": "application/json" },
  });
}

function supabaseUserClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authorization = req.headers.get("Authorization") ?? "";
  return createClient(url, anon, { global: { headers: { Authorization: authorization } } });
}

function supabaseServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key);
}

// =============================================================
// Types (inline - keep in sync with bank-portal/src/planner-engine-shared types)
// =============================================================

type PlannerRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
type PlannerScenarioMode = "FIXED" | "LOWEST_INCOME" | "MOST_EFFICIENT" | "HIGHEST_INCOME";

interface RecurringRule {
  type:
    | "ONE_TIME" | "DAILY" | "WEEKLY" | "BIWEEKLY" | "SEMI_MONTHLY"
    | "MONTHLY" | "QUARTERLY" | "YEARLY" | "EVERY_X_DAYS" | "CUSTOM_INTERVAL";
  anchorDate?: string;
  intervalDays?: number;
  dayOfMonth?: number;
  semiMonthlyDays?: number[];
}

interface MonetaryRange { minimum?: number; target?: number; maximum?: number }
interface SnapshotAccount { id: string; name: string; type: string; currentBalance: number; availableBalance: number; includeInPlanning: boolean; protectedFromPayoff?: boolean; tellerEnrollmentId?: string | null; tellerLinkedAccountId?: string | null }
interface SnapshotIncomeSource { id: string; name: string; payerLabel?: string; recurringRule: RecurringRule; amountRange: MonetaryRange; forecastAmountMode?: "FIXED" | "RANGE"; inputMode?: "GROSS" | "NET" | "USABLE"; nextExpectedPayDate?: string | null; isActive?: boolean; isManualOnly?: boolean; deductionRuleIds?: string[] }
interface SnapshotPaycheck { id: string; incomeSourceId?: string | null; payerLabel?: string; date: string; amount: number; deposited?: boolean; accountId?: string | null }
interface SnapshotBill { id: string; name: string; amountDue: number; minimumDue: number; currentAmountDue: number; recurringRule?: RecurringRule; category?: string; isEssential?: boolean; status?: "UPCOMING" | "DUE" | "PAID" | "OVERDUE" | "PARTIAL"; paymentPolicy?: "HARD_DUE" | "FLEXIBLE_DUE" }
interface SnapshotBillPayment { id: string; billId: string; amount: number; paymentDate: string }
interface SnapshotDebt { id: string; name: string; lender?: string; type?: string; currentBalance: number; minimumDue: number; requiredDueDate?: string | null; arrearsAmount?: number; bankAccountId?: string | null }
interface SnapshotDebtTransaction { id: string; debtId: string; type: "PAYMENT" | "BORROW" | "REPAYMENT"; amount: number; eventDate: string }
interface SnapshotRecurringExpense { id: string; name: string; amount: number; recurringRule: RecurringRule; isEssential?: boolean; isVariable?: boolean; allocationMode?: "EVENLY" | "MANUAL" | "ON_DUE_DATE"; oneTimeDate?: string | null; categoryLabel?: string }
interface SnapshotExpenseSpend { id: string; expenseId: string; amount: number; spendDate: string }
interface SnapshotHousingConfig { currentMonthlyRent: number; minimumAcceptablePayment: number; rentDueDay: number; arrangement?: string }
interface SnapshotHousingBucket { id: string; label: string; monthKey: string; amountDue: number; amountPaid: number; dueDate?: string | null; isCurrentBucket?: boolean }
interface SnapshotHousingPayment { id: string; bucketId: string; amount: number; paymentDate: string }
interface SnapshotGoal { id: string; name: string; targetAmount: number; currentAmount: number; isActive?: boolean }
interface SnapshotCashAdjustment { id: string; accountId?: string | null; type: string; amount: number; adjustmentDate: string }
interface PlannerSettings { targetBuffer?: number; selectedScenarioMode?: PlannerScenarioMode; planningStyle?: string; horizonDays?: number }
interface PlannerSnapshot {
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
  settings: PlannerSettings;
}

interface PlannerDueItemRecommendation { sourceId?: string; label: string; amount: number; dueDate?: string; riskLevel?: PlannerRiskLevel; rationale?: string }
interface PlannerAllocationLine { sourceId?: string | null; label: string; bucket?: string; amount: number; rationale?: string }
interface PlannerReserveAllocationLine { obligationId?: string; sourceId?: string | null; label: string; amount: number; dueDate?: string; sourcePayDate?: string | null }
interface PlannerTimelinePaycheckPlan {
  date?: string; payerLabel?: string; sourceId?: string | null;
  enteredAmount?: number | null; forecastedAmount?: number | null; deductionAmount?: number;
  usableAmount?: number; startingCash?: number;
  allocations?: PlannerAllocationLine[]; payNowList?: PlannerAllocationLine[]; reserveNowList?: PlannerReserveAllocationLine[];
  amountLeftAfterAllocations?: number; endingAvailableCash?: number; endingReservedCash?: number;
}
interface PlannerNextPaycheckNeed {
  nextExpectedDate?: string | null; payerLabel?: string | null;
  minimumToSurvive?: number; targetToStayOnPlan?: number; idealToAccelerate?: number;
  warning?: string | null; coverageSummary?: string;
}
interface PlannerDashboardOverview {
  overdueNow?: PlannerDueItemRecommendation[]; dueToday?: PlannerDueItemRecommendation[];
  dueBeforeNextPaycheck?: PlannerDueItemRecommendation[]; reservesHeld?: PlannerReserveAllocationLine[];
  protectedAmount?: number; safeToSpendNow?: number; amountShort?: number; nextBestActions?: string[];
}
interface PlannerNonPaydayObligation {
  obligationId?: string; sourceId?: string; label: string; sourceType?: string;
  date?: string; originalDueDate?: string; effectiveDueDate?: string;
  amount: number; remainingAmount?: number; status?: string; daysOverdue?: number;
}
interface PlannerScenarioSummary {
  label: string; scenarioMode?: PlannerScenarioMode | null; isLiveCurrent?: boolean;
  feasible: boolean; firstDateFullyCurrent?: string | null; debtFreeDate?: string | null;
  totalBorrowingUsed?: number; totalRemainingOverdue?: number; endingFreeCash?: number;
}
interface PlannerDebtSummaryItem { label: string; balanceLeft: number }
interface PlannerGoalProgress {
  goalId: string; label: string; currentAmount: number; projectedAmount: number;
  targetAmount: number; remainingAmount: number; progressRatio: number;
  paychecksNeeded?: number | null;
}
interface PlannerCatchUpAnalytics {
  sourceId?: string; label: string; projectedCatchUpDate?: string | null;
  daysUntilCatchUp?: number | null; impactIfExtraMoneyAdded?: string;
}
interface PlannerPlan {
  currentPaycheckCard?: PlannerTimelinePaycheckPlan | null;
  nextPaycheckNeed?: PlannerNextPaycheckNeed;
  timeline?: PlannerTimelinePaycheckPlan[];
  whatMustBePaidNow?: PlannerDueItemRecommendation[];
  whatCanBeDelayed?: PlannerDueItemRecommendation[];
  nonPaydayObligations?: PlannerNonPaydayObligation[];
  debtSummary?: PlannerDebtSummaryItem[];
  housingCurrentLeft?: number; housingArrearsLeft?: number;
  dueSoon?: PlannerDueItemRecommendation[];
  dashboard?: PlannerDashboardOverview;
  warnings?: string[];
  debtFreeDate?: string | null;
  isOutOfDebt?: boolean;
  selectedScenarioMode?: PlannerScenarioMode;
  availableScenarioModes?: PlannerScenarioMode[];
  scenarioSummaries?: PlannerScenarioSummary[];
  catchUpAnalytics?: PlannerCatchUpAnalytics[];
  safeExtraPayoffAmount?: number; safeToSpendNow?: number; safeLiquidityNow?: number;
  protectedAmount?: number; goalProgress?: PlannerGoalProgress[];
  endingPlanningCash?: number; liveOverdueRemainingTotal?: number;
  lastTrigger?: string; lastRecalculatedAt?: string | null;
}

const PLANNER_SCHEMA_VERSION = "billpayer-shared-v1";
const PLANNER_ENGINE_VERSION = "ts-engine-0.1.0";
const DEFAULT_HORIZON_DAYS = 120;
const DUE_SOON_WINDOW_DAYS = 14;

// =============================================================
// Date helpers
// =============================================================

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
      let cur = anchor; let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur); cur = addDays(cur, 1);
      }
      break;
    }
    case "WEEKLY": {
      let cur = anchor; let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur); cur = addDays(cur, 7);
      }
      break;
    }
    case "BIWEEKLY": {
      let cur = anchor; let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur); cur = addDays(cur, 14);
      }
      break;
    }
    case "EVERY_X_DAYS": {
      const step = Math.max(1, rule.intervalDays ?? 7);
      let cur = anchor; let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur); cur = addDays(cur, step);
      }
      break;
    }
    case "CUSTOM_INTERVAL": {
      const step = Math.max(1, rule.intervalDays ?? 30);
      let cur = anchor; let i = 0;
      while (i++ < maxIterations && startOfDay(cur).getTime() <= endBoundary.getTime()) {
        push(cur); cur = addDays(cur, step);
      }
      break;
    }
    case "SEMI_MONTHLY": {
      const days = rule.semiMonthlyDays && rule.semiMonthlyDays.length >= 1
        ? rule.semiMonthlyDays : [1, 15];
      let y = startBoundary.getUTCFullYear();
      let mo = startBoundary.getUTCMonth();
      let i = 0;
      while (i++ < maxIterations) {
        let any = false;
        for (const dr of days) {
          const day = Math.min(28, Math.max(1, dr));
          const c = new Date(Date.UTC(y, mo, day));
          if (c.getTime() < startBoundary.getTime()) continue;
          if (c.getTime() > endBoundary.getTime()) return out;
          push(c); any = true;
        }
        mo++; if (mo > 11) { mo = 0; y++; }
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
        if (c.getTime() >= startBoundary.getTime() && c.getTime() <= endBoundary.getTime()) {
          push(c);
        }
        mo++; if (mo > 11) { mo = 0; y++; }
        if (y > endBoundary.getUTCFullYear() + 2) break;
      }
      break;
    }
    case "QUARTERLY": {
      const pd = rule.dayOfMonth ?? anchor.getUTCDate();
      let cur = startOfDay(anchor); let i = 0;
      while (i++ < maxIterations && cur.getTime() <= endBoundary.getTime()) {
        if (cur.getTime() >= startBoundary.getTime()) push(cur);
        cur = new Date(Date.UTC(cur.getUTCFullYear(), cur.getUTCMonth() + 3, pd));
      }
      break;
    }
    case "YEARLY": {
      const am = anchor.getUTCMonth(); const ad = anchor.getUTCDate();
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

// =============================================================
// Engine
// =============================================================

function money(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function formatDollars(n: number): string {
  const abs = Math.abs(n);
  const base = abs.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return (n < 0 ? "-$" : "$") + base;
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
    case "LOWEST_INCOME": return min;
    case "HIGHEST_INCOME": return max;
    default: return target;
  }
}

interface ForecastPaycheck {
  id: string; incomeSourceId: string | null; payerLabel: string;
  date: Date; usableAmount: number; forecastedAmount: number;
  enteredAmount: number | null; deductionAmount: number;
}

interface ForecastObligation {
  id: string; sourceId: string;
  sourceType: "BILL" | "DEBT" | "EXPENSE" | "RENT" | "BORROW_REPAYMENT";
  label: string; dueDate: Date; amount: number; minimumDue: number;
  isEssential: boolean; isHardDue: boolean;
}

function forecastPaychecks(snapshot: PlannerSnapshot, mode: PlannerScenarioMode, today: Date, horizon: Date): ForecastPaycheck[] {
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
        deductionAmount: 0,
      });
    }
  }
  for (const p of snapshot.paychecks) {
    const pDate = parseIsoDate(p.date);
    if (!pDate || pDate.getTime() < today.getTime() || p.incomeSourceId) continue;
    out.push({
      id: p.id, incomeSourceId: null,
      payerLabel: p.payerLabel || "Paycheck", date: pDate,
      usableAmount: money(p.amount), forecastedAmount: money(p.amount),
      enteredAmount: money(p.amount), deductionAmount: 0,
    });
  }
  return out.sort((a, b) => a.date.getTime() - b.date.getTime());
}

function paidSumByBill(snapshot: PlannerSnapshot, billId: string): number {
  return snapshot.billPayments.filter((p) => p.billId === billId).reduce((s, p) => s + (p.amount || 0), 0);
}

function paidSumByDebt(snapshot: PlannerSnapshot, debtId: string): number {
  return snapshot.debtTransactions.filter((t) => t.debtId === debtId && t.type === "PAYMENT").reduce((s, t) => s + (t.amount || 0), 0);
}

function forecastBillObligations(snapshot: PlannerSnapshot, today: Date, horizon: Date): ForecastObligation[] {
  const out: ForecastObligation[] = [];
  for (const bill of snapshot.bills) {
    const paid = paidSumByBill(snapshot, bill.id);
    const isHardDue = (bill.paymentPolicy ?? "HARD_DUE") === "HARD_DUE";
    if (bill.currentAmountDue > 0 && bill.status !== "PAID") {
      const due = parseIsoDate(bill.recurringRule?.anchorDate ?? null) ?? today;
      out.push({
        id: `${bill.id}|${toIsoDate(due)}`, sourceId: bill.id, sourceType: "BILL",
        label: bill.name, dueDate: due, amount: money(bill.currentAmountDue),
        minimumDue: money(bill.minimumDue), isEssential: bill.isEssential ?? false, isHardDue,
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
          id, sourceId: bill.id, sourceType: "BILL", label: bill.name, dueDate: d,
          amount, minimumDue: money(bill.minimumDue),
          isEssential: bill.isEssential ?? false, isHardDue,
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
      id: `${debt.id}|${toIsoDate(due)}`, sourceId: debt.id, sourceType: "DEBT",
      label: debt.name, dueDate: due, amount: money(debt.minimumDue),
      minimumDue: money(debt.minimumDue), isEssential: false, isHardDue: true,
    });
  }
  return out;
}

function forecastHousingObligations(snapshot: PlannerSnapshot, today: Date): ForecastObligation[] {
  const out: ForecastObligation[] = [];
  for (const bucket of snapshot.housingBuckets) {
    const remaining = Math.max(0, money(bucket.amountDue - bucket.amountPaid));
    if (remaining <= 0) continue;
    const due = parseIsoDate(bucket.dueDate ?? null) ?? today;
    out.push({
      id: `rent|${bucket.id}`, sourceId: bucket.id, sourceType: "RENT",
      label: bucket.label || "Housing", dueDate: due, amount: remaining,
      minimumDue: remaining, isEssential: true, isHardDue: true,
    });
  }
  return out;
}

function essentialDailyRate(expense: SnapshotRecurringExpense): number {
  const rule = expense.recurringRule;
  const amount = expense.amount || 0;
  switch (rule?.type) {
    case "DAILY": return amount;
    case "WEEKLY": return amount / 7;
    case "BIWEEKLY": return amount / 14;
    case "MONTHLY": return amount / 30;
    case "SEMI_MONTHLY": return amount / 15;
    case "QUARTERLY": return amount / 91;
    case "YEARLY": return amount / 365;
    case "EVERY_X_DAYS":
    case "CUSTOM_INTERVAL":
      return amount / Math.max(1, rule.intervalDays ?? 30);
    default: return 0;
  }
}

function totalCashAvailable(snapshot: PlannerSnapshot): number {
  return snapshot.accounts.filter((a) => a.includeInPlanning).reduce((s, a) => s + a.availableBalance, 0);
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

function dueRec(o: ForecastObligation, today: Date): PlannerDueItemRecommendation {
  const days = daysBetween(today, o.dueDate);
  return {
    sourceId: o.sourceId, label: o.label, amount: o.amount, dueDate: toIsoDate(o.dueDate),
    riskLevel: riskForObligation(days, o.isHardDue),
    rationale: days < 0 ? `${Math.abs(days)} day(s) overdue` : days === 0 ? "Due today" : `Due in ${days} day(s)`,
  };
}

function buildTimeline(snapshot: PlannerSnapshot, paychecks: ForecastPaycheck[], obligations: ForecastObligation[]): PlannerTimelinePaycheckPlan[] {
  const timeline: PlannerTimelinePaycheckPlan[] = [];
  let cash = totalCashAvailable(snapshot);
  for (let i = 0; i < paychecks.length; i++) {
    const p = paychecks[i];
    const next = paychecks[i + 1];
    const intervalEnd = next ? next.date : addDays(p.date, 30);
    const essentialsNeeded = essentialsBetween(snapshot, p.date, intervalEnd);
    const dueInWindow = obligations.filter((o) => o.dueDate.getTime() >= p.date.getTime() && o.dueDate.getTime() < intervalEnd.getTime());
    const payNowList: PlannerAllocationLine[] = dueInWindow.filter((o) => o.isHardDue).map((o) => ({
      sourceId: o.sourceId, label: o.label,
      bucket: o.sourceType === "DEBT" ? "DEBT_MINIMUM" : o.sourceType === "RENT" ? "HOUSING_CURRENT" : "BILL",
      amount: o.amount, rationale: `Due ${toIsoDate(o.dueDate)} — covered from ${p.payerLabel}`,
    }));
    const reserveNowList: PlannerReserveAllocationLine[] = obligations
      .filter((o) => o.dueDate.getTime() >= intervalEnd.getTime())
      .slice(0, 5)
      .map((o) => ({ obligationId: o.id, sourceId: o.sourceId, label: o.label, amount: o.amount, dueDate: toIsoDate(o.dueDate), sourcePayDate: toIsoDate(p.date) }));
    const allocations: PlannerAllocationLine[] = [];
    if (essentialsNeeded > 0) {
      allocations.push({ label: "Essentials", bucket: "ESSENTIALS", amount: essentialsNeeded, rationale: "Daily living costs until next paycheck." });
    }
    allocations.push(...payNowList);
    const usable = p.usableAmount;
    const startingCash = cash;
    const allocated = allocations.reduce((s, a) => s + a.amount, 0);
    const amountLeft = money(Math.max(0, usable - allocated));
    cash = money(cash + amountLeft);
    timeline.push({
      date: toIsoDate(p.date), payerLabel: p.payerLabel, sourceId: p.incomeSourceId,
      enteredAmount: p.enteredAmount, forecastedAmount: p.forecastedAmount,
      deductionAmount: p.deductionAmount, usableAmount: usable, startingCash,
      allocations, payNowList, reserveNowList,
      amountLeftAfterAllocations: amountLeft, endingAvailableCash: cash,
      endingReservedCash: reserveNowList.reduce((s, r) => s + r.amount, 0),
    });
  }
  return timeline;
}

function buildPlannerPlan(snapshot: PlannerSnapshot): PlannerPlan {
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
  const hardDueTotal = obligations.filter((o) => o.isHardDue && o.dueDate.getTime() <= horizon.getTime()).reduce((s, o) => s + o.amount, 0);
  const overdueTotal = obligations.filter((o) => o.dueDate.getTime() < today.getTime()).reduce((s, o) => s + o.amount, 0);
  const protectedTotal = money(essentialsThroughHorizon + hardDueTotal + overdueTotal);

  const safeToSpendNow = Math.max(0, money(cash + futureIncomeTotal - protectedTotal - safetyFloor));
  const amountShort = Math.max(0, money(protectedTotal + safetyFloor - (cash + futureIncomeTotal)));

  const nextPaycheck = paychecks[0] ?? null;
  const nextPayDate = nextPaycheck?.date ?? null;

  const overdueNow = obligations.filter((o) => o.dueDate.getTime() < today.getTime()).map((o) => dueRec(o, today));
  const dueToday = obligations.filter((o) => o.dueDate.getTime() === today.getTime()).map((o) => dueRec(o, today));
  const dueBeforeNextPaycheck = nextPayDate
    ? obligations.filter((o) => o.dueDate.getTime() > today.getTime() && o.dueDate.getTime() <= nextPayDate.getTime()).map((o) => dueRec(o, today))
    : [];
  const dueSoonCutoff = addDays(today, DUE_SOON_WINDOW_DAYS);
  const dueSoon = obligations.filter((o) => o.dueDate.getTime() > today.getTime() && o.dueDate.getTime() <= dueSoonCutoff.getTime()).map((o) => dueRec(o, today));

  const whatMustBePaidNow = [...overdueNow, ...dueToday, ...dueBeforeNextPaycheck.filter((d) => d.riskLevel === "CRITICAL" || d.riskLevel === "HIGH")];
  const whatCanBeDelayed = obligations.filter((o) => !o.isHardDue && o.dueDate.getTime() > today.getTime()).slice(0, 10).map((o) => dueRec(o, today));

  const timeline = buildTimeline(snapshot, paychecks, obligations);
  const reservesHeld = timeline.flatMap((row) => row.reserveNowList ?? []).slice(0, 10);

  const accountsById = new Map(snapshot.accounts.map((a) => [a.id, a]));
  const debtItems: PlannerDebtSummaryItem[] = [];
  let debtTotal = 0;
  for (const d of snapshot.debts) {
    const paid = paidSumByDebt(snapshot, d.id);
    // When a debt is linked to a bank account (e.g. a credit card), let the live
    // balance drive the debt so users do not update it manually anywhere.
    const linkedId = d.bankAccountId?.trim();
    const linked = linkedId ? accountsById.get(linkedId) : undefined;
    const sourceBalance = linked ? Math.abs(linked.currentBalance) : d.currentBalance;
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
  if (snapshot.incomeSources.length === 0) warnings.push("No income sources yet. Add one under Accounts -> Income so the planner can forecast.");
  if (snapshot.accounts.filter((a) => a.includeInPlanning).length === 0) warnings.push("No bank accounts are included in planning. Link a bank or toggle an account on.");
  if (amountShort > 0) warnings.push(`Short by ${formatDollars(amountShort)} through next ${horizonDays} days at current plan.`);
  if (overdueNow.length > 0) warnings.push(`${overdueNow.length} overdue obligation(s) rolling forward — handle before next paycheck.`);

  const nextBestActions: string[] = [];
  if (whatMustBePaidNow.length > 0) nextBestActions.push(`Pay ${whatMustBePaidNow.length} critical item(s) before ${nextPayDate ? toIsoDate(nextPayDate) : "next paycheck"}.`);
  if (snapshot.accounts.length === 0) nextBestActions.push("Connect a bank account to sync live balances.");
  if (safeToSpendNow > 0) nextBestActions.push(`Safe to spend today: ${formatDollars(safeToSpendNow)}.`);

  const nextPaycheckNeed: PlannerNextPaycheckNeed = (() => {
    if (!nextPaycheck) return { nextExpectedDate: null, payerLabel: null, minimumToSurvive: 0, targetToStayOnPlan: 0, idealToAccelerate: 0, warning: null, coverageSummary: "No upcoming paychecks detected." };
    const windowEnd = paychecks[1]?.date ?? addDays(nextPaycheck.date, 14);
    const essentials = essentialsBetween(snapshot, nextPaycheck.date, windowEnd);
    const hardDue = obligations.filter((o) => o.isHardDue && o.dueDate.getTime() >= nextPaycheck.date.getTime() && o.dueDate.getTime() < windowEnd.getTime()).reduce((s, o) => s + o.amount, 0);
    const survival = money(essentials + overdueTotal);
    const onPlan = money(essentials + hardDue);
    return {
      nextExpectedDate: toIsoDate(nextPaycheck.date),
      payerLabel: nextPaycheck.payerLabel,
      minimumToSurvive: survival,
      targetToStayOnPlan: onPlan,
      idealToAccelerate: money(onPlan * 1.2),
      warning: nextPaycheck.usableAmount < onPlan ? `Forecast paycheck (${formatDollars(nextPaycheck.usableAmount)}) is below on-plan target (${formatDollars(onPlan)}).` : null,
      coverageSummary: `${formatDollars(nextPaycheck.usableAmount)} expected; ${formatDollars(onPlan)} needed to stay on plan.`,
    };
  })();

  const goalProgress: PlannerGoalProgress[] = snapshot.goals.filter((g) => g.isActive !== false).map((g) => {
    const target = Math.max(g.targetAmount, 0.01);
    const current = Math.max(0, g.currentAmount);
    const remaining = Math.max(0, money(g.targetAmount - current));
    const ratio = Math.min(1, money(current / target));
    return { goalId: g.id, label: g.name, currentAmount: money(current), projectedAmount: money(current), targetAmount: money(g.targetAmount), remainingAmount: remaining, progressRatio: ratio };
  });

  const nonPaydayObligations: PlannerNonPaydayObligation[] = obligations.map((o) => ({
    obligationId: o.id, sourceId: o.sourceId, label: o.label, sourceType: o.sourceType,
    date: toIsoDate(o.dueDate), originalDueDate: toIsoDate(o.dueDate), effectiveDueDate: toIsoDate(o.dueDate),
    amount: o.amount, remainingAmount: o.amount,
    status: o.dueDate.getTime() < today.getTime() ? "OVERDUE" : "PLANNED",
    daysOverdue: o.dueDate.getTime() < today.getTime() ? daysBetween(o.dueDate, today) : 0,
  }));

  const catchUpAnalytics: PlannerCatchUpAnalytics[] = snapshot.debts.slice(0, 5).map((d) => ({
    sourceId: d.id, label: d.name, projectedCatchUpDate: null, daysUntilCatchUp: null,
    impactIfExtraMoneyAdded: d.currentBalance > 0 ? "Adding $50/pay period shortens payoff." : "Debt is current.",
  }));

  const scenarioSummaries: PlannerScenarioSummary[] = (["LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"] as PlannerScenarioMode[]).map((m) => {
    const ps = forecastPaychecks(snapshot, m, today, addDays(today, 180));
    const ti = ps.reduce((s, p) => s + p.usableAmount, 0);
    return {
      label: m === "LOWEST_INCOME" ? "Low" : m === "HIGHEST_INCOME" ? "High" : "Mid",
      scenarioMode: m, isLiveCurrent: m === "MOST_EFFICIENT",
      feasible: ti > 0, firstDateFullyCurrent: null, debtFreeDate: null,
      totalBorrowingUsed: 0, totalRemainingOverdue: 0, endingFreeCash: money(ti),
    };
  });

  return {
    currentPaycheckCard: timeline[0] ?? null,
    nextPaycheckNeed, timeline, whatMustBePaidNow, whatCanBeDelayed,
    nonPaydayObligations,
    debtSummary: debtItems,
    housingCurrentLeft: snapshot.housingBuckets.filter((b) => b.isCurrentBucket).reduce((s, b) => s + Math.max(0, money(b.amountDue - b.amountPaid)), 0),
    housingArrearsLeft: snapshot.housingBuckets.filter((b) => !b.isCurrentBucket).reduce((s, b) => s + Math.max(0, money(b.amountDue - b.amountPaid)), 0),
    dueSoon,
    dashboard: { overdueNow, dueToday, dueBeforeNextPaycheck, reservesHeld, protectedAmount: protectedTotal, safeToSpendNow, amountShort, nextBestActions },
    warnings, debtFreeDate: null, isOutOfDebt,
    selectedScenarioMode: mode,
    availableScenarioModes: ["FIXED", "LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"],
    scenarioSummaries, catchUpAnalytics,
    safeExtraPayoffAmount: Math.max(0, money(safeToSpendNow - safetyFloor)),
    safeToSpendNow,
    safeLiquidityNow: Math.max(0, money(cash - hardDueTotal - overdueTotal)),
    protectedAmount: protectedTotal,
    goalProgress,
    endingPlanningCash: money(cash + futureIncomeTotal - protectedTotal),
    liveOverdueRemainingTotal: overdueTotal,
    lastTrigger: "WEB_EDIT",
    lastRecalculatedAt: new Date().toISOString(),
  };
}

// =============================================================
// Loader (Supabase -> snapshot)
// =============================================================

function numOr(v: unknown, f: number): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : f;
}

function dateOr(v: unknown): string | null {
  if (!v || typeof v !== "string") return null;
  const t = v.trim();
  if (!t) return null;
  return t.slice(0, 10);
}

async function loadPlannerSnapshot(client: SupabaseClient, userId: string): Promise<PlannerSnapshot> {
  const filter = (t: string) => client.from(t).select("*").eq("user_id", userId);
  const [
    accounts, incomeSources, paychecks, bills, billPayments,
    debts, debtTransactions, expenses, expenseSpends,
    housingConfig, housingBuckets, housingPayments,
    goals, cashAdjustments, settings,
  ] = await Promise.all([
    filter("bank_accounts"), filter("income_sources"), filter("paychecks"),
    filter("bills"), filter("bill_payments"), filter("debts"), filter("debt_transactions"),
    filter("recurring_expenses"), filter("expense_spends"),
    filter("housing_config"), filter("housing_buckets"), filter("housing_payments"),
    filter("goals"), filter("cash_adjustments"), filter("planner_settings"),
  ]);

  const first = (r: { data: unknown[] | null }): Record<string, unknown> | null =>
    (r.data && r.data.length > 0 ? r.data[0] as Record<string, unknown> : null);

  const settingsRow = first(settings);
  const rawSettings = (settingsRow?.settings ?? {}) as Record<string, unknown>;
  const hcRow = first(housingConfig);

  return {
    today: new Date().toISOString().slice(0, 10),
    accounts: (accounts.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), name: String(r.name ?? ""), type: String(r.type ?? "Checking"),
        currentBalance: numOr(r.current_balance, 0), availableBalance: numOr(r.available_balance, 0),
        includeInPlanning: (r.include_in_planning ?? true) === true,
        protectedFromPayoff: r.protected_from_payoff === true,
        tellerEnrollmentId: r.teller_enrollment_id ? String(r.teller_enrollment_id) : null,
        tellerLinkedAccountId: r.teller_linked_account_id ? String(r.teller_linked_account_id) : null,
      };
    }),
    incomeSources: (incomeSources.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), name: String(r.name ?? ""), payerLabel: String(r.payer_label ?? ""),
        recurringRule: (r.recurring_rule ?? {}) as RecurringRule,
        amountRange: (r.amount_range ?? {}) as MonetaryRange,
        forecastAmountMode: (r.forecast_amount_mode as "FIXED" | "RANGE") ?? "FIXED",
        inputMode: (r.input_mode as "GROSS" | "NET" | "USABLE") ?? "USABLE",
        nextExpectedPayDate: dateOr(r.next_expected_pay_date),
        isActive: r.is_active !== false,
        isManualOnly: r.is_manual_only === true,
        deductionRuleIds: Array.isArray(r.deduction_rule_ids) ? (r.deduction_rule_ids as string[]) : [],
      };
    }),
    paychecks: (paychecks.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), incomeSourceId: r.income_source_id ? String(r.income_source_id) : null,
        payerLabel: String(r.payer_label ?? ""), date: String(dateOr(r.date) ?? ""),
        amount: numOr(r.amount, 0), deposited: r.deposited === true,
        accountId: r.account_id ? String(r.account_id) : null,
      };
    }),
    bills: (bills.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), name: String(r.name ?? ""),
        amountDue: numOr(r.amount_due, 0), minimumDue: numOr(r.minimum_due, 0),
        currentAmountDue: numOr(r.current_amount_due, 0),
        recurringRule: (r.recurring_rule ?? {}) as RecurringRule,
        category: r.category ? String(r.category) : "",
        isEssential: r.is_essential === true,
        status: (r.status as "UPCOMING" | "DUE" | "PAID" | "OVERDUE" | "PARTIAL") ?? "UPCOMING",
        paymentPolicy: (r.payment_policy as "HARD_DUE" | "FLEXIBLE_DUE") ?? "HARD_DUE",
      };
    }),
    billPayments: (billPayments.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r.id ?? ""), billId: String(r.bill_id ?? ""), amount: numOr(r.amount, 0), paymentDate: String(dateOr(r.payment_date) ?? "") };
    }),
    debts: (debts.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), name: String(r.name ?? ""), lender: String(r.lender ?? ""),
        type: String(r.type ?? "INSTALLMENT"),
        currentBalance: numOr(r.current_balance, 0), minimumDue: numOr(r.minimum_due, 0),
        requiredDueDate: dateOr(r.required_due_date),
        arrearsAmount: numOr(r.arrears_amount, 0),
        bankAccountId: r.bank_account_id ? String(r.bank_account_id) : null,
      };
    }),
    debtTransactions: (debtTransactions.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), debtId: String(r.debt_id ?? ""),
        type: (r.type as "PAYMENT" | "BORROW" | "REPAYMENT") ?? "PAYMENT",
        amount: numOr(r.amount, 0), eventDate: String(dateOr(r.event_date) ?? ""),
      };
    }),
    expenses: (expenses.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), name: String(r.name ?? ""), amount: numOr(r.amount, 0),
        recurringRule: (r.recurring_rule ?? {}) as RecurringRule,
        isEssential: r.is_essential !== false, isVariable: r.is_variable === true,
        allocationMode: (r.allocation_mode as "EVENLY" | "MANUAL" | "ON_DUE_DATE") ?? "EVENLY",
        oneTimeDate: dateOr(r.one_time_date),
        categoryLabel: r.category_label ? String(r.category_label) : "",
      };
    }),
    expenseSpends: (expenseSpends.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r.id ?? ""), expenseId: String(r.expense_id ?? ""), amount: numOr(r.amount, 0), spendDate: String(dateOr(r.spend_date) ?? "") };
    }),
    housingConfig: hcRow ? {
      currentMonthlyRent: numOr(hcRow.current_monthly_rent, 0),
      minimumAcceptablePayment: numOr(hcRow.minimum_acceptable_payment, 0),
      rentDueDay: numOr(hcRow.rent_due_day, 1),
      arrangement: String(hcRow.arrangement ?? "RENT_MONTH_TO_MONTH"),
    } : null,
    housingBuckets: (housingBuckets.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), label: String(r.label ?? ""), monthKey: String(r.month_key ?? ""),
        amountDue: numOr(r.amount_due, 0), amountPaid: numOr(r.amount_paid, 0),
        dueDate: dateOr(r.due_date), isCurrentBucket: r.is_current_bucket === true,
      };
    }),
    housingPayments: (housingPayments.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r.id ?? ""), bucketId: String(r.bucket_id ?? ""), amount: numOr(r.amount, 0), paymentDate: String(dateOr(r.payment_date) ?? "") };
    }),
    goals: (goals.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return { id: String(r.id ?? ""), name: String(r.name ?? ""), targetAmount: numOr(r.target_amount, 0), currentAmount: numOr(r.current_amount, 0), isActive: r.is_active !== false };
    }),
    cashAdjustments: (cashAdjustments.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""), accountId: r.account_id ? String(r.account_id) : null,
        type: String(r.type ?? "CASH_IN"), amount: numOr(r.amount, 0),
        adjustmentDate: String(dateOr(r.adjustment_date) ?? ""),
      };
    }),
    settings: {
      targetBuffer: numOr(rawSettings.targetBuffer, 0),
      selectedScenarioMode: (rawSettings.selectedScenarioMode as PlannerScenarioMode) ?? "FIXED",
      planningStyle: (rawSettings.planningStyle as string) ?? "BALANCED",
      horizonDays: numOr(rawSettings.horizonDays, 120),
    },
  };
}

// =============================================================
// Handler
// =============================================================

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (req.method !== "POST" && req.method !== "GET") {
    return jsonResponse({ error: "Method not allowed" }, 405, req);
  }
  const userClient = supabaseUserClient(req);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) return jsonResponse({ error: "Unauthorized" }, 401, req);
  const userId = userData.user.id;
  const admin = supabaseServiceClient();

  try {
    const snapshot = await loadPlannerSnapshot(admin, userId);
    const plan = buildPlannerPlan(snapshot);
    const nowIso = new Date().toISOString();
    const { error: upsertErr } = await admin.from("planner_snapshots").upsert({
      user_id: userId, snapshot, plan,
      source_platform: "web", source_app_version: "recompute",
      source_updated_at: nowIso,
      planner_schema_version: PLANNER_SCHEMA_VERSION,
      planner_engine_version: PLANNER_ENGINE_VERSION,
      updated_at: nowIso,
    }, { onConflict: "user_id" });
    if (upsertErr) {
      return jsonResponse({ error: `Failed to persist plan: ${upsertErr.message}` }, 500, req);
    }
    return jsonResponse({
      plan,
      planner_schema_version: PLANNER_SCHEMA_VERSION,
      planner_engine_version: PLANNER_ENGINE_VERSION,
      recomputed_at: nowIso,
    }, 200, req);
  } catch (e) {
    return jsonResponse({ error: e instanceof Error ? e.message : String(e) }, 500, req);
  }
});
