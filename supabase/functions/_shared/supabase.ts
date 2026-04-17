import { createClient, type SupabaseClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

export function supabaseUserClient(req: Request): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const anon = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
  const authorization = req.headers.get("Authorization") ?? "";
  return createClient(url, anon, {
    global: { headers: { Authorization: authorization } },
  });
}

export function supabaseServiceClient(): SupabaseClient {
  const url = Deno.env.get("SUPABASE_URL") ?? "";
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  return createClient(url, key);
}
