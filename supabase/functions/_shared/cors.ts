/**
 * CORS for browser calls from static hosts (GitHub Pages, localhost).
 *
 * When the browser sends `Origin: https://user.github.io`, echoing that origin (instead of `*`)
 * avoids failures if the client uses credentialed fetch or strict CORS checks. Unknown origins still
 * get `*` so curl and server-to-server calls work.
 *
 * Gateway errors (e.g. JWT verify before your handler) still omit these headers — deploy Teller
 * functions with `--no-verify-jwt` per SETUP.md.
 */

const ALLOW_HEADERS =
  "authorization, x-client-info, apikey, content-type, x-supabase-authorization, accept, prefer";

function parseExtraOrigins(): string[] {
  const raw = Deno.env.get("ALLOW_APP_ORIGINS")?.trim();
  if (!raw) return [];
  return raw.split(",").map((s) => s.trim()).filter(Boolean);
}

/** Returns Access-Control-Allow-Origin (and related) for this request. */
export function corsHeadersForRequest(req: Request | undefined): Record<string, string> {
  const base: Record<string, string> = {
    "Access-Control-Allow-Headers": ALLOW_HEADERS,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Max-Age": "86400",
  };

  const origin = req?.headers.get("Origin")?.trim() ?? "";
  if (!origin) {
    return { ...base, "Access-Control-Allow-Origin": "*" };
  }

  const extra = parseExtraOrigins();
  const githubPages = /^https:\/\/[a-z0-9.-]+\.github\.io$/i.test(origin);
  const localhost =
    /^http:\/\/localhost(?::\d+)?$/i.test(origin) ||
    /^http:\/\/127\.0\.0\.1(?::\d+)?$/i.test(origin);
  const allowed = githubPages || localhost || extra.includes(origin);

  if (allowed) {
    return {
      ...base,
      "Access-Control-Allow-Origin": origin,
      Vary: "Origin",
    };
  }

  return { ...base, "Access-Control-Allow-Origin": "*" };
}

/** @deprecated Prefer corsHeadersForRequest(req) so GitHub Pages origins are echoed. */
export const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": ALLOW_HEADERS,
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Max-Age": "86400",
};

export function preflightResponse(req: Request): Response {
  return new Response(null, { status: 204, headers: corsHeadersForRequest(req) });
}

export function jsonResponse(body: unknown, status = 200, req?: Request) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeadersForRequest(req), "Content-Type": "application/json" },
  });
}
