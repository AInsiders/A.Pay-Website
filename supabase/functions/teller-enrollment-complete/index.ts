import { verify } from "npm:@noble/ed25519@1.7.3";
import { corsHeadersForRequest, jsonResponse, preflightResponse } from "../_shared/cors.ts";
import { supabaseServiceClient, supabaseUserClient } from "../_shared/supabase.ts";

const FN = "teller-enrollment-complete";

/** Logs to Supabase Edge Function logs (Dashboard → Edge Functions → [function] → Logs). */
function logEvent(phase: string, detail: Record<string, unknown>) {
  console.error(JSON.stringify({ fn: FN, phase, ...detail }));
}

function jsonError(
  status: number,
  message: string,
  code: string,
  logDetail?: Record<string, unknown>,
  req?: Request,
) {
  logEvent("response", { status, code, message, ...logDetail });
  return new Response(JSON.stringify({ error: message, code }), {
    status,
    headers: {
      ...corsHeadersForRequest(req),
      "Content-Type": "application/json",
      "X-Teller-Error-Code": code,
    },
  });
}

type Body = {
  nonce?: string;
  /** Must match TellerConnect `environment` (sandbox | development | production). */
  environment?: string;
  payload?: {
    accessToken?: string;
    user?: { id?: string };
    enrollment?: { id?: string; institution?: { name?: string } };
    signatures?: string[];
  };
};

function decodePublicKey(raw: string): Uint8Array {
  let t = raw.trim();
  // Accept PEM blocks by stripping headers/footers and whitespace.
  if (t.includes("BEGIN") && t.includes("END")) {
    t = t
      .replace(/-----BEGIN[^-]+-----/g, "")
      .replace(/-----END[^-]+-----/g, "")
      .replace(/\s+/g, "")
      .trim();
  }
  if (/^[0-9a-fA-F]+$/.test(t) && t.length === 64) {
    return Uint8Array.from(t.match(/.{2}/g)!.map((b) => parseInt(b, 16)));
  }
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeSignature(s: string): Uint8Array {
  const t = s.trim();
  const bin = atob(t);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function parsePublicKeys(): Uint8Array[] {
  const multi = Deno.env.get("TELLER_TOKEN_SIGNING_PUBLIC_KEYS");
  const single = Deno.env.get("TELLER_TOKEN_SIGNING_PUBLIC_KEY");
  const raw = multi?.trim()
    ? multi.split(",").map((x) => x.trim()).filter(Boolean)
    : single?.trim()
    ? [single.trim()]
    : [];
  const out: Uint8Array[] = [];
  for (const r of raw) {
    try {
      const k = decodePublicKey(r);
      if (k.length === 32) out.push(k);
      else logEvent("bad_signing_key", { reason: "wrong_length", length: k.length });
    } catch (e) {
      logEvent("bad_signing_key", {
        reason: "decode_failed",
        message: e instanceof Error ? e.message : String(e),
      });
    }
  }
  return out;
}

async function sha256Bytes(dotted: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(dotted);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return preflightResponse(req);
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405, req);
  }

  try {
    return await handlePost(req);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const stack = e instanceof Error ? e.stack : undefined;
    logEvent("unhandled", { message: msg, stack });
    return jsonError(
      500,
      "Unexpected error — check Edge Function logs for details",
      "unhandled",
      { originalMessage: msg },
      req,
    );
  }
});

async function handlePost(req: Request): Promise<Response> {
  const userClient = supabaseUserClient(req);
  const { data: userData, error: userErr } = await userClient.auth.getUser();
  if (userErr || !userData.user) {
    return jsonResponse({ error: "Unauthorized" }, 401, req);
  }

  const publicKeys = parsePublicKeys();
  if (publicKeys.length === 0) {
    return jsonError(
      503,
      "TELLER_TOKEN_SIGNING_PUBLIC_KEY not configured",
      "missing_signing_key",
      undefined,
      req,
    );
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400, req);
  }

  const nonce = body.nonce?.trim();
  const environment = (body.environment ?? "development").trim();
  const payload = body.payload;
  const accessToken = payload?.accessToken?.trim();
  const userId = payload?.user?.id?.trim();
  const enrollmentId = payload?.enrollment?.id?.trim();
  const signatures = payload?.signatures ?? [];

  if (!nonce || !accessToken || !userId || !enrollmentId) {
    return jsonResponse({
      error: "Missing nonce, accessToken, userId, or enrollmentId",
    }, 400, req);
  }

  if (!Array.isArray(signatures) || signatures.length === 0) {
    return jsonResponse({ error: "No signatures to verify" }, 400, req);
  }

  const admin = supabaseServiceClient();
  const { data: nonceRow, error: nonceErr } = await admin
    .from("teller_nonces")
    .select("nonce, expires_at")
    .eq("nonce", nonce)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (nonceErr) {
    return jsonError(500, nonceErr.message, "nonce_lookup_failed", {
      supabase: {
        code: nonceErr.code,
        details: nonceErr.details,
        hint: nonceErr.hint,
      },
    }, req);
  }
  if (!nonceRow) {
    return jsonResponse({ error: "Invalid, expired, or already used nonce" }, 400, req);
  }
  if (new Date(nonceRow.expires_at).getTime() < Date.now()) {
    await admin.from("teller_nonces").delete().eq("nonce", nonce);
    return jsonResponse({ error: "Nonce expired" }, 400, req);
  }

  const dotted = `${nonce}.${accessToken}.${userId}.${enrollmentId}.${environment}`;
  const msgUtf8 = new TextEncoder().encode(dotted);
  const msgSha256 = await sha256Bytes(dotted);

  let verified = false;
  for (const sigStr of signatures) {
    let sigBytes: Uint8Array;
    try {
      sigBytes = decodeSignature(sigStr);
    } catch {
      continue;
    }
    for (const pub of publicKeys) {
      try {
        if (verify(sigBytes, msgUtf8, pub) || verify(sigBytes, msgSha256, pub)) {
          verified = true;
          break;
        }
      } catch {
        // try next
      }
    }
    if (verified) break;
  }

  if (!verified) {
    logEvent("signature_verify", {
      outcome: "failed",
      keyCount: publicKeys.length,
      sigCount: signatures.length,
    });
    return jsonError(401, "Signature verification failed", "signature_verify_failed", undefined, req);
  }

  await admin.from("teller_nonces").delete().eq("nonce", nonce);

  const institutionName = payload?.enrollment?.institution?.name ?? null;
  const { error: upsertErr } = await admin.from("teller_enrollments").upsert(
    {
      user_id: userData.user.id,
      enrollment_id: enrollmentId,
      access_token: accessToken,
      environment,
      institution_name: institutionName,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id" },
  );

  if (upsertErr) {
    return jsonError(500, upsertErr.message, "enrollment_upsert_failed", {
      supabase: {
        code: upsertErr.code,
        details: upsertErr.details,
        hint: upsertErr.hint,
      },
    }, req);
  }

  logEvent("enrollment_saved", { userIdSuffix: userData.user.id.slice(-8) });
  return jsonResponse({ ok: true }, 200, req);
}
