// Loader: pulls all the normalized planner rows for a user out of Supabase
// and stitches them into the `PlannerSnapshot` shape the engine expects.

import type { SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";
import type {
  PlannerSettings,
  PlannerSnapshot,
  RecurringRule,
  SnapshotAccount,
  SnapshotBill,
  SnapshotBillPayment,
  SnapshotCashAdjustment,
  SnapshotDebt,
  SnapshotDebtTransaction,
  SnapshotExpenseSpend,
  SnapshotGoal,
  SnapshotHousingBucket,
  SnapshotHousingConfig,
  SnapshotHousingPayment,
  SnapshotIncomeSource,
  SnapshotPaycheck,
  SnapshotRecurringExpense,
} from "./types.ts";

function asRecord<T>(v: unknown): T {
  return (v ?? {}) as T;
}

function toIsoDate(value: unknown): string | null {
  if (!value) return null;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length >= 10 ? trimmed.slice(0, 10) : trimmed;
}

function numberOr(value: unknown, fallback: number): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function loadAccounts(rows: unknown[]): SnapshotAccount[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      type: String(r.type ?? "Checking"),
      currentBalance: numberOr(r.current_balance, 0),
      availableBalance: numberOr(r.available_balance, 0),
      includeInPlanning: (r.include_in_planning ?? true) === true,
      protectedFromPayoff: r.protected_from_payoff === true,
      tellerEnrollmentId: r.teller_enrollment_id ? String(r.teller_enrollment_id) : null,
      tellerLinkedAccountId: r.teller_linked_account_id ? String(r.teller_linked_account_id) : null,
    };
  });
}

function loadIncomeSources(rows: unknown[]): SnapshotIncomeSource[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      payerLabel: String(r.payer_label ?? ""),
      recurringRule: asRecord<RecurringRule>(r.recurring_rule),
      amountRange: asRecord(r.amount_range) as SnapshotIncomeSource["amountRange"],
      forecastAmountMode: (r.forecast_amount_mode as SnapshotIncomeSource["forecastAmountMode"]) ?? "FIXED",
      inputMode: (r.input_mode as SnapshotIncomeSource["inputMode"]) ?? "USABLE",
      nextExpectedPayDate: toIsoDate(r.next_expected_pay_date),
      isActive: r.is_active !== false,
      isManualOnly: r.is_manual_only === true,
      deductionRuleIds: Array.isArray(r.deduction_rule_ids)
        ? (r.deduction_rule_ids as string[])
        : [],
    };
  });
}

function loadPaychecks(rows: unknown[]): SnapshotPaycheck[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      incomeSourceId: r.income_source_id ? String(r.income_source_id) : null,
      payerLabel: String(r.payer_label ?? ""),
      date: String(toIsoDate(r.date) ?? ""),
      amount: numberOr(r.amount, 0),
      amountMode: (r.amount_mode as SnapshotPaycheck["amountMode"]) ?? "USABLE",
      deposited: r.deposited === true,
      accountId: r.account_id ? String(r.account_id) : null,
    };
  });
}

function loadBills(rows: unknown[]): SnapshotBill[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      amountDue: numberOr(r.amount_due, 0),
      minimumDue: numberOr(r.minimum_due, 0),
      currentAmountDue: numberOr(r.current_amount_due, 0),
      recurringRule: asRecord<RecurringRule>(r.recurring_rule),
      category: r.category ? String(r.category) : "",
      isEssential: r.is_essential === true,
      status: (r.status as SnapshotBill["status"]) ?? "UPCOMING",
      paymentPolicy: (r.payment_policy as SnapshotBill["paymentPolicy"]) ?? "HARD_DUE",
      graceDays: typeof r.grace_days === "number" ? (r.grace_days as number) : undefined,
      lateTriggerDays: numberOr(r.late_trigger_days, 0),
    };
  });
}

function loadBillPayments(rows: unknown[]): SnapshotBillPayment[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      billId: String(r.bill_id ?? ""),
      amount: numberOr(r.amount, 0),
      paymentDate: String(toIsoDate(r.payment_date) ?? ""),
      paycheckId: r.paycheck_id ? String(r.paycheck_id) : null,
      appliedDueDate: toIsoDate(r.applied_due_date),
    };
  });
}

function loadDebts(rows: unknown[]): SnapshotDebt[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      lender: String(r.lender ?? ""),
      type: String(r.type ?? "INSTALLMENT"),
      currentBalance: numberOr(r.current_balance, 0),
      minimumDue: numberOr(r.minimum_due, 0),
      requiredDueDate: toIsoDate(r.required_due_date),
      interestRate: typeof r.interest_rate === "number" ? (r.interest_rate as number) : null,
      arrearsAmount: numberOr(r.arrears_amount, 0),
      payoffPriority: numberOr(r.payoff_priority, 1),
      reborrowAllowed: r.reborrow_allowed === true,
    };
  });
}

function loadDebtTransactions(rows: unknown[]): SnapshotDebtTransaction[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      debtId: String(r.debt_id ?? ""),
      type: (r.type as SnapshotDebtTransaction["type"]) ?? "PAYMENT",
      amount: numberOr(r.amount, 0),
      eventDate: String(toIsoDate(r.event_date) ?? ""),
      paycheckId: r.paycheck_id ? String(r.paycheck_id) : null,
      feeAmount: numberOr(r.fee_amount, 0),
    };
  });
}

function loadExpenses(rows: unknown[]): SnapshotRecurringExpense[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      amount: numberOr(r.amount, 0),
      recurringRule: asRecord<RecurringRule>(r.recurring_rule),
      isEssential: r.is_essential !== false,
      isVariable: r.is_variable === true,
      allocationMode: (r.allocation_mode as SnapshotRecurringExpense["allocationMode"]) ?? "EVENLY",
      oneTimeDate: toIsoDate(r.one_time_date),
      categoryLabel: r.category_label ? String(r.category_label) : "",
    };
  });
}

function loadExpenseSpends(rows: unknown[]): SnapshotExpenseSpend[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      expenseId: String(r.expense_id ?? ""),
      amount: numberOr(r.amount, 0),
      spendDate: String(toIsoDate(r.spend_date) ?? ""),
      paycheckId: r.paycheck_id ? String(r.paycheck_id) : null,
    };
  });
}

function loadHousingConfig(rows: unknown[]): SnapshotHousingConfig | null {
  const first = rows[0] as Record<string, unknown> | undefined;
  if (!first) return null;
  return {
    currentMonthlyRent: numberOr(first.current_monthly_rent, 0),
    minimumAcceptablePayment: numberOr(first.minimum_acceptable_payment, 0),
    rentDueDay: numberOr(first.rent_due_day, 1),
    arrangement: String(first.arrangement ?? "RENT_MONTH_TO_MONTH"),
  };
}

function loadHousingBuckets(rows: unknown[]): SnapshotHousingBucket[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      label: String(r.label ?? ""),
      monthKey: String(r.month_key ?? ""),
      amountDue: numberOr(r.amount_due, 0),
      amountPaid: numberOr(r.amount_paid, 0),
      dueDate: toIsoDate(r.due_date),
      isCurrentBucket: r.is_current_bucket === true,
    };
  });
}

function loadHousingPayments(rows: unknown[]): SnapshotHousingPayment[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      bucketId: String(r.bucket_id ?? ""),
      amount: numberOr(r.amount, 0),
      paymentDate: String(toIsoDate(r.payment_date) ?? ""),
      paycheckId: r.paycheck_id ? String(r.paycheck_id) : null,
    };
  });
}

function loadGoals(rows: unknown[]): SnapshotGoal[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      name: String(r.name ?? ""),
      targetAmount: numberOr(r.target_amount, 0),
      currentAmount: numberOr(r.current_amount, 0),
      isActive: r.is_active !== false,
    };
  });
}

function loadCashAdjustments(rows: unknown[]): SnapshotCashAdjustment[] {
  return rows.map((raw) => {
    const r = raw as Record<string, unknown>;
    return {
      id: String(r.id ?? ""),
      accountId: r.account_id ? String(r.account_id) : null,
      type: (r.type as SnapshotCashAdjustment["type"]) ?? "CASH_IN",
      amount: numberOr(r.amount, 0),
      adjustmentDate: String(toIsoDate(r.adjustment_date) ?? ""),
    };
  });
}

function loadSettings(rows: unknown[]): PlannerSettings {
  const first = rows[0] as Record<string, unknown> | undefined;
  const raw = (first?.settings ?? {}) as Record<string, unknown>;
  return {
    targetBuffer: numberOr(raw.targetBuffer, 0),
    selectedScenarioMode: (raw.selectedScenarioMode as PlannerSettings["selectedScenarioMode"]) ?? "FIXED",
    planningStyle: (raw.planningStyle as PlannerSettings["planningStyle"]) ?? "BALANCED",
    horizonDays: numberOr(raw.horizonDays, 120),
  };
}

function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Loads every user-owned row needed by the engine.
 * `client` must have the user scope already applied (either a user client with RLS or the
 * service client filtered manually by user_id).
 */
export async function loadPlannerSnapshot(
  client: SupabaseClient,
  userId: string,
): Promise<PlannerSnapshot> {
  const filterUser = (q: ReturnType<SupabaseClient["from"]>) => q.eq("user_id", userId);

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
    filterUser(client.from("bank_accounts").select("*")),
    filterUser(client.from("income_sources").select("*")),
    filterUser(client.from("paychecks").select("*")),
    filterUser(client.from("bills").select("*")),
    filterUser(client.from("bill_payments").select("*")),
    filterUser(client.from("debts").select("*")),
    filterUser(client.from("debt_transactions").select("*")),
    filterUser(client.from("recurring_expenses").select("*")),
    filterUser(client.from("expense_spends").select("*")),
    filterUser(client.from("housing_config").select("*")),
    filterUser(client.from("housing_buckets").select("*")),
    filterUser(client.from("housing_payments").select("*")),
    filterUser(client.from("goals").select("*")),
    filterUser(client.from("cash_adjustments").select("*")),
    filterUser(client.from("planner_settings").select("*")),
  ]);

  return {
    today: todayIso(),
    accounts: loadAccounts(accounts.data ?? []),
    incomeSources: loadIncomeSources(incomeSources.data ?? []),
    paychecks: loadPaychecks(paychecks.data ?? []),
    bills: loadBills(bills.data ?? []),
    billPayments: loadBillPayments(billPayments.data ?? []),
    debts: loadDebts(debts.data ?? []),
    debtTransactions: loadDebtTransactions(debtTransactions.data ?? []),
    expenses: loadExpenses(expenses.data ?? []),
    expenseSpends: loadExpenseSpends(expenseSpends.data ?? []),
    housingConfig: loadHousingConfig(housingConfig.data ?? []),
    housingBuckets: loadHousingBuckets(housingBuckets.data ?? []),
    housingPayments: loadHousingPayments(housingPayments.data ?? []),
    goals: loadGoals(goals.data ?? []),
    cashAdjustments: loadCashAdjustments(cashAdjustments.data ?? []),
    settings: loadSettings(settings.data ?? []),
  };
}
