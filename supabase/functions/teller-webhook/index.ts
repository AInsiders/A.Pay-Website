import { corsHeaders, jsonResponse } from "../_shared/cors.ts";
import { supabaseServiceClient } from "../_shared/supabase.ts";

async function hmacSha256Hex(secret: string, message: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(message));
  const bytes = new Uint8Array(sig);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function hexToBytes(hexStr: string): Uint8Array {
  const pairs = hexStr.trim().match(/.{2}/g);
  if (!pairs) throw new Error("bad hex");
  return Uint8Array.from(pairs.map((b) => parseInt(b, 16)));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a[i] ^ b[i];
  return out === 0;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonResponse({ error: "Method not allowed" }, 405);
  }

  const rawSecrets = Deno.env.get("TELLER_WEBHOOK_SIGNING_SECRETS")?.trim()
    ? Deno.env.get("TELLER_WEBHOOK_SIGNING_SECRETS")!.split(",").map((s) => s.trim()).filter(Boolean)
    : Deno.env.get("TELLER_WEBHOOK_SIGNING_SECRET")?.trim()
    ? [Deno.env.get("TELLER_WEBHOOK_SIGNING_SECRET")!.trim()]
    : [];

  if (rawSecrets.length === 0) {
    return jsonResponse({ error: "Webhook signing secret not configured" }, 503);
  }

  const sigHeader = req.headers.get("teller-signature") ?? "";
  const m = /^t=(\d+),/.exec(sigHeader);
  if (!m) {
    return jsonResponse({ error: "Missing Teller-Signature" }, 400);
  }
  const t = parseInt(m[1], 10);
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - t) > 180) {
    return jsonResponse({ error: "Stale signature timestamp" }, 400);
  }

  const bodyStr = await req.text();
  const signedMessage = `${t}.${bodyStr}`;

  const v1Sigs = [...sigHeader.matchAll(/v1=([^,]+)/g)].map((x) => x[1].trim());
  if (v1Sigs.length === 0) {
    return jsonResponse({ error: "No v1 signatures" }, 400);
  }

  let matched = false;
  for (const secret of rawSecrets) {
    const expectedHex = await hmacSha256Hex(secret, signedMessage);
    let expectedBytes: Uint8Array;
    try {
      expectedBytes = hexToBytes(expectedHex);
    } catch {
      continue;
    }
    for (const v1 of v1Sigs) {
      try {
        const candidate = hexToBytes(v1);
        if (timingSafeEqualBytes(expectedBytes, candidate)) {
          matched = true;
          break;
        }
      } catch {
        // continue
      }
    }
    if (matched) break;
  }

  if (!matched) {
    return jsonResponse({ error: "Invalid signature" }, 401);
  }

  let payload: { type?: string; payload?: { enrollment_id?: string } };
  try {
    payload = JSON.parse(bodyStr);
  } catch {
    return jsonResponse({ error: "Invalid JSON body" }, 400);
  }

  if (payload.type === "enrollment.disconnected") {
    const enrollmentId = payload.payload?.enrollment_id;
    if (enrollmentId) {
      const admin = supabaseServiceClient();
      await admin.from("teller_enrollments").delete().eq("enrollment_id", enrollmentId);
    }
  }

  return jsonResponse({ received: true });
});
