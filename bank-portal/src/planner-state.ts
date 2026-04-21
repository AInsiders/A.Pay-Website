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

export function toPlannerStateRow(value: unknown): PlannerStateRow | null {
  if (!value || typeof value !== "object") return null;
  return value as PlannerStateRow;
}

export function plannerPlan(value: PlannerStateRow | null | undefined): PlannerPlan | null {
  return value?.plan ?? null;
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

export function planWarnings(plan: PlannerPlan | null | undefined): string[] {
  return plan?.warnings ?? [];
}

export function planNextActions(plan: PlannerPlan | null | undefined): string[] {
  return plan?.dashboard?.nextBestActions ?? [];
}
