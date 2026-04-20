import { verify } from "npm:@noble/ed25519@1.7.3";
import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { supabaseServiceClient, supabaseUserClient } from "../_shared/supabase.ts";

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
  const t = raw.trim();
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
  return raw.map(decodePublicKey).filter((k) => k.length === 32);
}

async function sha256Bytes(dotted: string): Promise<Uint8Array> {
  const data = new TextEncoder().encode(dotted);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return new Uint8Array(buf);
}

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

  const publicKeys = parsePublicKeys();
  if (publicKeys.length === 0) {
    return jsonResponse({ error: "TELLER_TOKEN_SIGNING_PUBLIC_KEY not configured" }, 503);
  }

  let body: Body;
  try {
    body = await req.json();
  } catch {
    return jsonResponse({ error: "Invalid JSON" }, 400);
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
    }, 400);
  }

  if (!Array.isArray(signatures) || signatures.length === 0) {
    return jsonResponse({ error: "No signatures to verify" }, 400);
  }

  const admin = supabaseServiceClient();
  const { data: nonceRow, error: nonceErr } = await admin
    .from("teller_nonces")
    .select("nonce, expires_at")
    .eq("nonce", nonce)
    .eq("user_id", userData.user.id)
    .maybeSingle();

  if (nonceErr) {
    return jsonResponse({ error: nonceErr.message }, 500);
  }
  if (!nonceRow) {
    return jsonResponse({ error: "Invalid, expired, or already used nonce" }, 400);
  }
  if (new Date(nonceRow.expires_at).getTime() < Date.now()) {
    await admin.from("teller_nonces").delete().eq("nonce", nonce);
    return jsonResponse({ error: "Nonce expired" }, 400);
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
    return jsonResponse({ error: "Signature verification failed" }, 401);
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
    return jsonResponse({ error: upsertErr.message }, 500);
  }

  return jsonResponse({ ok: true });
});
