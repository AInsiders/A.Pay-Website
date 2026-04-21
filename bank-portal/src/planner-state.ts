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

/** Merge camelCase dashboard with common snake_case keys from Kotlin / JSON serializers. */
function normalizeDashboard(d: PlannerDashboardOverview | undefined): PlannerDashboardOverview | undefined {
  if (!d) return undefined;
  const x = d as unknown as Record<string, unknown>;
  return {
    ...d,
    overdueNow: d.overdueNow ?? (x.overdue_now as PlannerDashboardOverview["overdueNow"]),
    dueToday: d.dueToday ?? (x.due_today as PlannerDashboardOverview["dueToday"]),
    dueBeforeNextPaycheck:
      d.dueBeforeNextPaycheck ?? (x.due_before_next_paycheck as PlannerDashboardOverview["dueBeforeNextPaycheck"]),
    reservesHeld: d.reservesHeld ?? (x.reserves_held as PlannerDashboardOverview["reservesHeld"]),
    protectedAmount: d.protectedAmount ?? numOrUndef(x.protected_amount),
    safeToSpendNow: d.safeToSpendNow ?? numOrUndef(x.safe_to_spend_now),
    amountShort: d.amountShort ?? numOrUndef(x.amount_short),
    nextBestActions: d.nextBestActions ?? strArr(x.next_best_actions),
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
  const merged: PlannerPlan = {
    ...plan,
    dashboard: normalizeDashboard(plan.dashboard),
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
