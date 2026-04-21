// Data access layer for the website planner CRUD.
// Wraps Supabase reads/writes for the normalized planner tables and exposes
// `loadPlannerSnapshot` + `recomputeAndPersistPlan` so the UI can just do
// `await api.saveBill(bill); await api.recompute(); render();` patterns.

import { supabase } from "./supabase";
import type { PlannerPlan, PlannerScenarioMode } from "./planner-state";
import {
  buildPlannerPlan,
  PLANNER_ENGINE_VERSION,
  PLANNER_SCHEMA_VERSION,
  type PlannerSnapshot,
  type RecurringRule,
  type SnapshotAccount,
  type SnapshotBill,
  type SnapshotBillPayment,
  type SnapshotCashAdjustment,
  type SnapshotDebt,
  type SnapshotDebtTransaction,
  type SnapshotExpenseSpend,
  type SnapshotGoal,
  type SnapshotHousingBucket,
  type SnapshotHousingConfig,
  type SnapshotHousingPayment,
  type SnapshotIncomeSource,
  type SnapshotPaycheck,
  type SnapshotRecurringExpense,
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
  ] = await Promise.all([
    filter("bank_accounts"),
    filter("income_sources"),
    filter("paychecks"),
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
  ]);

  const settingsRow = (settings.data?.[0] ?? null) as Record<string, unknown> | null;
  const rawSettings = (settingsRow?.settings ?? {}) as Record<string, unknown>;
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
      selectedScenarioMode: (rawSettings.selectedScenarioMode as PlannerScenarioMode) ?? "FIXED",
      planningStyle: (rawSettings.planningStyle as string) ?? "BALANCED",
      horizonDays: numOr(rawSettings.horizonDays, 120),
    },
  };
}

/** Runs the shared planner engine and upserts a fresh `planner_snapshots` row for the user. */
export async function recomputeAndPersistPlan(userId: string): Promise<{ plan: PlannerPlan; snapshot: PlannerSnapshot }> {
  const snapshot = await loadPlannerSnapshot(userId);
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
}

export async function savePlannerSettings(userId: string, settings: PlannerSettingsForm) {
  const { error } = await supabase.from("planner_settings").upsert({
    user_id: userId,
    settings,
  });
  if (error) throw new Error(error.message);
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
    note: input.note ?? "",
    is_user_override: input.isUserOverride ?? true,
  }, { onConflict: "user_id,transaction_id" });
  if (error) throw new Error(error.message);
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
    note: s.note ?? "",
  }));
  const { error } = await supabase.from("transaction_splits").insert(rows);
  if (error) throw new Error(error.message);
}
