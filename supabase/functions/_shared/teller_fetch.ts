/**
 * Calls Teller HTTP API with access token (HTTP Basic) and optional mTLS.
 * Sandbox can work without a client cert; development/production require Teller-issued PEMs.
 */
export async function tellerFetch(path: string, accessToken: string, init?: RequestInit): Promise<Response> {
  const basic = btoa(`${accessToken}:`);
  const cert = Deno.env.get("TELLER_CERT_PEM")?.trim();
  const key = Deno.env.get("TELLER_KEY_PEM")?.trim();
  const client = cert && key ? Deno.createHttpClient({ cert, key }) : undefined;
  const url = `https://api.teller.io${path.startsWith("/") ? "" : "/"}${path}`;
  try {
    return await fetch(url, {
      ...init,
      client,
      headers: {
        ...(init?.headers ?? {}),
        Authorization: `Basic ${basic}`,
        Accept: "application/json",
      },
    });
  } finally {
    if (client) client.close();
  }
}
