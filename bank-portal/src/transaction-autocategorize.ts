// Auto-categorize bank transactions against the user's planner snapshot.
// Deterministic, heuristic-only: name + merchant fuzzy match, amount + date proximity,
// recurring-rule expected-date windows. Never invokes an LLM.
//
// Inputs:
//   - transactions (Teller shape or internal bank_transactions row)
//   - snapshot (PlannerSnapshot for the user; bills, expenses, debts, goals, rules, etc.)
//
// Outputs:
//   - suggestions with a categorization target (bill/expense/debt/goal/housing), confidence 0..1, reason
//   - persistable rows for `bank_transactions` + `transaction_categorizations`
//   - optional planner actuals (bill_payments, debt_transactions, expense_spends, housing_payments, cash_adjustments)

import { newId, upsertBankTransaction, saveTransactionCategorization, linkTransactionToPlannerActual } from "./planner-data";
import type { PlannerSnapshot, RecurringRule, SnapshotBill, SnapshotDebt, SnapshotGoal, SnapshotRecurringExpense, SnapshotHousingBucket, SnapshotIncomeSource } from "./planner-engine-shared";

export interface RawTellerTransaction {
  id: string;
  account_id?: string;
  amount: number | string;
  description?: string;
  details?: { category?: string; counterparty?: { name?: string }; processing_status?: string };
  date?: string;
  status?: string;
  type?: string;
}

export interface BankTransactionRow {
  id: string;
  bankAccountId: string;
  providerTransactionId: string;
  description: string;
  merchant: string | null;
  amount: number;
  postedDate: string | null;
}

export type CategorizationTarget =
  | { kind: "BILL"; billId: string; billName: string }
  | { kind: "DEBT"; debtId: string; debtName: string }
  | { kind: "EXPENSE"; expenseId: string; expenseName: string }
  | { kind: "GOAL"; goalId: string; goalName: string }
  | { kind: "HOUSING"; bucketId: string; bucketLabel: string }
  | { kind: "INCOME"; incomeSourceId: string; incomeSourceName: string }
  | { kind: "CASH_IN" }
  | { kind: "CASH_OUT" }
  | { kind: "UNCATEGORIZED" };

export interface CategorizationSuggestion {
  transactionId: string;
  target: CategorizationTarget;
  confidence: number;
  reason: string;
}

/** Normalize raw Teller-shaped transactions into a canonical row the UI/DB can store. */
export function normalizeTellerTransactions(list: unknown[], fallbackAccountId: string | null): BankTransactionRow[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((t) => t as RawTellerTransaction)
    .map((t) => {
      const amt = typeof t.amount === "number" ? t.amount : Number(t.amount ?? 0);
      if (!Number.isFinite(amt)) return null;
      const rawId = String(t.id ?? "");
      if (!rawId) return null;
      return {
        id: newId(),
        bankAccountId: String(t.account_id ?? fallbackAccountId ?? ""),
        providerTransactionId: rawId,
        description: String(t.description ?? "").trim(),
        merchant: t.details?.counterparty?.name ? String(t.details.counterparty.name).trim() : null,
        amount: Math.round(amt * 100) / 100,
        postedDate: t.date ? String(t.date).slice(0, 10) : null,
      } as BankTransactionRow;
    })
    .filter((x): x is BankTransactionRow => !!x && !!x.bankAccountId);
}

function cleanText(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function tokens(value: string): string[] {
  return cleanText(value).split(" ").filter((t) => t.length >= 3);
}

function jaccardScore(a: string, b: string): number {
  const ta = new Set(tokens(a));
  const tb = new Set(tokens(b));
  if (ta.size === 0 || tb.size === 0) return 0;
  let intersect = 0;
  for (const t of ta) if (tb.has(t)) intersect++;
  const union = ta.size + tb.size - intersect;
  if (union === 0) return 0;
  return intersect / union;
}

function nameContainsScore(desc: string, name: string): number {
  const d = cleanText(desc);
  const n = cleanText(name);
  if (!d || !n) return 0;
  if (d.includes(n)) return 0.9;
  return jaccardScore(d, n);
}

function amountCloseness(txAmount: number, targetAmount: number): number {
  if (targetAmount <= 0) return 0;
  const diff = Math.abs(txAmount) - Math.abs(targetAmount);
  const absDiff = Math.abs(diff);
  const rel = absDiff / Math.max(1, Math.abs(targetAmount));
  if (rel <= 0.02) return 1;
  if (rel <= 0.1) return 0.8;
  if (rel <= 0.25) return 0.5;
  if (rel <= 0.5) return 0.3;
  return 0.1;
}

function parseIso(d: string | null | undefined): Date | null {
  if (!d) return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(d);
  if (!m) return null;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
}

function daysBetween(a: Date, b: Date): number {
  return Math.round((b.getTime() - a.getTime()) / 86400000);
}

function dateWithinRecurringWindow(recurringRule: RecurringRule | undefined, txDate: Date, toleranceDays = 5): number {
  if (!recurringRule) return 0.4;
  const anchor = parseIso(recurringRule.anchorDate);
  if (!anchor) return 0.4;
  switch (recurringRule.type) {
    case "MONTHLY": {
      const day = recurringRule.dayOfMonth ?? anchor.getUTCDate();
      const expected = new Date(Date.UTC(txDate.getUTCFullYear(), txDate.getUTCMonth(), day));
      const diff = Math.abs(daysBetween(expected, txDate));
      return diff <= toleranceDays ? 1 : diff <= toleranceDays * 2 ? 0.5 : 0.2;
    }
    case "WEEKLY":
    case "BIWEEKLY":
    case "EVERY_X_DAYS": {
      const interval =
        recurringRule.type === "WEEKLY"
          ? 7
          : recurringRule.type === "BIWEEKLY"
            ? 14
            : Math.max(1, recurringRule.intervalDays ?? 7);
      const diff = Math.abs(daysBetween(anchor, txDate));
      const off = Math.abs(diff - Math.round(diff / interval) * interval);
      return off <= toleranceDays ? 0.9 : 0.3;
    }
    default:
      return 0.5;
  }
}

interface CandidateTarget {
  target: CategorizationTarget;
  amount: number;
  nameScore: number;
  amountScore: number;
  dateScore: number;
  score: number;
  reason: string;
}

function scoreBills(tx: BankTransactionRow, bills: SnapshotBill[]): CandidateTarget[] {
  if (!bills.length) return [];
  const postedDate = parseIso(tx.postedDate);
  const out: CandidateTarget[] = [];
  for (const bill of bills) {
    const searchText = `${tx.description} ${tx.merchant ?? ""}`;
    const nameScore = nameContainsScore(searchText, bill.name);
    const amountScore = amountCloseness(tx.amount, bill.amountDue || bill.currentAmountDue || 0);
    const dateScore = postedDate ? dateWithinRecurringWindow(bill.recurringRule, postedDate) : 0.4;
    const score = nameScore * 0.55 + amountScore * 0.3 + dateScore * 0.15;
    out.push({
      target: { kind: "BILL", billId: bill.id, billName: bill.name },
      amount: Math.abs(tx.amount),
      nameScore,
      amountScore,
      dateScore,
      score,
      reason: `Bill match on "${bill.name}" · name ${nameScore.toFixed(2)} · amount ${amountScore.toFixed(2)} · date ${dateScore.toFixed(2)}`,
    });
  }
  return out;
}

function scoreExpenses(tx: BankTransactionRow, expenses: SnapshotRecurringExpense[]): CandidateTarget[] {
  if (!expenses.length) return [];
  const postedDate = parseIso(tx.postedDate);
  const out: CandidateTarget[] = [];
  for (const expense of expenses) {
    const searchText = `${tx.description} ${tx.merchant ?? ""} ${expense.categoryLabel ?? ""}`;
    const nameScore = nameContainsScore(searchText, expense.name);
    const amountScore = amountCloseness(tx.amount, expense.amount);
    const dateScore = postedDate ? dateWithinRecurringWindow(expense.recurringRule, postedDate) : 0.4;
    const score = nameScore * 0.5 + amountScore * 0.3 + dateScore * 0.2;
    out.push({
      target: { kind: "EXPENSE", expenseId: expense.id, expenseName: expense.name },
      amount: Math.abs(tx.amount),
      nameScore,
      amountScore,
      dateScore,
      score,
      reason: `Expense match on "${expense.name}" · name ${nameScore.toFixed(2)} · amount ${amountScore.toFixed(2)} · date ${dateScore.toFixed(2)}`,
    });
  }
  return out;
}

function scoreDebts(tx: BankTransactionRow, debts: SnapshotDebt[]): CandidateTarget[] {
  if (!debts.length) return [];
  const out: CandidateTarget[] = [];
  for (const debt of debts) {
    const searchText = `${tx.description} ${tx.merchant ?? ""}`;
    const nameScore = Math.max(
      nameContainsScore(searchText, debt.name),
      debt.lender ? nameContainsScore(searchText, debt.lender) : 0,
    );
    const amountScore = amountCloseness(tx.amount, debt.minimumDue);
    const score = nameScore * 0.65 + amountScore * 0.25 + 0.1;
    out.push({
      target: { kind: "DEBT", debtId: debt.id, debtName: debt.name },
      amount: Math.abs(tx.amount),
      nameScore,
      amountScore,
      dateScore: 0.5,
      score,
      reason: `Debt match on "${debt.name}" · name ${nameScore.toFixed(2)} · amount ${amountScore.toFixed(2)}`,
    });
  }
  return out;
}

function scoreGoals(tx: BankTransactionRow, goals: SnapshotGoal[]): CandidateTarget[] {
  if (!goals.length) return [];
  const out: CandidateTarget[] = [];
  for (const goal of goals) {
    const searchText = `${tx.description} ${tx.merchant ?? ""}`;
    const nameScore = nameContainsScore(searchText, goal.name);
    if (nameScore < 0.5) continue;
    out.push({
      target: { kind: "GOAL", goalId: goal.id, goalName: goal.name },
      amount: Math.abs(tx.amount),
      nameScore,
      amountScore: 0.5,
      dateScore: 0.5,
      score: nameScore * 0.8 + 0.2,
      reason: `Goal match on "${goal.name}" · name ${nameScore.toFixed(2)}`,
    });
  }
  return out;
}

function scoreHousing(tx: BankTransactionRow, buckets: SnapshotHousingBucket[]): CandidateTarget[] {
  if (!buckets.length) return [];
  const out: CandidateTarget[] = [];
  for (const bucket of buckets) {
    const searchText = `${tx.description} ${tx.merchant ?? ""}`;
    const nameScore = nameContainsScore(searchText, bucket.label || "rent housing");
    const amountScore = amountCloseness(tx.amount, bucket.amountDue - bucket.amountPaid);
    const score = nameScore * 0.5 + amountScore * 0.4 + 0.1;
    if (score < 0.45) continue;
    out.push({
      target: { kind: "HOUSING", bucketId: bucket.id, bucketLabel: bucket.label || "Housing" },
      amount: Math.abs(tx.amount),
      nameScore,
      amountScore,
      dateScore: 0.5,
      score,
      reason: `Housing match on "${bucket.label}" · amount ${amountScore.toFixed(2)}`,
    });
  }
  return out;
}

function scoreIncome(tx: BankTransactionRow, incomeSources: SnapshotIncomeSource[]): CandidateTarget[] {
  if (tx.amount <= 0) return [];
  if (!incomeSources.length) return [];
  const out: CandidateTarget[] = [];
  for (const source of incomeSources) {
    const searchText = `${tx.description} ${tx.merchant ?? ""}`;
    const nameScore = Math.max(
      nameContainsScore(searchText, source.name),
      source.payerLabel ? nameContainsScore(searchText, source.payerLabel) : 0,
    );
    if (nameScore < 0.4) continue;
    out.push({
      target: { kind: "INCOME", incomeSourceId: source.id, incomeSourceName: source.name },
      amount: Math.abs(tx.amount),
      nameScore,
      amountScore: 0.6,
      dateScore: 0.6,
      score: nameScore * 0.85 + 0.15,
      reason: `Income match on "${source.name}"`,
    });
  }
  return out;
}

export function categorizeTransaction(tx: BankTransactionRow, snapshot: PlannerSnapshot): CategorizationSuggestion {
  const isCredit = tx.amount > 0;
  const candidates: CandidateTarget[] = [];
  if (isCredit) {
    candidates.push(...scoreIncome(tx, snapshot.incomeSources));
  } else {
    candidates.push(...scoreBills(tx, snapshot.bills));
    candidates.push(...scoreExpenses(tx, snapshot.expenses));
    candidates.push(...scoreDebts(tx, snapshot.debts));
    candidates.push(...scoreHousing(tx, snapshot.housingBuckets));
    candidates.push(...scoreGoals(tx, snapshot.goals));
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  if (!best || best.score < 0.35) {
    return {
      transactionId: tx.id,
      target: isCredit ? { kind: "CASH_IN" } : { kind: "CASH_OUT" },
      confidence: 0.2,
      reason: "No strong planner match; treated as generic cash movement.",
    };
  }
  return {
    transactionId: tx.id,
    target: best.target,
    confidence: Math.min(1, Math.max(0, Math.round(best.score * 100) / 100)),
    reason: best.reason,
  };
}

export function categorizeTransactions(transactions: BankTransactionRow[], snapshot: PlannerSnapshot): CategorizationSuggestion[] {
  return transactions.map((t) => categorizeTransaction(t, snapshot));
}

export async function persistAutoCategorizedTransactions(
  userId: string,
  transactions: BankTransactionRow[],
  snapshot: PlannerSnapshot,
): Promise<{ saved: number; categorized: number; matched: number; asActuals: number }> {
  let saved = 0;
  let categorized = 0;
  let matched = 0;
  let asActuals = 0;
  for (const tx of transactions) {
    try {
      const txId = await upsertBankTransaction(userId, {
        bankAccountId: tx.bankAccountId,
        providerTransactionId: tx.providerTransactionId,
        description: tx.description,
        merchant: tx.merchant ?? undefined,
        amount: tx.amount,
        postedDate: tx.postedDate ?? undefined,
      });
      saved++;
      const suggestion = categorizeTransaction({ ...tx, id: txId }, snapshot);
      const categoryKind =
        suggestion.target.kind === "BILL"
          ? "BILL"
          : suggestion.target.kind === "DEBT"
            ? "DEBT"
            : suggestion.target.kind === "EXPENSE"
              ? "EXPENSE"
              : suggestion.target.kind === "GOAL"
                ? "GOAL"
                : suggestion.target.kind === "HOUSING"
                  ? "HOUSING"
                  : suggestion.target.kind === "INCOME"
                    ? "INCOME"
                    : suggestion.target.kind === "CASH_IN"
                      ? "CASH_IN"
                      : suggestion.target.kind === "CASH_OUT"
                        ? "CASH_OUT"
                        : "CATEGORY";
      await saveTransactionCategorization(userId, {
        transactionId: txId,
        categoryKind,
        billId: suggestion.target.kind === "BILL" ? suggestion.target.billId : null,
        debtId: suggestion.target.kind === "DEBT" ? suggestion.target.debtId : null,
        expenseId: suggestion.target.kind === "EXPENSE" ? suggestion.target.expenseId : null,
        goalId: suggestion.target.kind === "GOAL" ? suggestion.target.goalId : null,
        housingBucketId: suggestion.target.kind === "HOUSING" ? suggestion.target.bucketId : null,
        note: suggestion.reason,
        isUserOverride: false,
      });
      categorized++;
      if (suggestion.confidence >= 0.7) matched++;
      if (suggestion.confidence >= 0.8 && tx.postedDate) {
        const ok = await persistAsPlannerActual(userId, suggestion, tx);
        if (ok) asActuals++;
      }
    } catch {
      // keep going so one bad row does not stall the batch
      continue;
    }
  }
  return { saved, categorized, matched, asActuals };
}

async function persistAsPlannerActual(
  userId: string,
  suggestion: CategorizationSuggestion,
  tx: BankTransactionRow,
): Promise<boolean> {
  switch (suggestion.target.kind) {
    case "BILL":
      return linkTransactionToPlannerActual(userId, tx.id, { kind: "BILL", id: suggestion.target.billId }, tx, "Auto");
    case "DEBT":
      return linkTransactionToPlannerActual(userId, tx.id, { kind: "DEBT", id: suggestion.target.debtId }, tx, "Auto");
    case "EXPENSE":
      return linkTransactionToPlannerActual(userId, tx.id, { kind: "EXPENSE", id: suggestion.target.expenseId }, tx, "Auto");
    case "HOUSING":
      return linkTransactionToPlannerActual(userId, tx.id, { kind: "HOUSING", id: suggestion.target.bucketId }, tx, "Auto");
    default:
      return false;
  }
}
