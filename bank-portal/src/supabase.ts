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

function edgeInvokeErrorMessage(err: unknown): string {
  return String(
    err && typeof err === "object" && "message" in err
      ? (err as { message?: string }).message
      : err,
  );
}

/**
 * Direct POST to `/functions/v1/:name` — when `functions.invoke` fails with the generic
 * "Failed to send a request to the Edge Function", the real cause is often HTTP 404 (function
 * not deployed). Browsers may hide that behind CORS for `invoke`; raw fetch often still reads the JSON body.
 */
async function invokeEdgeFunctionViaFetch(
  name: string,
  options?: Parameters<(typeof supabase)["functions"]["invoke"]>[1],
): ReturnType<(typeof supabase)["functions"]["invoke"]> {
  const base = resolvedSupabaseUrl.replace(/\/$/, "");
  const url = `${base}/functions/v1/${encodeURIComponent(name)}`;
  const userHeaders = options?.headers;
  const merged: Record<string, string> = {
    apikey: resolvedAnon,
  };
  if (userHeaders && typeof userHeaders === "object" && !(userHeaders instanceof Headers)) {
    for (const [k, v] of Object.entries(userHeaders as Record<string, string>)) {
      if (v !== undefined && v !== null) merged[k] = String(v);
    }
  } else if (userHeaders instanceof Headers) {
    userHeaders.forEach((v, k) => {
      merged[k] = v;
    });
  }
  if (!merged["Content-Type"] && !merged["content-type"]) {
    merged["Content-Type"] = "application/json";
  }

  const timeoutMs = options?.timeout ?? 60_000;
  const ctrl = new AbortController();
  const tid = setTimeout(() => ctrl.abort(), timeoutMs);
  let body: string | undefined;
  const rawBody = options?.body;
  if (rawBody === undefined) body = undefined;
  else if (typeof rawBody === "string") body = rawBody;
  else body = JSON.stringify(rawBody);

  try {
    const res = await fetch(url, {
      method: (options?.method as string) || "POST",
      headers: merged,
      body,
      signal: options?.signal ?? ctrl.signal,
    });
    const text = await res.text();
    let parsed: unknown = null;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 500) };
      }
    }

    if (!res.ok) {
      let hint = "";
      if (res.status === 404) {
        hint = ` Function not found on this project — deploy with: supabase functions deploy ${name} --no-verify-jwt`;
      }
      const fromJson =
        parsed &&
        typeof parsed === "object" &&
        parsed !== null &&
        "error" in parsed &&
        typeof (parsed as { error?: unknown }).error === "string"
          ? (parsed as { error: string }).error
          : null;
      const fromMsg =
        parsed &&
        typeof parsed === "object" &&
        parsed !== null &&
        "message" in parsed &&
        typeof (parsed as { message?: unknown }).message === "string"
          ? (parsed as { message: string }).message
          : null;
      const piece = fromJson || fromMsg || text.slice(0, 400);
      return {
        data: null,
        error: new Error(
          piece ? `${piece} (HTTP ${res.status})${hint}` : `HTTP ${res.status}${hint}`,
        ) as never,
      };
    }

    return { data: parsed as never, error: null };
  } catch (e) {
    return { data: null, error: e as never };
  } finally {
    clearTimeout(tid);
  }
}

/**
 * Invoke an Edge Function with short retries when the browser fails before HTTP (flaky network, extensions).
 * Does not retry HTTP 4xx/5xx — only fetch-style failures.
 *
 * If `invoke` still reports a generic send failure after retries, falls back to a plain `fetch` once so
 * undeployed functions (404) and other HTTP errors surface clearly.
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
    const msg = edgeInvokeErrorMessage(last.error);
    const transient = /failed to send a request to the edge function|failed to fetch|networkerror|load failed|aborted|timeout|ecconn|econnreset|socket|timed out/i.test(
      msg,
    );
    if (!transient || i === maxAttempts - 1) break;
    await new Promise((r) => setTimeout(r, 250 * (i + 1)));
  }

  const lastMsg = edgeInvokeErrorMessage(last!.error);
  if (
    isSupabaseConfigured &&
    /failed to send a request to the edge function/i.test(lastMsg)
  ) {
    const viaFetch = await invokeEdgeFunctionViaFetch(name, options);
    if (!viaFetch.error) return viaFetch;
    const fetchMsg = edgeInvokeErrorMessage(viaFetch.error);
    if (!/aborted|failed to fetch/i.test(fetchMsg)) {
      return viaFetch;
    }
  }

  return last!;
}
