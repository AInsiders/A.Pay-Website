export type PlannerRiskLevel = "LOW" | "MEDIUM" | "HIGH" | "CRITICAL";
export type PlannerScenarioMode =
  | "FIXED"
  | "LOWEST_INCOME"
  | "MOST_EFFICIENT"
  | "HIGHEST_INCOME";

export interface PlannerDueItemRecommendation {
  sourceId?: string;
  label: string;
  amount: number;
  dueDate?: string;
  riskLevel?: PlannerRiskLevel;
  rationale?: string;
}

export interface PlannerAllocationLine {
  sourceId?: string | null;
  label: string;
  bucket?: string;
  amount: number;
  rationale?: string;
}

export interface PlannerReserveAllocationLine {
  obligationId?: string;
  sourceId?: string | null;
  label: string;
  amount: number;
  dueDate?: string;
  sourcePayDate?: string | null;
  /** BILL | DEBT | EXPENSE | RENT — for "named reserve" UI. */
  reserveKind?: string;
}

/** Per essential category: interval budget vs spend + suggested slice of safe-to-spend. */
export interface PlannerSuggestedEssentialLine {
  expenseId: string;
  label: string;
  intervalDays: number;
  dailyRate: number;
  intervalBudget: number;
  spentLookback: number;
  remainingBudget: number;
  suggestedFromSafeToSpend: number;
}

/** First point where the wallet checkpoint fails (spec §12). */
export interface PlannerFirstFailure {
  date?: string | null;
  obligationLabel?: string;
  shortage?: number;
  minimumRepairHint?: string;
}

export interface PlannerTimelinePaycheckPlan {
  date?: string;
  payerLabel?: string;
  sourceId?: string | null;
  enteredAmount?: number | null;
  forecastedAmount?: number | null;
  deductionAmount?: number;
  usableAmount?: number;
  startingCash?: number;
  allocations?: PlannerAllocationLine[];
  payNowList?: PlannerAllocationLine[];
  reserveNowList?: PlannerReserveAllocationLine[];
  amountLeftAfterAllocations?: number;
  endingAvailableCash?: number;
  endingReservedCash?: number;
}

export interface PlannerNextPaycheckNeed {
  nextExpectedDate?: string | null;
  payerLabel?: string | null;
  minimumToSurvive?: number;
  targetToStayOnPlan?: number;
  idealToAccelerate?: number;
  warning?: string | null;
  coverageSummary?: string;
}

export interface PlannerDashboardOverview {
  overdueNow?: PlannerDueItemRecommendation[];
  dueToday?: PlannerDueItemRecommendation[];
  dueBeforeNextPaycheck?: PlannerDueItemRecommendation[];
  reservesHeld?: PlannerReserveAllocationLine[];
  protectedAmount?: number;
  safeToSpendNow?: number;
  amountShort?: number;
  nextBestActions?: string[];
  /** Days from today until next reliable income (min 1). */
  intervalDaysUntilNextIncome?: number;
  /** ISO date of next paycheck / income event used for the interval. */
  nextReliableIncomeDate?: string | null;
  /** Σ daily_rate × interval_days for essentials (spec checkpoint). */
  essentialsDueForCurrentInterval?: number;
  /** Hard obligations due on or before next income (includes overdue). */
  hardDueBeforeNextIncome?: number;
  /** Sum of cross-paycheck reserve lines on the first timeline row. */
  crossPaycheckReserveTotal?: number;
  /** essentialsDue + hardBeforeNext + crossPaycheck reserves (wallet checkpoint). */
  requiredCashNow?: number;
  /** Rough headroom after next deposit: cash + next pay − required − floor (estimate). */
  safeToSpendAfterNextDeposit?: number;
  suggestedEssentialUse?: PlannerSuggestedEssentialLine[];
}

export interface PlannerNonPaydayObligation {
  obligationId?: string;
  sourceId?: string;
  label: string;
  sourceType?: string;
  date?: string;
  originalDueDate?: string;
  effectiveDueDate?: string;
  amount: number;
  remainingAmount?: number;
  status?: string;
  reserveSourceLabel?: string | null;
  daysOverdue?: number;
}

export interface PlannerScenarioSummary {
  label: string;
  scenarioMode?: PlannerScenarioMode | null;
  isLiveCurrent?: boolean;
  feasible: boolean;
  firstDateFullyCurrent?: string | null;
  debtFreeDate?: string | null;
  totalBorrowingUsed?: number;
  totalRemainingOverdue?: number;
  endingFreeCash?: number;
}

export interface PlannerDebtSummaryItem {
  label: string;
  balanceLeft: number;
}

export interface PlannerGoalProgress {
  goalId: string;
  label: string;
  currentAmount: number;
  projectedAmount: number;
  targetAmount: number;
  remainingAmount: number;
  progressRatio: number;
  currentPaycheckAllocation?: number;
  averagePaycheckAllocation?: number;
  paychecksNeeded?: number | null;
}

export interface PlannerCatchUpAnalytics {
  sourceId?: string;
  label: string;
  projectedCatchUpDate?: string | null;
  daysUntilCatchUp?: number | null;
  impactIfExtraMoneyAdded?: string;
}

export interface PlannerPlan {
  currentPaycheckCard?: PlannerTimelinePaycheckPlan | null;
  nextPaycheckNeed?: PlannerNextPaycheckNeed;
  timeline?: PlannerTimelinePaycheckPlan[];
  whatMustBePaidNow?: PlannerDueItemRecommendation[];
  whatCanBeDelayed?: PlannerDueItemRecommendation[];
  nonPaydayObligations?: PlannerNonPaydayObligation[];
  debtSummary?: PlannerDebtSummaryItem[];
  housingCurrentLeft?: number;
  housingArrearsLeft?: number;
  dueSoon?: PlannerDueItemRecommendation[];
  dashboard?: PlannerDashboardOverview;
  /** Structured feasibility failure (shortage at checkpoint). */
  firstFailure?: PlannerFirstFailure | null;
  warnings?: string[];
  debtFreeDate?: string | null;
  isOutOfDebt?: boolean;
  selectedScenarioMode?: PlannerScenarioMode;
  availableScenarioModes?: PlannerScenarioMode[];
  scenarioSummaries?: PlannerScenarioSummary[];
  catchUpAnalytics?: PlannerCatchUpAnalytics[];
  safeExtraPayoffAmount?: number;
  safeToSpendNow?: number;
  safeLiquidityNow?: number;
  protectedAmount?: number;
  goalProgress?: PlannerGoalProgress[];
  endingPlanningCash?: number;
  liveOverdueRemainingTotal?: number;
  lastTrigger?: string;
  lastRecalculatedAt?: string | null;
}

export interface PlannerStateRow {
  id?: number;
  snapshot?: unknown | null;
  plan?: PlannerPlan | null;
  created_at?: string | null;
  updated_at?: string | null;
  source_platform?: string | null;
  source_app_version?: string | null;
  source_updated_at?: string | null;
  planner_schema_version?: string | null;
  planner_engine_version?: string | null;
}

function parseJsonField<T>(raw: unknown): T | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
  if (typeof raw === "object") return raw as T;
  return null;
}

function numOrUndef(v: unknown): number | undefined {
  if (typeof v === "number" && !Number.isNaN(v)) return v;
  if (typeof v === "string" && /^-?\d/.test(v.trim())) return Number(v);
  return undefined;
}

function strArr(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out = v.filter((x): x is string => typeof x === "string");
  return out.length ? out : undefined;
}

function normalizeReserveLine(raw: unknown): PlannerReserveAllocationLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const amount = numOrUndef(r.amount) ?? 0;
  return {
    obligationId: (r.obligationId ?? r.obligation_id) as string | undefined,
    sourceId: (r.sourceId ?? r.source_id) as string | null | undefined,
    label: String(r.label ?? ""),
    amount,
    dueDate: (r.dueDate ?? r.due_date) as string | undefined,
    sourcePayDate: (r.sourcePayDate ?? r.source_pay_date) as string | null | undefined,
    reserveKind: (r.reserveKind ?? r.reserve_kind) as string | undefined,
  };
}

function normalizeReserveLineList(v: unknown): PlannerReserveAllocationLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PlannerReserveAllocationLine[] = [];
  for (const item of v) {
    const n = normalizeReserveLine(item);
    if (n) out.push(n);
  }
  return out.length ? out : undefined;
}

function normalizeSuggestedEssentialLine(raw: unknown): PlannerSuggestedEssentialLine | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const expenseId = String(r.expenseId ?? r.expense_id ?? "");
  if (!expenseId) return null;
  return {
    expenseId,
    label: String(r.label ?? ""),
    intervalDays: numOrUndef(r.intervalDays ?? r.interval_days) ?? 0,
    dailyRate: numOrUndef(r.dailyRate ?? r.daily_rate) ?? 0,
    intervalBudget: numOrUndef(r.intervalBudget ?? r.interval_budget) ?? 0,
    spentLookback: numOrUndef(r.spentLookback ?? r.spent_lookback) ?? 0,
    remainingBudget: numOrUndef(r.remainingBudget ?? r.remaining_budget) ?? 0,
    suggestedFromSafeToSpend: numOrUndef(r.suggestedFromSafeToSpend ?? r.suggested_from_safe_to_spend) ?? 0,
  };
}

function normalizeSuggestedEssentialUseList(v: unknown): PlannerSuggestedEssentialLine[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const out: PlannerSuggestedEssentialLine[] = [];
  for (const item of v) {
    const n = normalizeSuggestedEssentialLine(item);
    if (n) out.push(n);
  }
  return out.length ? out : undefined;
}

function normalizeFirstFailure(raw: unknown): PlannerFirstFailure | null {
  if (raw == null || typeof raw !== "object") return null;
  const x = raw as Record<string, unknown>;
  const obligationLabel = (x.obligationLabel ?? x.obligation_label) as string | undefined;
  const minimumRepairHint = (x.minimumRepairHint ?? x.minimum_repair_hint) as string | undefined;
  const shortage = numOrUndef(x.shortage);
  const date = (x.date as string | null | undefined) ?? null;
  if (obligationLabel == null && minimumRepairHint == null && shortage == null && date == null) return null;
  return {
    date,
    obligationLabel,
    shortage,
    minimumRepairHint,
  };
}

/** Merge camelCase dashboard with common snake_case keys from Kotlin / JSON serializers. */
function normalizeDashboard(d: PlannerDashboardOverview | undefined): PlannerDashboardOverview | undefined {
  if (!d) return undefined;
  const x = d as unknown as Record<string, unknown>;
  const reservesHeld =
    normalizeReserveLineList(d.reservesHeld) ??
    normalizeReserveLineList(x.reserves_held) ??
    (d.reservesHeld as PlannerDashboardOverview["reservesHeld"]);
  const suggestedEssentialUse =
    normalizeSuggestedEssentialUseList(d.suggestedEssentialUse) ??
    normalizeSuggestedEssentialUseList(x.suggested_essential_use) ??
    (d.suggestedEssentialUse as PlannerDashboardOverview["suggestedEssentialUse"]);
  return {
    ...d,
    overdueNow: d.overdueNow ?? (x.overdue_now as PlannerDashboardOverview["overdueNow"]),
    dueToday: d.dueToday ?? (x.due_today as PlannerDashboardOverview["dueToday"]),
    dueBeforeNextPaycheck:
      d.dueBeforeNextPaycheck ?? (x.due_before_next_paycheck as PlannerDashboardOverview["dueBeforeNextPaycheck"]),
    reservesHeld,
    protectedAmount: d.protectedAmount ?? numOrUndef(x.protected_amount),
    safeToSpendNow: d.safeToSpendNow ?? numOrUndef(x.safe_to_spend_now),
    amountShort: d.amountShort ?? numOrUndef(x.amount_short),
    nextBestActions: d.nextBestActions ?? strArr(x.next_best_actions),
    intervalDaysUntilNextIncome: d.intervalDaysUntilNextIncome ?? numOrUndef(x.interval_days_until_next_income),
    nextReliableIncomeDate: d.nextReliableIncomeDate ?? (x.next_reliable_income_date as string | null | undefined),
    essentialsDueForCurrentInterval: d.essentialsDueForCurrentInterval ?? numOrUndef(x.essentials_due_for_current_interval),
    hardDueBeforeNextIncome: d.hardDueBeforeNextIncome ?? numOrUndef(x.hard_due_before_next_income),
    crossPaycheckReserveTotal: d.crossPaycheckReserveTotal ?? numOrUndef(x.cross_paycheck_reserve_total),
    requiredCashNow: d.requiredCashNow ?? numOrUndef(x.required_cash_now),
    safeToSpendAfterNextDeposit: d.safeToSpendAfterNextDeposit ?? numOrUndef(x.safe_to_spend_after_next_deposit),
    suggestedEssentialUse,
  };
}

function normalizeNextPaycheck(
  n: PlannerNextPaycheckNeed | undefined,
): PlannerNextPaycheckNeed | undefined {
  if (!n) return undefined;
  const x = n as unknown as Record<string, unknown>;
  return {
    ...n,
    nextExpectedDate: n.nextExpectedDate ?? (x.next_expected_date as string | null | undefined),
    payerLabel: n.payerLabel ?? (x.payer_label as string | null | undefined),
    minimumToSurvive: n.minimumToSurvive ?? numOrUndef(x.minimum_to_survive),
    targetToStayOnPlan: n.targetToStayOnPlan ?? numOrUndef(x.target_to_stay_on_plan),
    idealToAccelerate: n.idealToAccelerate ?? numOrUndef(x.ideal_to_accelerate),
    warning: n.warning ?? (x.warning as string | null | undefined),
    coverageSummary: n.coverageSummary ?? (x.coverage_summary as string | undefined),
  };
}

/**
 * Accepts canonical camelCase `PlannerPlan` or common snake_case variants from shared-engine JSON.
 */
export function normalizePlannerPlan(plan: PlannerPlan | null | undefined): PlannerPlan | null {
  if (!plan) return null;
  const p = plan as unknown as Record<string, unknown>;
  const firstFailure = normalizeFirstFailure(plan.firstFailure ?? p.first_failure);
  const merged: PlannerPlan = {
    ...plan,
    dashboard: normalizeDashboard(plan.dashboard),
    firstFailure,
    nextPaycheckNeed: normalizeNextPaycheck(plan.nextPaycheckNeed),
    safeToSpendNow: plan.safeToSpendNow ?? numOrUndef(p.safe_to_spend_now),
    protectedAmount: plan.protectedAmount ?? numOrUndef(p.protected_amount),
    safeLiquidityNow: plan.safeLiquidityNow ?? numOrUndef(p.safe_liquidity_now),
    endingPlanningCash: plan.endingPlanningCash ?? numOrUndef(p.ending_planning_cash),
    safeExtraPayoffAmount: plan.safeExtraPayoffAmount ?? numOrUndef(p.safe_extra_payoff_amount),
    liveOverdueRemainingTotal: plan.liveOverdueRemainingTotal ?? numOrUndef(p.live_overdue_remaining_total),
    lastRecalculatedAt: plan.lastRecalculatedAt ?? (p.last_recalculated_at as string | null | undefined),
    lastTrigger: plan.lastTrigger ?? (p.last_trigger as string | undefined),
    debtFreeDate: plan.debtFreeDate ?? (p.debt_free_date as string | null | undefined),
    warnings: plan.warnings ?? strArr(p.warnings),
    whatMustBePaidNow: plan.whatMustBePaidNow ?? (p.what_must_be_paid_now as PlannerPlan["whatMustBePaidNow"]),
    whatCanBeDelayed: plan.whatCanBeDelayed ?? (p.what_can_be_delayed as PlannerPlan["whatCanBeDelayed"]),
    dueSoon: plan.dueSoon ?? (p.due_soon as PlannerPlan["dueSoon"]),
    nonPaydayObligations: plan.nonPaydayObligations ?? (p.non_payday_obligations as PlannerPlan["nonPaydayObligations"]),
    debtSummary: plan.debtSummary ?? (p.debt_summary as PlannerPlan["debtSummary"]),
    scenarioSummaries: plan.scenarioSummaries ?? (p.scenario_summaries as PlannerPlan["scenarioSummaries"]),
    catchUpAnalytics: plan.catchUpAnalytics ?? (p.catch_up_analytics as PlannerPlan["catchUpAnalytics"]),
    goalProgress: plan.goalProgress ?? (p.goal_progress as PlannerPlan["goalProgress"]),
    timeline: plan.timeline ?? (p.timeline as PlannerPlan["timeline"]),
    currentPaycheckCard: plan.currentPaycheckCard ?? (p.current_paycheck_card as PlannerPlan["currentPaycheckCard"]),
  };
  return merged;
}

export function toPlannerStateRow(value: unknown): PlannerStateRow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const planParsed = parseJsonField<PlannerPlan>(row.plan);
  const snapshotParsed = parseJsonField<unknown>(row.snapshot);
  const base = value as PlannerStateRow;
  return {
    ...base,
    plan: planParsed ?? (typeof row.plan === "object" && row.plan ? (row.plan as PlannerPlan) : base.plan ?? null),
    snapshot: snapshotParsed ?? row.snapshot ?? base.snapshot,
  };
}

export function plannerPlan(value: PlannerStateRow | null | undefined): PlannerPlan | null {
  return normalizePlannerPlan(value?.plan ?? null);
}

export function planSafeToSpend(plan: PlannerPlan | null | undefined): number {
  return plan?.dashboard?.safeToSpendNow ?? plan?.safeToSpendNow ?? 0;
}

export function planProtectedAmount(plan: PlannerPlan | null | undefined): number {
  return plan?.dashboard?.protectedAmount ?? plan?.protectedAmount ?? 0;
}

export function planAmountShort(plan: PlannerPlan | null | undefined): number {
  return plan?.dashboard?.amountShort ?? 0;
}

export function planSafeLiquidity(plan: PlannerPlan | null | undefined): number {
  return plan?.safeLiquidityNow ?? 0;
}

export function planWarnings(plan: PlannerPlan | null | undefined): string[] {
  return plan?.warnings ?? [];
}

export function planNextActions(plan: PlannerPlan | null | undefined): string[] {
  return plan?.dashboard?.nextBestActions ?? [];
}
