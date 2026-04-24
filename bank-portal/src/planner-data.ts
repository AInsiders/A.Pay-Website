// Data access layer for the website planner CRUD.
// Wraps Supabase reads/writes for the normalized planner tables and exposes
// `loadPlannerSnapshot` + `recomputeAndPersistPlan` so the UI can just do
// `await api.saveBill(bill); await api.recompute(); render();` patterns.
//
// Source-of-truth model: normalized tables are authoritative for the web UI. The Android app
// converges via the `planner_snapshots` row (pull when `updated_at` is newer). Android-only planner
// edits still need normalized upserts (or a server-side snapshot expander) to show up in this web CRUD path.

import { supabase } from "./supabase";
import type { PlannerPlan, PlannerScenarioMode } from "./planner-state";
import {
  buildPlannerPlan,
  PLANNER_ENGINE_VERSION,
  PLANNER_SCHEMA_VERSION,
  type NotificationSettingsSnapshot,
  type PlannerSnapshot,
  type RecurringRule,
  type SnapshotAccount,
  type SnapshotBill,
  type SnapshotBillPayment,
  type SnapshotCashAdjustment,
  type SnapshotCustomLabel,
  type SnapshotDebt,
  type SnapshotDebtTransaction,
  type SnapshotDeductionRule,
  type SnapshotExpenseSpend,
  type SnapshotGoal,
  type SnapshotHousingBucket,
  type SnapshotHousingConfig,
  type SnapshotHousingPayment,
  type SnapshotIncomeSource,
  type SnapshotPaycheck,
  type SnapshotPaycheckAction,
  type SnapshotRecurringExpense,
  type SnapshotUserCategory,
} from "./planner-engine-shared";

export type { PlannerSnapshot } from "./planner-engine-shared";

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function mergeById<T extends { id: string }>(canonicalRows: unknown, normalizedRows: T[]): T[] {
  if (!Array.isArray(canonicalRows) || normalizedRows.length === 0) return normalizedRows;
  const canonicalById = new Map<string, Record<string, unknown>>();
  for (const row of canonicalRows) {
    if (!isRecord(row)) continue;
    const id = row.id;
    if (typeof id === "string" && id) {
      canonicalById.set(id, row);
    }
  }
  return normalizedRows.map((row) => {
    const canonical = canonicalById.get(row.id);
    return canonical ? ({ ...canonical, ...row } as T) : row;
  });
}

function mergeObject<T extends object | null | undefined>(canonicalValue: unknown, normalizedValue: T): T {
  if (normalizedValue == null || !isRecord(normalizedValue)) return normalizedValue;
  return { ...(isRecord(canonicalValue) ? canonicalValue : {}), ...normalizedValue } as T;
}

export function mergeCanonicalPlannerSnapshot(
  canonicalSnapshot: unknown,
  normalizedSnapshot: PlannerSnapshot,
): PlannerSnapshot {
  if (!isRecord(canonicalSnapshot)) return normalizedSnapshot;
  return {
    ...canonicalSnapshot,
    ...normalizedSnapshot,
    accounts: mergeById(canonicalSnapshot.accounts, normalizedSnapshot.accounts),
    incomeSources: mergeById(canonicalSnapshot.incomeSources, normalizedSnapshot.incomeSources),
    paychecks: mergeById(canonicalSnapshot.paychecks, normalizedSnapshot.paychecks),
    paycheckActions: mergeById(canonicalSnapshot.paycheckActions, normalizedSnapshot.paycheckActions),
    bills: mergeById(canonicalSnapshot.bills, normalizedSnapshot.bills),
    billPayments: mergeById(canonicalSnapshot.billPayments, normalizedSnapshot.billPayments),
    debts: mergeById(canonicalSnapshot.debts, normalizedSnapshot.debts),
    debtTransactions: mergeById(canonicalSnapshot.debtTransactions, normalizedSnapshot.debtTransactions),
    expenses: mergeById(canonicalSnapshot.expenses, normalizedSnapshot.expenses),
    expenseSpends: mergeById(canonicalSnapshot.expenseSpends, normalizedSnapshot.expenseSpends),
    housingConfig: mergeObject(canonicalSnapshot.housingConfig, normalizedSnapshot.housingConfig),
    housingBuckets: mergeById(canonicalSnapshot.housingBuckets, normalizedSnapshot.housingBuckets),
    housingPayments: mergeById(canonicalSnapshot.housingPayments, normalizedSnapshot.housingPayments),
    goals: mergeById(canonicalSnapshot.goals, normalizedSnapshot.goals),
    cashAdjustments: mergeById(canonicalSnapshot.cashAdjustments, normalizedSnapshot.cashAdjustments),
    settings: mergeObject(canonicalSnapshot.settings, normalizedSnapshot.settings) ?? {},
    deductionRules: mergeById(canonicalSnapshot.deductionRules, normalizedSnapshot.deductionRules),
    categories: mergeById(canonicalSnapshot.categories, normalizedSnapshot.categories),
    labels: mergeById(canonicalSnapshot.labels, normalizedSnapshot.labels),
    notificationSettings: mergeObject(canonicalSnapshot.notificationSettings, normalizedSnapshot.notificationSettings) ?? {},
    exportMetadata: mergeObject(canonicalSnapshot.exportMetadata, normalizedSnapshot.exportMetadata) ?? {},
  } as PlannerSnapshot;
}

function enumOr<T extends string>(raw: unknown, allowed: readonly T[], fallback: T): T {
  if (typeof raw !== "string") return fallback;
  const t = raw.trim() as T;
  return (allowed as readonly string[]).includes(t) ? t : fallback;
}

export async function currentUserId(): Promise<string | null> {
  const { data } = await supabase.auth.getUser();
  return data.user?.id ?? null;
}

/** Loads all normalized planner rows for the user and returns a PlannerSnapshot. */
export async function loadPlannerSnapshot(userId: string): Promise<PlannerSnapshot> {
  const filter = (table: string) => supabase.from(table).select("*").eq("user_id", userId);
  const [
    accounts,
    incomeSources,
    paychecks,
    paycheckActions,
    bills,
    billPayments,
    debts,
    debtTransactions,
    expenses,
    expenseSpends,
    housingConfig,
    housingBuckets,
    housingPayments,
    goals,
    cashAdjustments,
    settings,
    deductionRules,
    userCategories,
    customLabels,
  ] = await Promise.all([
    filter("bank_accounts"),
    filter("income_sources"),
    filter("paychecks"),
    filter("paycheck_actions"),
    filter("bills"),
    filter("bill_payments"),
    filter("debts"),
    filter("debt_transactions"),
    filter("recurring_expenses"),
    filter("expense_spends"),
    filter("housing_config"),
    filter("housing_buckets"),
    filter("housing_payments"),
    filter("goals"),
    filter("cash_adjustments"),
    filter("planner_settings"),
    filter("deduction_rules"),
    filter("user_categories"),
    filter("custom_labels"),
  ]);

  const settingsRow = (settings.data?.[0] ?? null) as Record<string, unknown> | null;
  const rawSettings = (settingsRow?.settings ?? {}) as Record<string, unknown>;
  const rawNotification = (settingsRow?.notification_settings ?? {}) as Record<string, unknown>;
  const hcRow = (housingConfig.data?.[0] ?? null) as Record<string, unknown> | null;

  return {
    today: todayIso(),
    accounts: (accounts.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        type: String(r.type ?? "Checking"),
        currentBalance: numOr(r.current_balance, 0),
        availableBalance: numOr(r.available_balance, 0),
        includeInPlanning: (r.include_in_planning ?? true) === true,
        protectedFromPayoff: r.protected_from_payoff === true,
        tellerEnrollmentId: r.teller_enrollment_id ? String(r.teller_enrollment_id) : null,
        tellerLinkedAccountId: r.teller_linked_account_id ? String(r.teller_linked_account_id) : null,
      } satisfies SnapshotAccount;
    }),
    incomeSources: (incomeSources.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        payerLabel: String(r.payer_label ?? ""),
        recurringRule: (r.recurring_rule ?? {}) as RecurringRule,
        amountRange: (r.amount_range ?? {}) as SnapshotIncomeSource["amountRange"],
        forecastAmountMode: (r.forecast_amount_mode as SnapshotIncomeSource["forecastAmountMode"]) ?? "FIXED",
        inputMode: (r.input_mode as SnapshotIncomeSource["inputMode"]) ?? "USABLE",
        nextExpectedPayDate: dateOr(r.next_expected_pay_date),
        isActive: r.is_active !== false,
        isManualOnly: r.is_manual_only === true,
      } satisfies SnapshotIncomeSource;
    }),
    paychecks: (paychecks.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        incomeSourceId: r.income_source_id ? String(r.income_source_id) : null,
        payerLabel: String(r.payer_label ?? ""),
        date: String(dateOr(r.date) ?? ""),
        amount: numOr(r.amount, 0),
        deposited: r.deposited === true,
        accountId: r.account_id ? String(r.account_id) : null,
      } satisfies SnapshotPaycheck;
    }),
    paycheckActions: (paycheckActions.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        paycheckId: String(r.paycheck_id ?? ""),
        accountId: r.account_id ? String(r.account_id) : null,
        type: String(r.type ?? "BILL_GROUP"),
        sourceId: r.source_id ? String(r.source_id) : null,
        label: String(r.label ?? ""),
        amount: numOr(r.amount, 0),
        createdAt: typeof r.created_at === "string" ? r.created_at : null,
      } satisfies SnapshotPaycheckAction;
    }),
    bills: (bills.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        amountDue: numOr(r.amount_due, 0),
        minimumDue: numOr(r.minimum_due, 0),
        currentAmountDue: numOr(r.current_amount_due, 0),
        recurringRule: (r.recurring_rule ?? {}) as RecurringRule,
        category: r.category ? String(r.category) : "",
        isEssential: r.is_essential === true,
        status: (r.status as SnapshotBill["status"]) ?? "UPCOMING",
        paymentPolicy: (r.payment_policy as SnapshotBill["paymentPolicy"]) ?? "HARD_DUE",
      } satisfies SnapshotBill;
    }),
    billPayments: (billPayments.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        billId: String(r.bill_id ?? ""),
        amount: numOr(r.amount, 0),
        paymentDate: String(dateOr(r.payment_date) ?? ""),
      } satisfies SnapshotBillPayment;
    }),
    debts: (debts.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        lender: String(r.lender ?? ""),
        type: String(r.type ?? "INSTALLMENT"),
        currentBalance: numOr(r.current_balance, 0),
        minimumDue: numOr(r.minimum_due, 0),
        requiredDueDate: dateOr(r.required_due_date),
        arrearsAmount: numOr(r.arrears_amount, 0),
        bankAccountId: r.bank_account_id ? String(r.bank_account_id) : null,
      } satisfies SnapshotDebt;
    }),
    debtTransactions: (debtTransactions.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        debtId: String(r.debt_id ?? ""),
        type: (r.type as SnapshotDebtTransaction["type"]) ?? "PAYMENT",
        amount: numOr(r.amount, 0),
        eventDate: String(dateOr(r.event_date) ?? ""),
      } satisfies SnapshotDebtTransaction;
    }),
    expenses: (expenses.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        amount: numOr(r.amount, 0),
        recurringRule: (r.recurring_rule ?? {}) as RecurringRule,
        isEssential: r.is_essential !== false,
        isVariable: r.is_variable === true,
        allocationMode: (r.allocation_mode as SnapshotRecurringExpense["allocationMode"]) ?? "EVENLY",
        oneTimeDate: dateOr(r.one_time_date),
        categoryLabel: r.category_label ? String(r.category_label) : "",
      } satisfies SnapshotRecurringExpense;
    }),
    expenseSpends: (expenseSpends.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        expenseId: String(r.expense_id ?? ""),
        amount: numOr(r.amount, 0),
        spendDate: String(dateOr(r.spend_date) ?? ""),
      } satisfies SnapshotExpenseSpend;
    }),
    housingConfig: hcRow
      ? {
        currentMonthlyRent: numOr(hcRow.current_monthly_rent, 0),
        minimumAcceptablePayment: numOr(hcRow.minimum_acceptable_payment, 0),
        rentDueDay: numOr(hcRow.rent_due_day, 1),
        arrangement: String(hcRow.arrangement ?? "RENT_MONTH_TO_MONTH"),
      } satisfies SnapshotHousingConfig
      : null,
    housingBuckets: (housingBuckets.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        label: String(r.label ?? ""),
        monthKey: String(r.month_key ?? ""),
        amountDue: numOr(r.amount_due, 0),
        amountPaid: numOr(r.amount_paid, 0),
        dueDate: dateOr(r.due_date),
        isCurrentBucket: r.is_current_bucket === true,
      } satisfies SnapshotHousingBucket;
    }),
    housingPayments: (housingPayments.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        bucketId: String(r.bucket_id ?? ""),
        amount: numOr(r.amount, 0),
        paymentDate: String(dateOr(r.payment_date) ?? ""),
      } satisfies SnapshotHousingPayment;
    }),
    goals: (goals.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        targetAmount: numOr(r.target_amount, 0),
        currentAmount: numOr(r.current_amount, 0),
        isActive: r.is_active !== false,
      } satisfies SnapshotGoal;
    }),
    cashAdjustments: (cashAdjustments.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        accountId: r.account_id ? String(r.account_id) : null,
        type: String(r.type ?? "CASH_IN"),
        amount: numOr(r.amount, 0),
        adjustmentDate: String(dateOr(r.adjustment_date) ?? ""),
      } satisfies SnapshotCashAdjustment;
    }),
    settings: {
      targetBuffer: numOr(rawSettings.targetBuffer, 0),
      selectedScenarioMode: enumOr(
        rawSettings.selectedScenarioMode,
        ["FIXED", "LOWEST_INCOME", "MOST_EFFICIENT", "HIGHEST_INCOME"] as const,
        "FIXED",
      ),
      // Keep aligned with the Kotlin engine enum: SURVIVAL | BALANCED | ACCELERATED.
      planningStyle: enumOr(rawSettings.planningStyle, ["SURVIVAL", "BALANCED", "ACCELERATED"] as const, "BALANCED"),
      horizonDays: numOr(rawSettings.horizonDays, 120),
      safetyFloorCash: rawSettings.safetyFloorCash !== undefined ? numOr(rawSettings.safetyFloorCash, 0) : undefined,
      reserveNearFutureWindowDays: rawSettings.reserveNearFutureWindowDays !== undefined
        ? Math.trunc(numOr(rawSettings.reserveNearFutureWindowDays, 21))
        : undefined,
      currency: rawSettings.currency !== undefined ? String(rawSettings.currency) : undefined,
      timezone: rawSettings.timezone !== undefined ? String(rawSettings.timezone) : undefined,
      allowNegativeCash: typeof rawSettings.allowNegativeCash === "boolean" ? rawSettings.allowNegativeCash : undefined,
      sameDayIncomeBeforeSameDayBills: typeof rawSettings.sameDayIncomeBeforeSameDayBills === "boolean"
        ? rawSettings.sameDayIncomeBeforeSameDayBills
        : undefined,
      roundingMode: enumOr(
        rawSettings.roundingMode,
        ["NEAREST_CENT", "UP_TO_CENT", "DOWN_TO_CENT"] as const,
        "NEAREST_CENT",
      ),
      optimizationGoal: enumOr(
        rawSettings.optimizationGoal,
        ["STAY_CURRENT", "CATCH_UP_FAST", "PAY_DEBT_FAST", "MINIMIZE_BORROWING", "BALANCED"] as const,
        "BALANCED",
      ),
      payoffMode: enumOr(rawSettings.payoffMode, ["SNOWBALL", "AVALANCHE", "CUSTOM"] as const, "SNOWBALL"),
      housingPaymentMode: enumOr(rawSettings.housingPaymentMode, ["MINIMUM_CURRENT", "FULL_CURRENT"] as const, "MINIMUM_CURRENT"),
      housingPayoffTargetMode: enumOr(
        rawSettings.housingPayoffTargetMode,
        ["REGULAR_DEBTS_ONLY", "INCLUDE_HOUSING_ARREARS"] as const,
        "REGULAR_DEBTS_ONLY",
      ),
      priorityOrder: rawSettings.priorityOrder !== undefined ? String(rawSettings.priorityOrder) : undefined,
    },
    deductionRules: (deductionRules.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        scope: (r.scope as SnapshotDeductionRule["scope"]) ?? "GLOBAL",
        incomeSourceId: r.income_source_id ? String(r.income_source_id) : null,
        valueType: (r.value_type as SnapshotDeductionRule["valueType"]) ?? "PERCENTAGE",
        fixedAmount: numOr(r.fixed_amount, 0),
        percentage: numOr(r.percentage, 0),
        status: String(r.status ?? "MANDATORY"),
        isEnabledByDefault: r.is_enabled_by_default !== false,
        notes: String(r.notes ?? ""),
      } satisfies SnapshotDeductionRule;
    }),
    categories: (userCategories.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        name: String(r.name ?? ""),
        kind: String(r.kind ?? "GENERAL"),
        notes: String(r.notes ?? ""),
      } satisfies SnapshotUserCategory;
    }),
    labels: (customLabels.data ?? []).map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? ""),
        label: String(r.label ?? ""),
        notes: String(r.notes ?? ""),
      } satisfies SnapshotCustomLabel;
    }),
    notificationSettings: {
      id: String(rawNotification.id ?? "notification_settings"),
      paydayNotificationsEnabled: rawNotification.paydayNotificationsEnabled === true,
      recalculateRemindersEnabled: rawNotification.recalculateRemindersEnabled === true,
      paydayLeadMinutes: Math.trunc(numOr(rawNotification.paydayLeadMinutes, 60)),
      recalculateReminderHour: Math.trunc(numOr(rawNotification.recalculateReminderHour, 18)),
      recalculateReminderMinute: Math.trunc(numOr(rawNotification.recalculateReminderMinute, 0)),
    } satisfies NotificationSettingsSnapshot,
    exportMetadata: {},
  };
}

/** Runs the shared planner engine and upserts a fresh `planner_snapshots` row for the user. */
export async function recomputeAndPersistPlan(
  userId: string,
  canonicalSnapshot: unknown = null,
): Promise<{ plan: PlannerPlan; snapshot: PlannerSnapshot }> {
  const normalizedSnapshot = await loadPlannerSnapshot(userId);
  const snapshot = mergeCanonicalPlannerSnapshot(canonicalSnapshot, normalizedSnapshot);
  const plan = buildPlannerPlan(snapshot);
  const nowIso = new Date().toISOString();
  const { error } = await supabase.from("planner_snapshots").upsert({
    user_id: userId,
    snapshot,
    plan,
    source_platform: "web",
    source_app_version: "web-client-recompute",
    source_updated_at: nowIso,
    planner_schema_version: PLANNER_SCHEMA_VERSION,
    planner_engine_version: PLANNER_ENGINE_VERSION,
    updated_at: nowIso,
  }, { onConflict: "user_id" });
  if (error) throw new Error(error.message);
  return { plan, snapshot };
}

/** Generate a uuid-v4 in the browser. */
export function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) return (crypto as Crypto).randomUUID();
  // RFC4122 v4 fallback
  const bytes = new Uint8Array(16);
  (globalThis.crypto ?? { getRandomValues: () => bytes }).getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ===================== CRUD helpers =====================

function withUser<T extends object>(userId: string, row: T): T & { user_id: string } {
  return { ...row, user_id: userId };
}

export interface BillFormInput {
  id?: string;
  name: string;
  amountDue: number;
  minimumDue: number;
  currentAmountDue: number;
  category?: string;
  isEssential?: boolean;
  status?: "UPCOMING" | "DUE" | "PAID" | "OVERDUE" | "PARTIAL";
  paymentPolicy?: "HARD_DUE" | "FLEXIBLE_DUE";
  recurringRule: RecurringRule;
}

export async function saveBill(userId: string, input: BillFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("bills").upsert(withUser(userId, {
    id,
    name: input.name,
    amount_due: input.amountDue,
    minimum_due: input.minimumDue,
    current_amount_due: input.currentAmountDue,
    recurring_rule: input.recurringRule,
    category: input.category ?? "",
    is_essential: input.isEssential ?? false,
    status: input.status ?? "UPCOMING",
    payment_policy: input.paymentPolicy ?? "HARD_DUE",
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteBill(userId: string, id: string) {
  const { error } = await supabase.from("bills").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface IncomeFormInput {
  id?: string;
  name: string;
  payerLabel?: string;
  recurringRule: RecurringRule;
  amountRange: { minimum?: number; target?: number; maximum?: number };
  forecastAmountMode?: "FIXED" | "RANGE";
  nextExpectedPayDate?: string | null;
  isActive?: boolean;
}

export async function saveIncomeSource(userId: string, input: IncomeFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("income_sources").upsert(withUser(userId, {
    id,
    name: input.name,
    payer_label: input.payerLabel ?? "",
    recurring_rule: input.recurringRule,
    amount_range: input.amountRange,
    forecast_amount_mode: input.forecastAmountMode ?? "FIXED",
    input_mode: "USABLE",
    next_expected_pay_date: input.nextExpectedPayDate ?? null,
    is_active: input.isActive ?? true,
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteIncomeSource(userId: string, id: string) {
  const { error } = await supabase.from("income_sources").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface DebtFormInput {
  id?: string;
  name: string;
  lender?: string;
  type?: string;
  currentBalance: number;
  minimumDue: number;
  requiredDueDate?: string | null;
  /** When set, the debt's current balance is driven by the live `bank_accounts` balance for this id. */
  bankAccountId?: string | null;
}

export async function saveDebt(userId: string, input: DebtFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("debts").upsert(withUser(userId, {
    id,
    name: input.name,
    lender: input.lender ?? "",
    type: input.type ?? "INSTALLMENT",
    current_balance: input.currentBalance,
    minimum_due: input.minimumDue,
    required_due_date: input.requiredDueDate ?? null,
    bank_account_id: input.bankAccountId ?? null,
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteDebt(userId: string, id: string) {
  const { error } = await supabase.from("debts").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface ExpenseFormInput {
  id?: string;
  name: string;
  amount: number;
  recurringRule: RecurringRule;
  isEssential?: boolean;
  categoryLabel?: string;
}

export async function saveRecurringExpense(userId: string, input: ExpenseFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("recurring_expenses").upsert(withUser(userId, {
    id,
    name: input.name,
    amount: input.amount,
    recurring_rule: input.recurringRule,
    is_essential: input.isEssential ?? true,
    category_label: input.categoryLabel ?? "",
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteRecurringExpense(userId: string, id: string) {
  const { error } = await supabase.from("recurring_expenses").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface GoalFormInput {
  id?: string;
  name: string;
  targetAmount: number;
  currentAmount: number;
  isActive?: boolean;
}

export async function saveGoal(userId: string, input: GoalFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("goals").upsert(withUser(userId, {
    id,
    name: input.name,
    target_amount: input.targetAmount,
    current_amount: input.currentAmount,
    is_active: input.isActive ?? true,
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteGoal(userId: string, id: string) {
  const { error } = await supabase.from("goals").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface HousingConfigFormInput {
  currentMonthlyRent: number;
  minimumAcceptablePayment: number;
  rentDueDay: number;
  arrangement?: string;
}

export async function saveHousingConfig(userId: string, input: HousingConfigFormInput) {
  const { error } = await supabase.from("housing_config").upsert(withUser(userId, {
    id: "housing",
    current_monthly_rent: input.currentMonthlyRent,
    minimum_acceptable_payment: input.minimumAcceptablePayment,
    rent_due_day: input.rentDueDay,
    arrangement: input.arrangement ?? "RENT_MONTH_TO_MONTH",
  }));
  if (error) throw new Error(error.message);
}

export interface PlannerSettingsForm {
  targetBuffer?: number;
  selectedScenarioMode?: PlannerScenarioMode;
  horizonDays?: number;
  planningStyle?: string;
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

export async function savePlannerSettings(userId: string, patch: PlannerSettingsForm) {
  const { data: row, error: selErr } = await supabase.from("planner_settings").select("settings, notification_settings").eq("user_id", userId).maybeSingle();
  if (selErr) throw new Error(selErr.message);
  const prev = (row?.settings ?? {}) as Record<string, unknown>;
  const next = { ...prev, ...patch };
  const { error } = await supabase.from("planner_settings").upsert({
    user_id: userId,
    settings: next,
    notification_settings: row?.notification_settings ?? {},
  });
  if (error) throw new Error(error.message);
}

export async function saveNotificationSettings(userId: string, patch: NotificationSettingsSnapshot) {
  const { data: row, error: selErr } = await supabase.from("planner_settings").select("settings, notification_settings").eq("user_id", userId).maybeSingle();
  if (selErr) throw new Error(selErr.message);
  const prev = (row?.notification_settings ?? {}) as Record<string, unknown>;
  const next = { ...prev, ...patch };
  const { error } = await supabase.from("planner_settings").upsert({
    user_id: userId,
    settings: row?.settings ?? {},
    notification_settings: next,
  });
  if (error) throw new Error(error.message);
}

/**
 * Ensures a `planner_settings` row exists so notification prefs and planning defaults
 * persist in Supabase (empty `planner_settings` was causing “missing row” in cloud).
 */
export async function ensureDefaultPlannerSettings(userId: string): Promise<void> {
  const { data, error } = await supabase.from("planner_settings").select("user_id").eq("user_id", userId).maybeSingle();
  if (error) throw new Error(error.message);
  if (data) return;
  const { error: upErr } = await supabase.from("planner_settings").upsert({
    user_id: userId,
    settings: {
      horizonDays: 120,
      selectedScenarioMode: "FIXED",
      planningStyle: "BALANCED",
      reserveNearFutureWindowDays: 21,
    },
    notification_settings: {},
  });
  if (upErr) throw new Error(upErr.message);
}

export interface DeductionRuleFormInput {
  id?: string;
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

export async function saveDeductionRule(userId: string, input: DeductionRuleFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("deduction_rules").upsert(withUser(userId, {
    id,
    name: input.name,
    scope: input.scope ?? "GLOBAL",
    income_source_id: input.incomeSourceId ?? null,
    value_type: input.valueType ?? "PERCENTAGE",
    fixed_amount: input.fixedAmount ?? 0,
    percentage: input.percentage ?? 0,
    status: input.status ?? "MANDATORY",
    is_enabled_by_default: input.isEnabledByDefault ?? true,
    notes: input.notes ?? "",
    tags: [],
    custom_fields: [],
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteDeductionRule(userId: string, id: string) {
  const { error } = await supabase.from("deduction_rules").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface UserCategoryFormInput {
  id?: string;
  name: string;
  kind?: string;
  notes?: string;
}

export async function saveUserCategory(userId: string, input: UserCategoryFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("user_categories").upsert(withUser(userId, {
    id,
    name: input.name,
    kind: input.kind ?? "GENERAL",
    notes: input.notes ?? "",
    tags: [],
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteUserCategory(userId: string, id: string) {
  const { error } = await supabase.from("user_categories").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

export interface CustomLabelFormInput {
  id?: string;
  label: string;
  notes?: string;
}

export async function saveCustomLabel(userId: string, input: CustomLabelFormInput) {
  const id = input.id ?? newId();
  const { error } = await supabase.from("custom_labels").upsert(withUser(userId, {
    id,
    label: input.label,
    notes: input.notes ?? "",
  }));
  if (error) throw new Error(error.message);
  return id;
}

export async function deleteCustomLabel(userId: string, id: string) {
  const { error } = await supabase.from("custom_labels").delete().eq("user_id", userId).eq("id", id);
  if (error) throw new Error(error.message);
}

/** Android `BACKUP_SCHEMA_VERSION` — keep aligned for cross-platform JSON backups. */
export const WEB_BACKUP_SCHEMA_VERSION = 1;

export interface PlannerBackupPackage {
  schemaVersion: number;
  appVersion: string;
  exportedAt: string;
  snapshot: PlannerSnapshot;
}

export async function buildPlannerBackupPackage(userId: string, appVersion: string): Promise<PlannerBackupPackage> {
  const snapshot = await loadPlannerSnapshot(userId);
  return {
    schemaVersion: WEB_BACKUP_SCHEMA_VERSION,
    appVersion,
    exportedAt: new Date().toISOString(),
    snapshot,
  };
}

/** Deletes all normalized planner rows for the user (destructive). Order respects FKs. */
export async function deleteAllNormalizedPlannerData(userId: string): Promise<void> {
  const del = async (table: string) => {
    const { error } = await supabase.from(table).delete().eq("user_id", userId);
    if (error) throw new Error(`${table}: ${error.message}`);
  };
  await del("transaction_splits");
  await del("transaction_categorizations");
  await del("paycheck_actions");
  await del("bill_payments");
  await del("expense_spends");
  await del("debt_transactions");
  await del("revolving_debt_settings");
  await del("housing_payments");
  await del("bills");
  await del("debts");
  await del("recurring_expenses");
  await del("paychecks");
  await del("housing_buckets");
  await del("goals");
  await del("deduction_rules");
  await del("user_categories");
  await del("custom_labels");
  await del("cash_adjustments");
  await del("bank_transactions");
  await del("bank_accounts");
  await del("category_rules");
  await del("income_sources");
  await del("housing_config");
  const { error: snapErr } = await supabase.from("planner_snapshots").delete().eq("user_id", userId);
  if (snapErr) throw new Error(`planner_snapshots: ${snapErr.message}`);
  const { error: setErr } = await supabase.from("planner_settings").delete().eq("user_id", userId);
  if (setErr) throw new Error(`planner_settings: ${setErr.message}`);
}

async function replaceIdTableRows(userId: string, table: string, nextIds: readonly string[]): Promise<void> {
  const { data, error } = await supabase.from(table).select("id").eq("user_id", userId);
  if (error) throw new Error(`${table}: ${error.message}`);
  const keep = new Set(nextIds.filter((id) => id.trim().length > 0));
  const staleIds = (data ?? [])
    .map((row) => String((row as { id?: string }).id ?? ""))
    .filter((id) => id && !keep.has(id));
  if (staleIds.length === 0) return;
  const { error: deleteError } = await supabase.from(table).delete().eq("user_id", userId).in("id", staleIds);
  if (deleteError) throw new Error(`${table}: ${deleteError.message}`);
}

export async function replaceNormalizedPlannerFromSnapshot(userId: string, snap: PlannerSnapshot): Promise<void> {
  const paycheckActions = Array.isArray(snap.paycheckActions) ? snap.paycheckActions : [];
  const billPayments = Array.isArray(snap.billPayments) ? snap.billPayments : [];
  const expenseSpends = Array.isArray(snap.expenseSpends) ? snap.expenseSpends : [];
  const debtTransactions = Array.isArray(snap.debtTransactions) ? snap.debtTransactions : [];
  const housingPayments = Array.isArray(snap.housingPayments) ? snap.housingPayments : [];
  const paychecks = Array.isArray(snap.paychecks) ? snap.paychecks : [];
  const bills = Array.isArray(snap.bills) ? snap.bills : [];
  const debts = Array.isArray(snap.debts) ? snap.debts : [];
  const expenses = Array.isArray(snap.expenses) ? snap.expenses : [];
  const housingBuckets = Array.isArray(snap.housingBuckets) ? snap.housingBuckets : [];
  const goals = Array.isArray(snap.goals) ? snap.goals : [];
  const deductionRules = Array.isArray(snap.deductionRules) ? snap.deductionRules : [];
  const categories = Array.isArray(snap.categories) ? snap.categories : [];
  const labels = Array.isArray(snap.labels) ? snap.labels : [];
  const cashAdjustments = Array.isArray(snap.cashAdjustments) ? snap.cashAdjustments : [];
  const accounts = Array.isArray(snap.accounts) ? snap.accounts : [];
  const incomeSources = Array.isArray(snap.incomeSources) ? snap.incomeSources : [];

  await replaceIdTableRows(userId, "paycheck_actions", paycheckActions.map((row) => row.id));
  await replaceIdTableRows(userId, "bill_payments", billPayments.map((row) => row.id));
  await replaceIdTableRows(userId, "expense_spends", expenseSpends.map((row) => row.id));
  await replaceIdTableRows(userId, "debt_transactions", debtTransactions.map((row) => row.id));
  await replaceIdTableRows(userId, "housing_payments", housingPayments.map((row) => row.id));
  await replaceIdTableRows(userId, "paychecks", paychecks.map((row) => row.id));
  await replaceIdTableRows(userId, "bills", bills.map((row) => row.id));
  await replaceIdTableRows(userId, "debts", debts.map((row) => row.id));
  await replaceIdTableRows(userId, "recurring_expenses", expenses.map((row) => row.id));
  await replaceIdTableRows(userId, "housing_buckets", housingBuckets.map((row) => row.id));
  await replaceIdTableRows(userId, "goals", goals.map((row) => row.id));
  await replaceIdTableRows(userId, "deduction_rules", deductionRules.map((row) => row.id));
  await replaceIdTableRows(userId, "user_categories", categories.map((row) => row.id));
  await replaceIdTableRows(userId, "custom_labels", labels.map((row) => row.id));
  await replaceIdTableRows(userId, "cash_adjustments", cashAdjustments.map((row) => row.id));
  await replaceIdTableRows(userId, "bank_accounts", accounts.map((row) => row.id));
  await replaceIdTableRows(userId, "income_sources", incomeSources.map((row) => row.id));
  if (snap.housingConfig == null) {
    const { error } = await supabase.from("housing_config").delete().eq("user_id", userId);
    if (error) throw new Error(`housing_config: ${error.message}`);
  }
  await upsertNormalizedFromPlannerSnapshot(userId, snap);
}

/**
 * Replace all normalized data from a backup `snapshot` (after optional reset).
 * Expects camelCase snapshot keys as produced by `loadPlannerSnapshot` / Android export.
 */
export async function upsertNormalizedFromPlannerSnapshot(userId: string, snap: PlannerSnapshot): Promise<void> {
  const s = snap;
  if (s.accounts?.length) {
    const { error } = await supabase.from("bank_accounts").upsert(
      s.accounts.map((a) => withUser(userId, {
        id: a.id,
        name: a.name,
        type: a.type,
        current_balance: a.currentBalance,
        available_balance: a.availableBalance,
        include_in_planning: a.includeInPlanning !== false,
        protected_from_payoff: a.protectedFromPayoff === true,
        teller_enrollment_id: a.tellerEnrollmentId ?? null,
        teller_linked_account_id: a.tellerLinkedAccountId ?? null,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.incomeSources?.length) {
    const { error } = await supabase.from("income_sources").upsert(
      s.incomeSources.map((inc) => withUser(userId, {
        id: inc.id,
        name: inc.name,
        payer_label: inc.payerLabel ?? "",
        recurring_rule: inc.recurringRule,
        amount_range: inc.amountRange,
        forecast_amount_mode: inc.forecastAmountMode ?? "FIXED",
        input_mode: inc.inputMode ?? "USABLE",
        next_expected_pay_date: inc.nextExpectedPayDate ?? null,
        is_active: inc.isActive !== false,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.bills?.length) {
    const { error } = await supabase.from("bills").upsert(
      s.bills.map((b) => withUser(userId, {
        id: b.id,
        name: b.name,
        amount_due: b.amountDue,
        minimum_due: b.minimumDue,
        current_amount_due: b.currentAmountDue,
        recurring_rule: b.recurringRule ?? {},
        category: b.category ?? "",
        is_essential: b.isEssential === true,
        status: b.status ?? "UPCOMING",
        payment_policy: b.paymentPolicy ?? "HARD_DUE",
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.billPayments?.length) {
    const { error } = await supabase.from("bill_payments").upsert(
      s.billPayments.map((p) => withUser(userId, {
        id: p.id,
        bill_id: p.billId,
        amount: p.amount,
        payment_date: p.paymentDate,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.debts?.length) {
    const { error } = await supabase.from("debts").upsert(
      s.debts.map((d) => withUser(userId, {
        id: d.id,
        name: d.name,
        lender: d.lender ?? "",
        type: d.type ?? "INSTALLMENT",
        current_balance: d.currentBalance,
        minimum_due: d.minimumDue,
        required_due_date: d.requiredDueDate ?? null,
        arrears_amount: d.arrearsAmount ?? 0,
        bank_account_id: d.bankAccountId ?? null,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.debtTransactions?.length) {
    const { error } = await supabase.from("debt_transactions").upsert(
      s.debtTransactions.map((t) => withUser(userId, {
        id: t.id,
        debt_id: t.debtId,
        type: t.type,
        amount: t.amount,
        event_date: t.eventDate,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.expenses?.length) {
    const { error } = await supabase.from("recurring_expenses").upsert(
      s.expenses.map((e) => withUser(userId, {
        id: e.id,
        name: e.name,
        amount: e.amount,
        recurring_rule: e.recurringRule,
        is_essential: e.isEssential !== false,
        is_variable: e.isVariable === true,
        allocation_mode: e.allocationMode ?? "EVENLY",
        one_time_date: e.oneTimeDate ?? null,
        category_label: e.categoryLabel ?? "",
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.expenseSpends?.length) {
    const { error } = await supabase.from("expense_spends").upsert(
      s.expenseSpends.map((x) => withUser(userId, {
        id: x.id,
        expense_id: x.expenseId,
        amount: x.amount,
        spend_date: x.spendDate,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.housingConfig) {
    const hc = s.housingConfig;
    const { error } = await supabase.from("housing_config").upsert(withUser(userId, {
      id: "housing",
      current_monthly_rent: hc.currentMonthlyRent,
      minimum_acceptable_payment: hc.minimumAcceptablePayment,
      rent_due_day: hc.rentDueDay,
      arrangement: hc.arrangement ?? "RENT_MONTH_TO_MONTH",
    }));
    if (error) throw new Error(error.message);
  }
  if (s.housingBuckets?.length) {
    const { error } = await supabase.from("housing_buckets").upsert(
      s.housingBuckets.map((h) => withUser(userId, {
        id: h.id,
        label: h.label,
        month_key: h.monthKey,
        amount_due: h.amountDue,
        amount_paid: h.amountPaid,
        due_date: h.dueDate ?? null,
        is_current_bucket: h.isCurrentBucket === true,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.housingPayments?.length) {
    const { error } = await supabase.from("housing_payments").upsert(
      s.housingPayments.map((h) => withUser(userId, {
        id: h.id,
        bucket_id: h.bucketId,
        amount: h.amount,
        payment_date: h.paymentDate,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.goals?.length) {
    const { error } = await supabase.from("goals").upsert(
      s.goals.map((g) => withUser(userId, {
        id: g.id,
        name: g.name,
        target_amount: g.targetAmount,
        current_amount: g.currentAmount,
        is_active: g.isActive !== false,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.paychecks?.length) {
    const { error } = await supabase.from("paychecks").upsert(
      s.paychecks.map((p) => withUser(userId, {
        id: p.id,
        income_source_id: p.incomeSourceId ?? null,
        payer_label: p.payerLabel ?? "",
        date: p.date,
        amount: p.amount,
        deposited: p.deposited === true,
        account_id: p.accountId ?? null,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.paycheckActions?.length) {
    const { error } = await supabase.from("paycheck_actions").upsert(
      s.paycheckActions.map((action) => withUser(userId, {
        id: action.id,
        paycheck_id: action.paycheckId,
        account_id: action.accountId ?? null,
        type: action.type,
        source_id: action.sourceId ?? null,
        label: action.label ?? "",
        amount: action.amount,
        created_at: action.createdAt ?? new Date().toISOString(),
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.cashAdjustments?.length) {
    const { error } = await supabase.from("cash_adjustments").upsert(
      s.cashAdjustments.map((c) => withUser(userId, {
        id: c.id,
        account_id: c.accountId ?? null,
        type: c.type,
        amount: c.amount,
        adjustment_date: c.adjustmentDate,
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.deductionRules?.length) {
    const { error } = await supabase.from("deduction_rules").upsert(
      s.deductionRules.map((r) => withUser(userId, {
        id: r.id,
        name: r.name,
        scope: r.scope ?? "GLOBAL",
        income_source_id: r.incomeSourceId ?? null,
        value_type: r.valueType ?? "PERCENTAGE",
        fixed_amount: r.fixedAmount ?? 0,
        percentage: r.percentage ?? 0,
        status: r.status ?? "MANDATORY",
        is_enabled_by_default: r.isEnabledByDefault !== false,
        notes: r.notes ?? "",
        tags: [],
        custom_fields: [],
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.categories?.length) {
    const { error } = await supabase.from("user_categories").upsert(
      s.categories.map((c) => withUser(userId, {
        id: c.id,
        name: c.name,
        kind: c.kind ?? "GENERAL",
        notes: c.notes ?? "",
        tags: [],
      })),
    );
    if (error) throw new Error(error.message);
  }
  if (s.labels?.length) {
    const { error } = await supabase.from("custom_labels").upsert(
      s.labels.map((l) => withUser(userId, {
        id: l.id,
        label: l.label,
        notes: l.notes ?? "",
      })),
    );
    if (error) throw new Error(error.message);
  }
  const { error } = await supabase.from("planner_settings").upsert({
    user_id: userId,
    settings: s.settings ?? {},
    notification_settings: s.notificationSettings ?? {},
  });
  if (error) throw new Error(error.message);
}

export async function importPlannerBackupPackage(userId: string, pkg: PlannerBackupPackage): Promise<void> {
  if (pkg.schemaVersion > WEB_BACKUP_SCHEMA_VERSION) {
    throw new Error(`Backup schema ${pkg.schemaVersion} is newer than this app supports (${WEB_BACKUP_SCHEMA_VERSION}).`);
  }
  await deleteAllNormalizedPlannerData(userId);
  await upsertNormalizedFromPlannerSnapshot(userId, pkg.snapshot);
}

/** Persist a bank transaction manually (used by Teller sync later; also handy for testing). */
export async function upsertBankTransaction(userId: string, tx: {
  id?: string;
  bankAccountId: string;
  providerTransactionId?: string | null;
  description: string;
  merchant?: string;
  amount: number;
  postedDate?: string;
}) {
  // Stable identity: one row per (account, provider id) so tags and categorizations
  // always attach to the same bank_transactions.id across refreshes.
  if (tx.providerTransactionId && tx.bankAccountId) {
    const { data: existing, error: selErr } = await supabase
      .from("bank_transactions")
      .select("id")
      .eq("user_id", userId)
      .eq("bank_account_id", tx.bankAccountId)
      .eq("provider_transaction_id", tx.providerTransactionId)
      .maybeSingle();
    if (selErr) throw new Error(selErr.message);
    const existingId = existing ? String((existing as Record<string, unknown>).id ?? "") : "";
    if (existingId) {
      const { error } = await supabase
        .from("bank_transactions")
        .update({
          description: tx.description,
          merchant: tx.merchant ?? null,
          amount: tx.amount,
          posted_date: tx.postedDate ?? null,
        })
        .eq("user_id", userId)
        .eq("id", existingId);
      if (error) throw new Error(error.message);
      return existingId;
    }
  }

  const id = tx.id ?? newId();
  const { error } = await supabase.from("bank_transactions").upsert(withUser(userId, {
    id,
    bank_account_id: tx.bankAccountId,
    provider_transaction_id: tx.providerTransactionId ?? null,
    description: tx.description,
    merchant: tx.merchant ?? null,
    amount: tx.amount,
    posted_date: tx.postedDate ?? null,
  }));
  if (error) throw new Error(error.message);
  return id;
}

/**
 * After linking a bank charge to a bill, adjust `bills.current_amount_due` so the
 * planner reflects what is still owed. `BY_AMOUNT` subtracts the tagged payment;
 * `CLEAR_DUE` zeros the current cycle (user says this payment closes the bill for now).
 */
export async function applyBillPaymentAccounting(
  userId: string,
  billId: string,
  paidAmount: number,
  mode: "BY_AMOUNT" | "CLEAR_DUE",
): Promise<void> {
  const { data, error } = await supabase
    .from("bills")
    .select("current_amount_due, status")
    .eq("user_id", userId)
    .eq("id", billId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  const row = data as Record<string, unknown> | null;
  if (!row) return;
  const cur = numOr(row.current_amount_due, 0);
  const next = mode === "CLEAR_DUE" ? 0 : Math.max(0, cur - Math.abs(paidAmount));
  const prevStatus = String(row.status ?? "UPCOMING");
  const status = next <= 0 ? (prevStatus === "OVERDUE" ? "UPCOMING" : "UPCOMING") : "PARTIAL";
  const { error: uerr } = await supabase
    .from("bills")
    .update({ current_amount_due: next, status })
    .eq("user_id", userId)
    .eq("id", billId);
  if (uerr) throw new Error(uerr.message);
}

/** Upsert a user override categorization for a transaction. */
export async function saveTransactionCategorization(userId: string, input: {
  transactionId: string;
  categoryKind?: string;
  userCategoryId?: string | null;
  billId?: string | null;
  debtId?: string | null;
  expenseId?: string | null;
  goalId?: string | null;
  housingBucketId?: string | null;
  /** When category_kind is INCOME, links the bank deposit to this paycheck source. */
  incomeSourceId?: string | null;
  note?: string;
  isUserOverride?: boolean;
}) {
  const { error } = await supabase.from("transaction_categorizations").upsert({
    user_id: userId,
    transaction_id: input.transactionId,
    category_kind: input.categoryKind ?? "CATEGORY",
    user_category_id: input.userCategoryId ?? null,
    bill_id: input.billId ?? null,
    debt_id: input.debtId ?? null,
    expense_id: input.expenseId ?? null,
    goal_id: input.goalId ?? null,
    housing_bucket_id: input.housingBucketId ?? null,
    income_source_id: input.incomeSourceId ?? null,
    note: input.note ?? "",
    is_user_override: input.isUserOverride ?? true,
  }, { onConflict: "user_id,transaction_id" });
  if (error) throw new Error(error.message);
}

export interface TransactionSplitRow {
  id: string;
  amount: number;
  categoryKind: string;
  billId: string | null;
  debtId: string | null;
  expenseId: string | null;
  goalId: string | null;
  housingBucketId: string | null;
  incomeSourceId: string | null;
  note: string;
  position: number;
}

export interface TransactionCategorizationRow {
  categoryKind: string;
  billId: string | null;
  debtId: string | null;
  expenseId: string | null;
  goalId: string | null;
  housingBucketId: string | null;
  incomeSourceId: string | null;
  note: string;
  isUserOverride: boolean;
}

/** Load the existing primary category + splits for a transaction so the editor can preload them. */
export async function loadTransactionAssignments(userId: string, transactionId: string): Promise<{
  categorization: TransactionCategorizationRow | null;
  splits: TransactionSplitRow[];
}> {
  const [catRes, splitRes] = await Promise.all([
    supabase
      .from("transaction_categorizations")
      .select("*")
      .eq("user_id", userId)
      .eq("transaction_id", transactionId)
      .maybeSingle(),
    supabase
      .from("transaction_splits")
      .select("*")
      .eq("user_id", userId)
      .eq("transaction_id", transactionId)
      .order("position", { ascending: true }),
  ]);

  const categorization = catRes.data
    ? {
      categoryKind: String((catRes.data as Record<string, unknown>).category_kind ?? "UNCATEGORIZED"),
      billId: ((catRes.data as Record<string, unknown>).bill_id as string | null) ?? null,
      debtId: ((catRes.data as Record<string, unknown>).debt_id as string | null) ?? null,
      expenseId: ((catRes.data as Record<string, unknown>).expense_id as string | null) ?? null,
      goalId: ((catRes.data as Record<string, unknown>).goal_id as string | null) ?? null,
      housingBucketId: ((catRes.data as Record<string, unknown>).housing_bucket_id as string | null) ?? null,
      incomeSourceId: ((catRes.data as Record<string, unknown>).income_source_id as string | null) ?? null,
      note: String((catRes.data as Record<string, unknown>).note ?? ""),
      isUserOverride: ((catRes.data as Record<string, unknown>).is_user_override as boolean) ?? false,
    }
    : null;

  const splits = (splitRes.data ?? []).map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? newId()),
      amount: Number(r.amount ?? 0),
      categoryKind: String(r.category_kind ?? "CATEGORY"),
      billId: (r.bill_id as string | null) ?? null,
      debtId: (r.debt_id as string | null) ?? null,
      expenseId: (r.expense_id as string | null) ?? null,
      goalId: (r.goal_id as string | null) ?? null,
      housingBucketId: (r.housing_bucket_id as string | null) ?? null,
      incomeSourceId: (r.income_source_id as string | null) ?? null,
      note: String(r.note ?? ""),
      position: Number(r.position ?? 0),
    };
  });

  return { categorization, splits };
}

/**
 * One-time migration: if the signed-in account has data in `planner_snapshots.snapshot`
 * (typically pushed from the Android app) but the normalized tables are empty, copy the
 * snapshot contents into the normalized tables so both platforms share the same rows.
 *
 * Idempotent — skips entities that already have any rows for this user.
 */
export async function importLegacySnapshotIntoNormalized(userId: string, snapshot: Record<string, unknown>): Promise<{ importedEntities: string[]; skippedEntities: string[] }> {
  const imported: string[] = [];
  const skipped: string[] = [];

  const rawBills = Array.isArray(snapshot.bills) ? snapshot.bills : [];
  const rawIncome = Array.isArray(snapshot.incomeSources) ? snapshot.incomeSources : [];
  const rawDebts = Array.isArray(snapshot.debts) ? snapshot.debts : [];
  const rawExpenses = Array.isArray(snapshot.expenses) ? snapshot.expenses : [];
  const rawGoals = Array.isArray(snapshot.goals) ? snapshot.goals : [];
  const rawAccounts = Array.isArray(snapshot.accounts) ? snapshot.accounts : [];
  const rawPaychecks = Array.isArray(snapshot.paychecks) ? snapshot.paychecks : [];
  const rawBillPayments = Array.isArray(snapshot.billPayments) ? snapshot.billPayments : [];
  const rawDebtTx = Array.isArray(snapshot.debtTransactions) ? snapshot.debtTransactions : [];
  const rawExpenseSpends = Array.isArray(snapshot.expenseSpends) ? snapshot.expenseSpends : [];
  const rawHousingBuckets = Array.isArray(snapshot.housingBuckets) ? snapshot.housingBuckets : [];
  const rawHousingPayments = Array.isArray(snapshot.housingPayments) ? snapshot.housingPayments : [];
  const rawCashAdj = Array.isArray(snapshot.cashAdjustments) ? snapshot.cashAdjustments : [];
  const rawHousingConfig = snapshot.housingConfig as Record<string, unknown> | null | undefined;
  const rawSettings = snapshot.settings as Record<string, unknown> | null | undefined;

  const rowsEmpty = async (table: string): Promise<boolean> => {
    const { data, error } = await supabase.from(table).select("id", { count: "exact", head: true }).eq("user_id", userId);
    if (error) return false;
    return !data || data.length === 0;
  };

  const upsertIfEmpty = async (table: string, rows: Array<Record<string, unknown>>, label: string) => {
    if (rows.length === 0) return;
    const empty = await rowsEmpty(table);
    if (!empty) { skipped.push(label); return; }
    const { error } = await supabase.from(table).upsert(rows.map((r) => ({ ...r, user_id: userId })));
    if (error) { skipped.push(`${label} (error: ${error.message})`); return; }
    imported.push(`${label} (${rows.length})`);
  };

  await upsertIfEmpty(
    "bank_accounts",
    rawAccounts.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        name: String(r.name ?? "Account"),
        type: String(r.type ?? "Checking"),
        current_balance: Number(r.currentBalance ?? 0),
        available_balance: Number(r.availableBalance ?? 0),
        include_in_planning: r.includeInPlanning !== false,
        protected_from_payoff: r.protectedFromPayoff === true,
        teller_enrollment_id: r.tellerEnrollmentId ?? null,
        teller_linked_account_id: r.tellerLinkedAccountId ?? null,
      };
    }),
    "accounts",
  );

  await upsertIfEmpty(
    "income_sources",
    rawIncome.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        name: String(r.name ?? ""),
        payer_label: String(r.payerLabel ?? ""),
        recurring_rule: r.recurringRule ?? {},
        amount_range: r.amountRange ?? {},
        forecast_amount_mode: String(r.forecastAmountMode ?? "FIXED"),
        input_mode: String(r.inputMode ?? "USABLE"),
        next_expected_pay_date: r.nextExpectedPayDate ?? null,
        is_active: r.isActive !== false,
      };
    }),
    "income_sources",
  );

  await upsertIfEmpty(
    "bills",
    rawBills.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        name: String(r.name ?? ""),
        amount_due: Number(r.amountDue ?? 0),
        minimum_due: Number(r.minimumDue ?? 0),
        current_amount_due: Number(r.currentAmountDue ?? 0),
        recurring_rule: r.recurringRule ?? {},
        category: String(r.category ?? ""),
        is_essential: r.isEssential === true,
        status: String(r.status ?? "UPCOMING"),
        payment_policy: String(r.paymentPolicy ?? "HARD_DUE"),
      };
    }),
    "bills",
  );

  await upsertIfEmpty(
    "bill_payments",
    rawBillPayments.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        bill_id: String(r.billId ?? ""),
        amount: Number(r.amount ?? 0),
        payment_date: r.paymentDate ?? null,
      };
    }),
    "bill_payments",
  );

  await upsertIfEmpty(
    "debts",
    rawDebts.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        name: String(r.name ?? ""),
        lender: String(r.lender ?? ""),
        type: String(r.type ?? "INSTALLMENT"),
        current_balance: Number(r.currentBalance ?? 0),
        minimum_due: Number(r.minimumDue ?? 0),
        required_due_date: r.requiredDueDate ?? null,
        arrears_amount: Number(r.arrearsAmount ?? 0),
      };
    }),
    "debts",
  );

  await upsertIfEmpty(
    "debt_transactions",
    rawDebtTx.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        debt_id: String(r.debtId ?? ""),
        type: String(r.type ?? "PAYMENT"),
        amount: Number(r.amount ?? 0),
        event_date: r.eventDate ?? null,
      };
    }),
    "debt_transactions",
  );

  await upsertIfEmpty(
    "recurring_expenses",
    rawExpenses.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        name: String(r.name ?? ""),
        amount: Number(r.amount ?? 0),
        recurring_rule: r.recurringRule ?? {},
        is_essential: r.isEssential !== false,
        is_variable: r.isVariable === true,
        allocation_mode: String(r.allocationMode ?? "EVENLY"),
        one_time_date: r.oneTimeDate ?? null,
        category_label: String(r.categoryLabel ?? ""),
      };
    }),
    "recurring_expenses",
  );

  await upsertIfEmpty(
    "expense_spends",
    rawExpenseSpends.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        expense_id: String(r.expenseId ?? ""),
        amount: Number(r.amount ?? 0),
        spend_date: r.spendDate ?? null,
      };
    }),
    "expense_spends",
  );

  if (rawHousingConfig) {
    const empty = await rowsEmpty("housing_config");
    if (empty) {
      const { error } = await supabase.from("housing_config").upsert({
        user_id: userId,
        id: "housing",
        current_monthly_rent: Number(rawHousingConfig.currentMonthlyRent ?? 0),
        minimum_acceptable_payment: Number(rawHousingConfig.minimumAcceptablePayment ?? 0),
        rent_due_day: Number(rawHousingConfig.rentDueDay ?? 1),
        arrangement: String(rawHousingConfig.arrangement ?? "RENT_MONTH_TO_MONTH"),
      });
      if (!error) imported.push("housing_config");
      else skipped.push(`housing_config (error: ${error.message})`);
    } else skipped.push("housing_config");
  }

  await upsertIfEmpty(
    "housing_buckets",
    rawHousingBuckets.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        label: String(r.label ?? ""),
        month_key: String(r.monthKey ?? ""),
        amount_due: Number(r.amountDue ?? 0),
        amount_paid: Number(r.amountPaid ?? 0),
        due_date: r.dueDate ?? null,
        is_current_bucket: r.isCurrentBucket === true,
      };
    }),
    "housing_buckets",
  );

  await upsertIfEmpty(
    "housing_payments",
    rawHousingPayments.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        bucket_id: String(r.bucketId ?? ""),
        amount: Number(r.amount ?? 0),
        payment_date: r.paymentDate ?? null,
      };
    }),
    "housing_payments",
  );

  await upsertIfEmpty(
    "goals",
    rawGoals.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        name: String(r.name ?? ""),
        target_amount: Number(r.targetAmount ?? 0),
        current_amount: Number(r.currentAmount ?? 0),
        is_active: r.isActive !== false,
      };
    }),
    "goals",
  );

  await upsertIfEmpty(
    "paychecks",
    rawPaychecks.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        income_source_id: r.incomeSourceId ?? null,
        payer_label: String(r.payerLabel ?? ""),
        date: r.date ?? null,
        amount: Number(r.amount ?? 0),
        deposited: r.deposited === true,
        account_id: r.accountId ?? null,
      };
    }),
    "paychecks",
  );

  await upsertIfEmpty(
    "cash_adjustments",
    rawCashAdj.map((raw) => {
      const r = raw as Record<string, unknown>;
      return {
        id: String(r.id ?? newId()),
        account_id: r.accountId ?? null,
        type: String(r.type ?? "CASH_IN"),
        amount: Number(r.amount ?? 0),
        adjustment_date: r.adjustmentDate ?? null,
      };
    }),
    "cash_adjustments",
  );

  if (rawSettings && Object.keys(rawSettings).length > 0) {
    const empty = await rowsEmpty("planner_settings");
    if (empty) {
      const { error } = await supabase.from("planner_settings").upsert({
        user_id: userId,
        settings: rawSettings,
      });
      if (!error) imported.push("planner_settings");
      else skipped.push(`planner_settings (error: ${error.message})`);
    } else skipped.push("planner_settings");
  }

  return { importedEntities: imported, skippedEntities: skipped };
}

export type PlannerActualTarget =
  | { kind: "BILL"; id: string }
  | { kind: "DEBT"; id: string }
  | { kind: "EXPENSE"; id: string }
  | { kind: "HOUSING"; id: string }
  | { kind: "GOAL"; id: string }
  | { kind: "INCOME"; id: string }
  | { kind: "CASH_IN" }
  | { kind: "CASH_OUT" }
  | { kind: "UNCATEGORIZED" };

export interface TransactionRef {
  id: string;
  description: string;
  merchant?: string | null;
  amount: number;
  postedDate?: string | null;
}

function plannerActualId(txId: string, kind: string): string {
  return `tx_${txId}_${kind.toLowerCase()}`;
}

/**
 * Remove any planner actual rows (`bill_payments`, `debt_transactions`,
 * `expense_spends`, `housing_payments`) that were previously created from this
 * bank transaction. Safe to call before re-linking so category switches never
 * leave stale postings behind. Errors are ignored so one dead row does not
 * block the entire re-categorization.
 */
export async function deleteTransactionLinkedActuals(userId: string, txId: string): Promise<void> {
  // Remove both legacy single-link ids and new split-link ids (tx_<txId>_*).
  const prefix = `tx_${txId}_`;
  await supabase.from("bill_payments").delete().eq("user_id", userId).ilike("id", `${prefix}%`);
  await supabase.from("debt_transactions").delete().eq("user_id", userId).ilike("id", `${prefix}%`);
  await supabase.from("expense_spends").delete().eq("user_id", userId).ilike("id", `${prefix}%`);
  await supabase.from("housing_payments").delete().eq("user_id", userId).ilike("id", `${prefix}%`);
  await supabase.from("paychecks").delete().eq("user_id", userId).ilike("id", `${prefix}%`);
}

/**
 * Post (or re-post) a planner actual derived from a bank transaction, using a
 * deterministic id so the row is idempotent across re-syncs and user
 * re-categorizations. Any prior actuals linked to this transaction are
 * removed before the new row is inserted.
 */
export async function linkTransactionToPlannerActual(
  userId: string,
  txId: string,
  target: PlannerActualTarget,
  tx: TransactionRef,
  sourceLabel = "Bank",
): Promise<boolean> {
  await deleteTransactionLinkedActuals(userId, txId);
  const amount = Math.abs(tx.amount);
  const date = tx.postedDate ?? new Date().toISOString().slice(0, 10);
  const label = `${sourceLabel} · ${tx.merchant ?? tx.description}`.slice(0, 120);
  try {
    if (target.kind === "BILL") {
      const { error } = await supabase.from("bill_payments").upsert(withUser(userId, {
        id: plannerActualId(txId, "BILL"),
        bill_id: target.id,
        amount,
        payment_date: date,
        source_label: label,
        note: `Linked bank transaction ${tx.id}`,
      }));
      return !error;
    }
    if (target.kind === "DEBT") {
      const { error } = await supabase.from("debt_transactions").upsert(withUser(userId, {
        id: plannerActualId(txId, "DEBT"),
        debt_id: target.id,
        type: "PAYMENT",
        amount,
        event_date: date,
        source_label: label,
        note: `Linked bank transaction ${tx.id}`,
      }));
      return !error;
    }
    if (target.kind === "EXPENSE") {
      const { error } = await supabase.from("expense_spends").upsert(withUser(userId, {
        id: plannerActualId(txId, "EXPENSE"),
        expense_id: target.id,
        amount,
        spend_date: date,
        note: `Linked bank transaction ${tx.id}`,
      }));
      return !error;
    }
    if (target.kind === "HOUSING") {
      const { error } = await supabase.from("housing_payments").upsert(withUser(userId, {
        id: plannerActualId(txId, "HOUSING"),
        bucket_id: target.id,
        amount,
        payment_date: date,
        note: `Linked bank transaction ${tx.id}`,
      }));
      return !error;
    }
    if (target.kind === "INCOME") {
      const { data: inc, error: selErr } = await supabase
        .from("income_sources")
        .select("name, payer_label")
        .eq("user_id", userId)
        .eq("id", target.id)
        .maybeSingle();
      if (selErr) return false;
      const r = inc as Record<string, unknown> | null;
      const payerLabel = String(r?.payer_label ?? r?.name ?? "Paycheck").trim() || "Paycheck";
      const { error } = await supabase.from("paychecks").upsert(withUser(userId, {
        id: plannerActualId(txId, "INCOME"),
        income_source_id: target.id,
        payer_label: payerLabel,
        date,
        amount,
        deposited: true,
        account_id: null,
      }));
      return !error;
    }
    return false;
  } catch {
    return false;
  }
}

// ============================================================
// Category learning rules
// ============================================================

export type CategoryRuleTargetKind =
  | "BILL"
  | "DEBT"
  | "EXPENSE"
  | "GOAL"
  | "HOUSING"
  | "INCOME"
  | "CATEGORY"
  | "CASH_IN"
  | "CASH_OUT"
  | "UNCATEGORIZED";

export interface CategoryRule {
  id: string;
  user_id: string;
  name: string;
  matcher_type: string;
  matcher_value: string;
  target_kind: CategoryRuleTargetKind;
  target_category_id?: string | null;
  target_bill_id?: string | null;
  target_debt_id?: string | null;
  target_expense_id?: string | null;
  target_housing_bucket_id?: string | null;
  target_goal_id?: string | null;
  target_income_source_id?: string | null;
  target_custom_label?: string | null;
  is_enabled: boolean;
  priority: number;
  applied_count?: number;
  last_applied_at?: string | null;
}

/** Canonical key used to store/lookup per-merchant rules. */
export function normalizeMerchantKey(raw: string): string {
  return raw.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

export async function loadCategoryRules(userId: string): Promise<CategoryRule[]> {
  const { data, error } = await supabase
    .from("category_rules")
    .select("*")
    .eq("user_id", userId)
    .eq("is_enabled", true)
    .order("priority", { ascending: true })
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);
  return (data ?? []) as CategoryRule[];
}

/**
 * Upsert a user-taught rule so the next time a transaction with the same
 * normalized merchant/description comes in from the bank, the auto-categorizer
 * classifies it the same way without the user having to touch it again.
 */
export async function upsertCategoryRuleFromAdjustment(userId: string, input: {
  matcherValue: string;
  name?: string;
  targetKind: CategoryRuleTargetKind;
  targetBillId?: string | null;
  targetDebtId?: string | null;
  targetExpenseId?: string | null;
  targetGoalId?: string | null;
  targetHousingBucketId?: string | null;
  targetIncomeSourceId?: string | null;
}): Promise<void> {
  const normalized = normalizeMerchantKey(input.matcherValue);
  if (!normalized) return;
  const existing = await supabase
    .from("category_rules")
    .select("id, applied_count")
    .eq("user_id", userId)
    .eq("matcher_type", "MERCHANT_CONTAINS")
    .ilike("matcher_value", normalized)
    .limit(1)
    .maybeSingle();
  const id = existing.data?.id ?? newId();
  const priorCount = Number((existing.data as { applied_count?: number } | null)?.applied_count ?? 0);
  const row = {
    id,
    user_id: userId,
    name: input.name ?? `Always mark "${input.matcherValue}" as ${input.targetKind}`,
    matcher_type: "MERCHANT_CONTAINS",
    matcher_value: normalized,
    target_kind: input.targetKind,
    target_bill_id: input.targetKind === "BILL" ? (input.targetBillId ?? null) : null,
    target_debt_id: input.targetKind === "DEBT" ? (input.targetDebtId ?? null) : null,
    target_expense_id: input.targetKind === "EXPENSE" ? (input.targetExpenseId ?? null) : null,
    target_goal_id: input.targetKind === "GOAL" ? (input.targetGoalId ?? null) : null,
    target_housing_bucket_id: input.targetKind === "HOUSING" ? (input.targetHousingBucketId ?? null) : null,
    target_income_source_id: input.targetKind === "INCOME" ? (input.targetIncomeSourceId ?? null) : null,
    is_enabled: true,
    priority: 10,
    applied_count: priorCount + 1,
    last_applied_at: new Date().toISOString(),
  };
  const { error } = await supabase.from("category_rules").upsert(row);
  if (error) throw new Error(error.message);
}

export interface RuleMatch {
  rule: CategoryRule;
  confidence: number;
}

/**
 * Pure helper used by the categorizer. Returns the best learned rule for a
 * transaction's description/merchant, or null if no rule applies.
 */
export function matchRuleForText(rules: CategoryRule[], text: string): RuleMatch | null {
  const normalized = normalizeMerchantKey(text);
  if (!normalized) return null;
  let best: RuleMatch | null = null;
  for (const rule of rules) {
    if (!rule.is_enabled) continue;
    const value = normalizeMerchantKey(rule.matcher_value);
    if (!value) continue;
    if (rule.matcher_type === "MERCHANT_CONTAINS" || rule.matcher_type === "TEXT_CONTAINS") {
      if (normalized.includes(value)) {
        const base = value.length >= 6 ? 0.99 : value.length >= 4 ? 0.94 : 0.9;
        const score = Math.min(0.99, base + Math.min(0.05, (rule.applied_count ?? 0) * 0.005));
        if (!best || score > best.confidence) best = { rule, confidence: score };
      }
    } else if (rule.matcher_type === "MERCHANT_EXACT") {
      if (normalized === value) {
        const score = Math.min(0.99, 0.98 + Math.min(0.05, (rule.applied_count ?? 0) * 0.005));
        if (!best || score > best.confidence) best = { rule, confidence: score };
      }
    }
  }
  return best;
}

export async function saveTransactionSplits(userId: string, transactionId: string, splits: Array<{
  id?: string;
  amount: number;
  categoryKind?: string;
  userCategoryId?: string | null;
  billId?: string | null;
  debtId?: string | null;
  expenseId?: string | null;
  goalId?: string | null;
  housingBucketId?: string | null;
  incomeSourceId?: string | null;
  note?: string;
  position?: number;
}>) {
  // Replace existing splits for the transaction.
  const del = await supabase
    .from("transaction_splits")
    .delete()
    .eq("user_id", userId)
    .eq("transaction_id", transactionId);
  if (del.error) throw new Error(del.error.message);

  if (splits.length === 0) return;
  const rows = splits.map((s, i) => ({
    user_id: userId,
    id: s.id ?? newId(),
    transaction_id: transactionId,
    position: s.position ?? i,
    amount: s.amount,
    category_kind: s.categoryKind ?? "CATEGORY",
    user_category_id: s.userCategoryId ?? null,
    bill_id: s.billId ?? null,
    debt_id: s.debtId ?? null,
    expense_id: s.expenseId ?? null,
    goal_id: s.goalId ?? null,
    housing_bucket_id: s.housingBucketId ?? null,
    income_source_id: s.incomeSourceId ?? null,
    note: s.note ?? "",
  }));
  const { error } = await supabase.from("transaction_splits").insert(rows);
  if (error) throw new Error(error.message);
}

export interface SplitActualInput {
  index: number; // deterministic position so the planner actual id stays stable
  target: PlannerActualTarget;
  amount: number;
  note?: string;
}

/**
 * Post multiple planner actuals for a single bank transaction, one per split row.
 * Each actual gets a deterministic id `tx_<txId>_split<index>_<kind>` so repeated
 * saves overwrite instead of duplicating. Prior actuals for this transaction are
 * removed first.
 */
export async function linkTransactionSplitsToPlannerActuals(
  userId: string,
  txId: string,
  splits: SplitActualInput[],
  tx: TransactionRef,
  sourceLabel = "Bank",
): Promise<{ posted: number; skipped: number }> {
  await deleteTransactionLinkedActuals(userId, txId);
  let posted = 0;
  let skipped = 0;
  const date = tx.postedDate ?? new Date().toISOString().slice(0, 10);
  const label = `${sourceLabel} · ${tx.merchant ?? tx.description}`.slice(0, 120);

  for (const split of splits) {
    const amount = Math.abs(Number(split.amount) || 0);
    if (amount <= 0) { skipped++; continue; }
    const rowId = `tx_${txId}_split${split.index}_${split.target.kind.toLowerCase()}`;
    const note = (split.note ? `${split.note} · ` : "") + `Linked bank transaction ${tx.id}`;
    try {
      if (split.target.kind === "BILL") {
        const { error } = await supabase.from("bill_payments").upsert(withUser(userId, {
          id: rowId,
          bill_id: split.target.id,
          amount,
          payment_date: date,
          source_label: label,
          note,
        }));
        if (!error) posted++; else skipped++;
      } else if (split.target.kind === "DEBT") {
        const { error } = await supabase.from("debt_transactions").upsert(withUser(userId, {
          id: rowId,
          debt_id: split.target.id,
          type: "PAYMENT",
          amount,
          event_date: date,
          source_label: label,
          note,
        }));
        if (!error) posted++; else skipped++;
      } else if (split.target.kind === "EXPENSE") {
        const { error } = await supabase.from("expense_spends").upsert(withUser(userId, {
          id: rowId,
          expense_id: split.target.id,
          amount,
          spend_date: date,
          note,
        }));
        if (!error) posted++; else skipped++;
      } else if (split.target.kind === "HOUSING") {
        const { error } = await supabase.from("housing_payments").upsert(withUser(userId, {
          id: rowId,
          bucket_id: split.target.id,
          amount,
          payment_date: date,
          note,
        }));
        if (!error) posted++; else skipped++;
      } else if (split.target.kind === "INCOME") {
        const { data: inc, error: selErr } = await supabase
          .from("income_sources")
          .select("name, payer_label")
          .eq("user_id", userId)
          .eq("id", split.target.id)
          .maybeSingle();
        if (selErr) {
          skipped++;
        } else {
          const r = inc as Record<string, unknown> | null;
          const payerLabel = String(r?.payer_label ?? r?.name ?? "Paycheck").trim() || "Paycheck";
          const { error } = await supabase.from("paychecks").upsert(withUser(userId, {
            id: rowId,
            income_source_id: split.target.id,
            payer_label: payerLabel,
            date,
            amount,
            deposited: true,
            account_id: null,
          }));
          if (!error) posted++; else skipped++;
        }
      } else {
        skipped++;
      }
    } catch {
      skipped++;
    }
  }
  return { posted, skipped };
}
