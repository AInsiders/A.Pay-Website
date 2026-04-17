import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { supabaseServiceClient, supabaseUserClient } from "../_shared/supabase.ts";

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
    return jsonResponse({ error: insErr.message }, 500);
  }

  return jsonResponse({ nonce });
});
