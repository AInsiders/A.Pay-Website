import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** True when real project keys are set (not dev placeholders). */
export const isSupabaseConfigured = Boolean(url && anon);

/** Non-empty strings required by @supabase/supabase-js; use real keys in .env for auth/API. */
const resolvedUrl = url || "https://configure-your-project.supabase.co";
const resolvedAnon = anon || "sb-publishable-placeholder-not-for-production";

if (!isSupabaseConfigured) {
  console.warn(
    "Supabase env missing: copy .env.example to .env and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. UI loads in preview mode.",
  );
}

export const supabase = createClient(resolvedUrl, resolvedAnon);
