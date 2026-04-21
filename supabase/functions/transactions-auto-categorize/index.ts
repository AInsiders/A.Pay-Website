import { jsonResponse, preflightResponse } from "../_shared/cors.ts";
import { supabaseServiceClient, supabaseUserClient } from "../_shared/supabase.ts";

/**
 * Applies per-user category rules to bank transactions that do not already have a
 * manual (`is_user_override = true`) categorization.
 *
 * Body (optional):
 *  { "transactionIds": string[] } — limit to these tx ids; else all tx for user.
 *
 * Rule matching (priority ascending):
 *  MERCHANT_CONTAINS    — case-insensitive substring match on merchant/description
 *  DESCRIPTION_CONTAINS — case-insensitive substring match on description
 *  AMOUNT_EQUALS        — exact posted amount match
 *  RECURRING            — always applies (fallback)
 */

interface Rule {
  id: string;
  name: string;
  matcher_type: string;
  matcher_value: string;
  target_kind: string;
  target_category_id: string | null;
  target_bill_id: string | null;
  target_debt_id: string | null;
  target_expense_id: string | null;
  target_custom_label: string | null;
  priority: number;
}

interface TxRow {
  id: string;
  description: string | null;
  merchant: string | null;
  amount: number;
}

function ruleMatches(rule: Rule, tx: TxRow): boolean {
  const needle = (rule.matcher_value ?? "").trim().toLowerCase();
  if (!needle && rule.matcher_type !== "RECURRING") return false;
  const merchant = (tx.merchant ?? "").toLowerCase();
  const description = (tx.description ?? "").toLowerCase();
  switch (rule.matcher_type) {
    case "MERCHANT_CONTAINS":
      return merchant.includes(needle) || description.includes(needle);
    case "DESCRIPTION_CONTAINS":
      return description.includes(needle);
    case "AMOUNT_EQUALS":
      return Number(rule.matcher_value) === Number(tx.amount);
    case "RECURRING":
      return true;
    default:
      return false;
  }
}

function categorizationFromRule(
  userId: string,
  transactionId: string,
  rule: Rule,
) {
  return {
    user_id: userId,
    transaction_id: transactionId,
    category_kind: rule.target_kind ?? "CATEGORY",
    user_category_id: rule.target_category_id,
    custom_label_id: rule.target_custom_label,
    bill_id: rule.target_bill_id,
    debt_id: rule.target_debt_id,
    expense_id: rule.target_expense_id,
    is_user_override: false,
    source_rule_id: rule.id,
    confidence: 0.85,
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return preflightResponse(req);
  if (req.method !== "POST") return jsonResponse({ error: "Method not allowed" }, 405, req);

  const userClient = supabaseUserClient(req);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse({ error: "Unauthorized" }, 401, req);
  }
  const userId = userData.user.id;

  let body: { transactionIds?: string[] } = {};
  try {
    body = await req.json();
  } catch {
    /* no body */
  }

  const admin = supabaseServiceClient();

  // 1. Load rules ordered by priority (lowest number first = highest priority).
  const { data: ruleRows, error: ruleErr } = await admin
    .from("category_rules")
    .select("*")
    .eq("user_id", userId)
    .eq("is_enabled", true)
    .order("priority", { ascending: true });
  if (ruleErr) return jsonResponse({ error: ruleErr.message }, 500, req);
  const rules = (ruleRows ?? []) as Rule[];
  if (rules.length === 0) {
    return jsonResponse({ categorized: 0, skipped: 0, reason: "no_rules" }, 200, req);
  }

  // 2. Load transactions (optionally scoped to ids). Skip user-overridden categorizations.
  let txQuery = admin
    .from("bank_transactions")
    .select("id, description, merchant, amount")
    .eq("user_id", userId);
  if (body.transactionIds && body.transactionIds.length > 0) {
    txQuery = txQuery.in("id", body.transactionIds);
  }
  const { data: txRows, error: txErr } = await txQuery;
  if (txErr) return jsonResponse({ error: txErr.message }, 500, req);
  const txs = (txRows ?? []) as TxRow[];

  const { data: existing, error: existErr } = await admin
    .from("transaction_categorizations")
    .select("transaction_id, is_user_override")
    .eq("user_id", userId);
  if (existErr) return jsonResponse({ error: existErr.message }, 500, req);
  const overrideSet = new Set(
    (existing ?? [])
      .filter((r) => (r as { is_user_override: boolean }).is_user_override)
      .map((r) => (r as { transaction_id: string }).transaction_id),
  );

  const toUpsert: ReturnType<typeof categorizationFromRule>[] = [];
  let skipped = 0;

  for (const tx of txs) {
    if (overrideSet.has(tx.id)) {
      skipped++;
      continue;
    }
    const winner = rules.find((r) => ruleMatches(r, tx));
    if (!winner) {
      skipped++;
      continue;
    }
    toUpsert.push(categorizationFromRule(userId, tx.id, winner));
  }

  if (toUpsert.length > 0) {
    const { error: upsertErr } = await admin
      .from("transaction_categorizations")
      .upsert(toUpsert, { onConflict: "user_id,transaction_id" });
    if (upsertErr) return jsonResponse({ error: upsertErr.message }, 500, req);
  }

  return jsonResponse({
    categorized: toUpsert.length,
    skipped,
    total: txs.length,
    rules: rules.length,
  }, 200, req);
});
