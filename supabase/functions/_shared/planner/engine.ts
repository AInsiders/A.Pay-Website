// Deterministic cashflow planner engine.
// TypeScript implementation of the spec described in the project's cashflow
// algorithm document. Pure functions, no environment dependencies.
//
// Inputs: PlannerSnapshot (normalized rows from Supabase or mobile state).
// Outputs: PlannerPlan (safe-to-spend, protected load, timeline, dashboard, etc.).

import type {
  PlannerAllocationLine,
  PlannerCatchUpAnalytics,
  PlannerDashboardOverview,
  PlannerDebtSummaryItem,
  PlannerDueItemRecommendation,
  PlannerGoalProgress,
  PlannerNextPaycheckNeed,
  PlannerNonPaydayObligation,
  PlannerPlan,
  PlannerReserveAllocationLine,
  PlannerRiskLevel,
  PlannerScenarioMode,
  PlannerScenarioSummary,
  PlannerSnapshot,
  PlannerTimelinePaycheckPlan,
  SnapshotIncomeSource,
  SnapshotRecurringExpense,
} from "./types.ts";
import {
  addDays,
  daysBetween,
  expandRecurringDates,
  parseIsoDate,
  startOfDay,
  toIsoDate,
} from "./recurring.ts";

export const PLANNER_SCHEMA_VERSION = "billpayer-shared-v1";
export const PLANNER_ENGINE_VERSION = "ts-engine-0.1.0";

const DEFAULT_HORIZON_DAYS = 120;
const DUE_SOON_WINDOW_DAYS = 14;
const SAFETY_FLOOR_DEFAULT = 0;

interface ForecastPaycheck {
  id: string; // deterministic id: "<incomeSourceId>|<isoDate>"
  incomeSourceId: string | null;
  payerLabel: string;
  date: Date;
  usableAmount: number;
  forecastedAmount: number;
  enteredAmount: number | null;
  deductionAmount: number;
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

function money(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

function riskForObligation(daysUntilDue: number, isHardDue: boolean): PlannerRiskLevel {
  if (daysUntilDue < 0) return "CRITICAL";
  if (daysUntilDue <= 2) return isHardDue ? "CRITICAL" : "HIGH";
  if (daysUntilDue <= 7) return "HIGH";
  if (daysUntilDue <= 14) return "MEDIUM";
  return "LOW";
}

function scenarioAmount(
  range: SnapshotIncomeSource["amountRange"],
  mode: PlannerScenarioMode,
): number {
  const min = range.minimum ?? 0;
  const target = range.target ?? min;
  const max = range.maximum ?? target;
  switch (mode) {
    case "LOWEST_INCOME":
      return min;
    case "HIGHEST_INCOME":
      return max;
    case "MOST_EFFICIENT":
    case "FIXED":
    default:
      return target;
  }
}

function inferEnteredAmount(
  snapshot: PlannerSnapshot,
  incomeSourceId: string | null,
  date: Date,
): number | null {
  const match = snapshot.paychecks.find((p) => {
    if (incomeSourceId && p.incomeSourceId && p.incomeSourceId !== incomeSourceId) return false;
    const pDate = parseIsoDate(p.date);
    if (!pDate) return false;
    return startOfDay(pDate).getTime() === startOfDay(date).getTime();
  });
  return match ? money(match.amount) : null;
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
      const entered = inferEnteredAmount(snapshot, source.id, date);
      out.push({
        id: `${source.id}|${toIsoDate(date)}`,
        incomeSourceId: source.id,
        payerLabel: source.payerLabel || source.name,
        date,
        usableAmount: entered ?? amt,
        forecastedAmount: amt,
        enteredAmount: entered,
        deductionAmount: 0, // Deduction rules simplified for TS port; Kotlin covers full math.
      });
    }
  }
  // Also include standalone paychecks that don't belong to an income source (manual entries).
  for (const p of snapshot.paychecks) {
    const pDate = parseIsoDate(p.date);
    if (!pDate) continue;
    if (pDate.getTime() < today.getTime()) continue;
    if (p.incomeSourceId) continue;
    out.push({
      id: p.id,
      incomeSourceId: null,
      payerLabel: p.payerLabel || "Paycheck",
      date: pDate,
      usableAmount: money(p.amount),
      forecastedAmount: money(p.amount),
      enteredAmount: money(p.amount),
      deductionAmount: 0,
    });
  }
  out.sort((a, b) => a.date.getTime() - b.date.getTime());
  return out;
}

function paidSumByBill(snapshot: PlannerSnapshot, billId: string): number {
  return snapshot.billPayments
    .filter((p) => p.billId === billId)
    .reduce((sum, p) => sum + (p.amount || 0), 0);
}

function paidSumByDebt(snapshot: PlannerSnapshot, debtId: string): number {
  return snapshot.debtTransactions
    .filter((t) => t.debtId === debtId && t.type === "PAYMENT")
    .reduce((sum, t) => sum + (t.amount || 0), 0);
}

function forecastBillObligations(
  snapshot: PlannerSnapshot,
  today: Date,
  horizon: Date,
): ForecastObligation[] {
  const out: ForecastObligation[] = [];
  for (const bill of snapshot.bills) {
    const paid = paidSumByBill(snapshot, bill.id);
    const isHardDue = (bill.paymentPolicy ?? "HARD_DUE") === "HARD_DUE";
    // If the bill has an explicit currentAmountDue > 0 and status implies a live due cycle, emit a
    // concrete due obligation first. Then expand forward for future cycles.
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
        // Don't double-emit the current cycle if already paid.
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

function forecastDebtObligations(
  snapshot: PlannerSnapshot,
  today: Date,
  horizon: Date,
): ForecastObligation[] {
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

function forecastHousingObligations(
  snapshot: PlannerSnapshot,
  today: Date,
): ForecastObligation[] {
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
    case "ONE_TIME":
    default:
      return 0;
  }
}

function totalCashAvailable(snapshot: PlannerSnapshot): number {
  return snapshot.accounts
    .filter((a) => a.includeInPlanning)
    .reduce((sum, a) => sum + a.availableBalance, 0);
}

function essentialsBetween(
  snapshot: PlannerSnapshot,
  from: Date,
  to: Date,
): number {
  if (to.getTime() <= from.getTime()) return 0;
  const days = daysBetween(from, to);
  let total = 0;
  for (const expense of snapshot.expenses) {
    if (!expense.isEssential) continue;
    total += essentialDailyRate(expense) * days;
  }
  return money(total);
}

function pickDueBeforeNext(
  obligations: ForecastObligation[],
  from: Date,
  to: Date,
): ForecastObligation[] {
  return obligations.filter((o) =>
    o.dueDate.getTime() >= from.getTime() && o.dueDate.getTime() < to.getTime()
  );
}

/** Safe-to-spend per spec: max(0, cash + future usable income - protected obligations - safety floor). */
function computeSafeToSpend(params: {
  cash: number;
  futureIncomeTotal: number;
  protectedTotal: number;
  safetyFloor: number;
}): number {
  const { cash, futureIncomeTotal, protectedTotal, safetyFloor } = params;
  return Math.max(0, money(cash + futureIncomeTotal - protectedTotal - safetyFloor));
}

function buildTimeline(
  snapshot: PlannerSnapshot,
  paychecks: ForecastPaycheck[],
  obligations: ForecastObligation[],
  today: Date,
): PlannerTimelinePaycheckPlan[] {
  const timeline: PlannerTimelinePaycheckPlan[] = [];
  let cash = totalCashAvailable(snapshot);

  for (let i = 0; i < paychecks.length; i++) {
    const p = paychecks[i];
    const next = paychecks[i + 1];
    const intervalEnd = next ? next.date : addDays(p.date, 30);
    const essentialsNeeded = essentialsBetween(snapshot, p.date, intervalEnd);
    const dueInWindow = pickDueBeforeNext(obligations, p.date, intervalEnd);
    const payNowList: PlannerAllocationLine[] = dueInWindow
      .filter((o) => o.isHardDue)
      .map((o) => ({
        sourceId: o.sourceId,
        label: o.label,
        bucket: o.sourceType === "DEBT" ? "DEBT_MINIMUM" : o.sourceType === "RENT" ? "HOUSING_CURRENT" : "BILL",
        amount: o.amount,
        rationale: `Due ${toIsoDate(o.dueDate)} — covered from ${p.payerLabel}`,
      }));
    const reserveNowList: PlannerReserveAllocationLine[] = obligations
      .filter((o) => o.dueDate.getTime() >= intervalEnd.getTime())
      .slice(0, 5) // near-future reserve preview
      .map((o) => ({
        obligationId: o.id,
        sourceId: o.sourceId,
        label: o.label,
        amount: o.amount,
        dueDate: toIsoDate(o.dueDate),
        sourcePayDate: toIsoDate(p.date),
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
    const opening = money(startingCash + usable);
    cash = money(Math.max(0, opening - allocated));
    const amountLeft = cash;

    timeline.push({
      date: toIsoDate(p.date),
      payerLabel: p.payerLabel,
      sourceId: p.incomeSourceId,
      enteredAmount: p.enteredAmount,
      forecastedAmount: p.forecastedAmount,
      deductionAmount: p.deductionAmount,
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

function dueRecommendationFromObligation(
  o: ForecastObligation,
  today: Date,
): PlannerDueItemRecommendation {
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

function nonPaydayObligationsFrom(
  obligations: ForecastObligation[],
  today: Date,
): PlannerNonPaydayObligation[] {
  return obligations.map<PlannerNonPaydayObligation>((o) => ({
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
}

function buildDebtSummary(
  snapshot: PlannerSnapshot,
): { items: PlannerDebtSummaryItem[]; totalBalance: number; isOutOfDebt: boolean } {
  const items: PlannerDebtSummaryItem[] = [];
  let total = 0;
  for (const debt of snapshot.debts) {
    const paid = paidSumByDebt(snapshot, debt.id);
    const balanceLeft = Math.max(0, money(debt.currentBalance - paid));
    total += balanceLeft;
    items.push({ label: debt.name, balanceLeft });
  }
  for (const bucket of snapshot.housingBuckets) {
    const rem = Math.max(0, money(bucket.amountDue - bucket.amountPaid));
    if (rem > 0) total += rem;
  }
  return { items, totalBalance: total, isOutOfDebt: total <= 0 };
}

function buildGoalProgress(snapshot: PlannerSnapshot): PlannerGoalProgress[] {
  return snapshot.goals
    .filter((g) => g.isActive !== false)
    .map<PlannerGoalProgress>((g) => {
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
}

function buildCatchUpAnalytics(snapshot: PlannerSnapshot): PlannerCatchUpAnalytics[] {
  return snapshot.debts.slice(0, 5).map((debt) => ({
    sourceId: debt.id,
    label: debt.name,
    projectedCatchUpDate: null,
    daysUntilCatchUp: null,
    impactIfExtraMoneyAdded: debt.currentBalance > 0
      ? "Adding $50/pay period shortens payoff; see web planner for full scenario math."
      : "Debt is current.",
  }));
}

function buildScenarioSummaries(snapshot: PlannerSnapshot): PlannerScenarioSummary[] {
  const modes: PlannerScenarioMode[] = ["LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"];
  const today = parseIsoDate(snapshot.today) ?? new Date();
  return modes.map((mode) => {
    const paychecks = forecastPaychecks(snapshot, mode, today, addDays(today, 180));
    const totalIncome = paychecks.reduce((s, p) => s + p.usableAmount, 0);
    return {
      label:
        mode === "LOWEST_INCOME"
          ? "Low"
          : mode === "HIGHEST_INCOME"
            ? "High"
            : "Mid",
      scenarioMode: mode,
      isLiveCurrent: mode === "MOST_EFFICIENT",
      feasible: totalIncome > 0,
      firstDateFullyCurrent: null,
      debtFreeDate: null,
      totalBorrowingUsed: 0,
      totalRemainingOverdue: 0,
      endingFreeCash: money(totalIncome),
    };
  });
}

export function buildPlannerPlan(snapshot: PlannerSnapshot): PlannerPlan {
  const today = parseIsoDate(snapshot.today) ?? startOfDay(new Date());
  const horizonDays = snapshot.settings.horizonDays ?? DEFAULT_HORIZON_DAYS;
  const horizon = addDays(today, horizonDays);
  const mode: PlannerScenarioMode = snapshot.settings.selectedScenarioMode ?? "FIXED";
  const safetyFloor = snapshot.settings.targetBuffer ?? SAFETY_FLOOR_DEFAULT;

  const paychecks = forecastPaychecks(snapshot, mode, today, horizon);
  const obligations = [
    ...forecastBillObligations(snapshot, today, horizon),
    ...forecastDebtObligations(snapshot, today, horizon),
    ...forecastHousingObligations(snapshot, today),
  ].sort((a, b) => a.dueDate.getTime() - b.dueDate.getTime());

  const cash = totalCashAvailable(snapshot);
  const futureIncomeTotal = paychecks.reduce((s, p) => s + p.usableAmount, 0);

  // Protected obligations: essentials through horizon + hard due + overdue + rent + reserve.
  const essentialsThroughHorizon = essentialsBetween(snapshot, today, horizon);
  const hardDueTotal = obligations
    .filter((o) => o.isHardDue && o.dueDate.getTime() <= horizon.getTime())
    .reduce((s, o) => s + o.amount, 0);
  const overdueTotal = obligations
    .filter((o) => o.dueDate.getTime() < today.getTime())
    .reduce((s, o) => s + o.amount, 0);
  const protectedTotal = money(essentialsThroughHorizon + hardDueTotal + overdueTotal);

  const safeToSpendNow = computeSafeToSpend({
    cash,
    futureIncomeTotal,
    protectedTotal,
    safetyFloor,
  });
  const amountShort = Math.max(0, money(protectedTotal + safetyFloor - (cash + futureIncomeTotal)));

  const nextPaycheck = paychecks[0] ?? null;
  const nextPayDate = nextPaycheck?.date ?? null;
  const overdueNow = obligations
    .filter((o) => o.dueDate.getTime() < today.getTime())
    .map((o) => dueRecommendationFromObligation(o, today));
  const dueToday = obligations
    .filter((o) => o.dueDate.getTime() === today.getTime())
    .map((o) => dueRecommendationFromObligation(o, today));
  const dueBeforeNextPaycheck = nextPayDate
    ? obligations
      .filter((o) =>
        o.dueDate.getTime() > today.getTime() && o.dueDate.getTime() <= nextPayDate.getTime()
      )
      .map((o) => dueRecommendationFromObligation(o, today))
    : [];
  const dueSoonCutoff = addDays(today, DUE_SOON_WINDOW_DAYS);
  const dueSoon = obligations
    .filter((o) =>
      o.dueDate.getTime() > today.getTime() && o.dueDate.getTime() <= dueSoonCutoff.getTime()
    )
    .map((o) => dueRecommendationFromObligation(o, today));

  const whatMustBePaidNow: PlannerDueItemRecommendation[] = [
    ...overdueNow,
    ...dueToday,
    ...dueBeforeNextPaycheck.filter((d) => d.riskLevel === "CRITICAL" || d.riskLevel === "HIGH"),
  ];
  const whatCanBeDelayed: PlannerDueItemRecommendation[] = obligations
    .filter((o) => !o.isHardDue && o.dueDate.getTime() > today.getTime())
    .slice(0, 10)
    .map((o) => dueRecommendationFromObligation(o, today));

  const timeline = buildTimeline(snapshot, paychecks, obligations, today);
  const reservesHeld: PlannerReserveAllocationLine[] = timeline
    .flatMap((row) => row.reserveNowList ?? [])
    .slice(0, 10);

  const debtSummaryBundle = buildDebtSummary(snapshot);

  const warnings: string[] = [];
  if (snapshot.incomeSources.length === 0) {
    warnings.push("No income sources yet. Add one under Accounts -> Income so the planner can forecast.");
  }
  if (snapshot.accounts.filter((a) => a.includeInPlanning).length === 0) {
    warnings.push("No bank accounts are included in planning. Link a bank or toggle an account on.");
  }
  if (amountShort > 0) {
    warnings.push(
      `Short by ${formatDollars(amountShort)} through next ${horizonDays} days at current plan.`,
    );
  }
  if (overdueNow.length > 0) {
    warnings.push(
      `${overdueNow.length} overdue obligation(s) rolling forward — handle before next paycheck.`,
    );
  }

  const nextBestActions: string[] = [];
  if (whatMustBePaidNow.length > 0) {
    nextBestActions.push(`Pay ${whatMustBePaidNow.length} critical item(s) before ${nextPayDate ? toIsoDate(nextPayDate) : "next paycheck"}.`);
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
      coverageSummary: `${formatDollars(nextPaycheck.usableAmount)} expected; ${formatDollars(onPlan)} needed to stay on plan.`,
    };
  })();

  const dashboard: PlannerDashboardOverview = {
    overdueNow,
    dueToday,
    dueBeforeNextPaycheck,
    reservesHeld,
    protectedAmount: protectedTotal,
    safeToSpendNow,
    amountShort,
    nextBestActions,
  };

  const plan: PlannerPlan = {
    currentPaycheckCard: timeline[0] ?? null,
    nextPaycheckNeed,
    timeline,
    whatMustBePaidNow,
    whatCanBeDelayed,
    nonPaydayObligations: nonPaydayObligationsFrom(obligations, today),
    debtSummary: debtSummaryBundle.items,
    housingCurrentLeft: snapshot.housingBuckets
      .filter((b) => b.isCurrentBucket)
      .reduce((s, b) => s + Math.max(0, money(b.amountDue - b.amountPaid)), 0),
    housingArrearsLeft: snapshot.housingBuckets
      .filter((b) => !b.isCurrentBucket)
      .reduce((s, b) => s + Math.max(0, money(b.amountDue - b.amountPaid)), 0),
    dueSoon,
    dashboard,
    warnings,
    debtFreeDate: null,
    isOutOfDebt: debtSummaryBundle.isOutOfDebt,
    selectedScenarioMode: mode,
    availableScenarioModes: ["FIXED", "LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"],
    scenarioSummaries: buildScenarioSummaries(snapshot),
    catchUpAnalytics: buildCatchUpAnalytics(snapshot),
    safeExtraPayoffAmount: Math.max(0, money(safeToSpendNow - safetyFloor)),
    safeToSpendNow,
    safeLiquidityNow: Math.max(0, money(cash - hardDueTotal - overdueTotal)),
    protectedAmount: protectedTotal,
    goalProgress: buildGoalProgress(snapshot),
    endingPlanningCash: money(cash + futureIncomeTotal - protectedTotal),
    liveOverdueRemainingTotal: overdueTotal,
    lastTrigger: "WEB_EDIT",
    lastRecalculatedAt: new Date().toISOString(),
  };

  return plan;
}

function formatDollars(n: number): string {
  const abs = Math.abs(n);
  const base = abs.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });
  return (n < 0 ? "-$" : "$") + base;
}

