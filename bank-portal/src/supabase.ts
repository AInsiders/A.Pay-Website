import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL?.trim();
const anon = import.meta.env.VITE_SUPABASE_ANON_KEY?.trim();

/** True when real project keys are set (not dev placeholders). */
export const isSupabaseConfigured = Boolean(url && anon);

/** Non-empty strings required by @supabase/supabase-js; use real keys in auth/API. */
export const resolvedSupabaseUrl = url || "https://configure-your-project.supabase.co";
const resolvedAnon = anon || "sb-publishable-placeholder-not-for-production";

if (!isSupabaseConfigured) {
  console.warn(
    "Supabase env missing: copy .env.example to .env and set VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY. UI loads in preview mode.",
  );
}

export const supabase = createClient(resolvedSupabaseUrl, resolvedAnon, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
    detectSessionInUrl: true,
  },
});

/**
 * Invoke an Edge Function with short retries when the browser fails before HTTP (flaky network, extensions).
 * Does not retry HTTP 4xx/5xx — only fetch-style failures.
 */
export async function invokeEdgeFunction(
  name: string,
  options?: Parameters<(typeof supabase)["functions"]["invoke"]>[1],
): ReturnType<(typeof supabase)["functions"]["invoke"]> {
  const maxAttempts = 4;
  let last: Awaited<ReturnType<(typeof supabase)["functions"]["invoke"]>>;
  for (let i = 0; i < maxAttempts; i++) {
    last = await supabase.functions.invoke(name, options);
    if (!last.error) return last;
    const msg = String(
      last.error && typeof last.error === "object" && "message" in last.error
        ? (last.error as { message?: string }).message
        : last.error,
    );
    const transient = /failed to send a request to the edge function|failed to fetch|networkerror|load failed|aborted|timeout|ecconn|econnreset|socket|timed out/i.test(
      msg,
    );
    if (!transient || i === maxAttempts - 1) return last;
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }
  return last!;
}
