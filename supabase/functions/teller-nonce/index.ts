import { jsonResponse, preflightResponse } from "../_shared/cors.ts";
import { supabaseServiceClient, supabaseUserClient } from "../_shared/supabase.ts";

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, req);
  }

  const userClient = supabaseUserClient(req);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse({ error: "Unauthorized" }, 401, req);
  }

  const bytes = crypto.getRandomValues(new Uint8Array(32));
  const nonce = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");

  const admin = supabaseServiceClient();
  const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
  const { error: insErr } = await admin.from("teller_nonces").insert({
    nonce,
    user_id: userData.user.id,
    expires_at: expires,
  });
  if (insErr) {
    return jsonResponse({ error: insErr.message }, 500, req);
  }

  return jsonResponse({ nonce }, 200, req);
});
