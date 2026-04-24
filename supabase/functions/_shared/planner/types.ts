// Planner contract shapes shared between Edge Functions and the website.
// Mirrors the canonical BillPayer shared-engine types but kept minimal + JSON-native
// so it can round-trip cleanly through `planner_snapshots.plan`.

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
  obligationId?: string;
  sourceId?: string | null;
  sourceType?: string;
  label: string;
  bucket?: string;
  amount: number;
  dueDate?: string;
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

// Snapshot shape used as the engine input. Produced by loading the user's
// normalized rows out of Supabase. Compact version of the Kotlin PlannerSnapshot.

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
  customDates?: string[];
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
  deductionRuleIds?: string[];
}

export interface SnapshotPaycheck {
  id: string;
  incomeSourceId?: string | null;
  payerLabel?: string;
  date: string;
  amount: number;
  amountMode?: "GROSS" | "NET" | "USABLE";
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
  graceDays?: number;
  lateTriggerDays?: number;
}

export interface SnapshotBillPayment {
  id: string;
  billId: string;
  amount: number;
  paymentDate: string;
  paycheckId?: string | null;
  appliedDueDate?: string | null;
}

export interface SnapshotDebt {
  id: string;
  name: string;
  lender?: string;
  type?: string;
  currentBalance: number;
  minimumDue: number;
  requiredDueDate?: string | null;
  interestRate?: number | null;
  arrearsAmount?: number;
  payoffPriority?: number;
  reborrowAllowed?: boolean;
}

export interface SnapshotDebtTransaction {
  id: string;
  debtId: string;
  type: "PAYMENT" | "BORROW" | "REPAYMENT";
  amount: number;
  eventDate: string;
  paycheckId?: string | null;
  feeAmount?: number;
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
  paycheckId?: string | null;
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
  paycheckId?: string | null;
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
  type: "CASH_IN" | "CASH_OUT" | "REIMBURSEMENT" | "REFUND" | "CORRECTION";
  amount: number;
  adjustmentDate: string;
}

export interface PlannerSettings {
  targetBuffer?: number;
  selectedScenarioMode?: PlannerScenarioMode;
  planningStyle?: "SURVIVAL" | "BALANCED" | "ACCELERATED";
  horizonDays?: number;
}

export interface PlannerSnapshot {
  today: string; // yyyy-mm-dd
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
