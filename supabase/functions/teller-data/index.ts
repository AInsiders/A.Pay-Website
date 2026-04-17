import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { supabaseServiceClient, supabaseUserClient } from "../_shared/supabase.ts";
import { tellerFetch } from "../_shared/teller_fetch.ts";

type ActionBody = {
  action?: string;
  accountId?: string;
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const userClient = supabaseUserClient(req);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse({ error: "Unauthorized" }, 401);
  }

  let body: ActionBody;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
  }

  const action = body.action?.trim();
  if (action !== "accounts" && action !== "transactions") {
    return jsonResponse({ error: "Unsupported action" }, 400);
  }

  const admin = supabaseServiceClient();
  const { data: row, error: rowErr } = await admin
    .from("teller_enrollments")
    .select("access_token")
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (rowErr) {
    return jsonResponse({ error: rowErr.message }, 500);
  }
  if (!row?.access_token) {
    return jsonResponse({ error: "No bank connection. Run Teller Connect first." }, 400);
  }

  const token = row.access_token as string;

  if (action === "accounts") {
    const res = await tellerFetch("/accounts", token);
    const text = await res.text();
    if (!res.ok) {
      return jsonResponse({ error: `Teller accounts failed (${res.status}): ${text}` }, 502);
    }
    try {
      const accounts = JSON.parse(text);
      return jsonResponse({ accounts });
    } catch {
      return jsonResponse({ error: "Invalid JSON from Teller" }, 502);
    }
  }

  const accountId = body.accountId?.trim();
  if (!accountId) {
    return jsonResponse({ error: "Missing accountId" }, 400);
  }

  const path = `/accounts/${encodeURIComponent(accountId)}/transactions?count=50`;
  const res = await tellerFetch(path, token);
  const text = await res.text();
  if (!res.ok) {
    return jsonResponse({ error: `Teller transactions failed (${res.status}): ${text}` }, 502);
  }
  try {
    const transactions = JSON.parse(text);
    return jsonResponse({ transactions });
  } catch {
    return jsonResponse({ error: "Invalid JSON from Teller" }, 502);
  }
});
