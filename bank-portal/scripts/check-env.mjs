/**
 * Validates bank-portal/.env for local dev. Run: npm run check:env
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const envPath = join(root, ".env");

const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const optional = ["VITE_TELLER_APP_ID", "VITE_TELLER_ENVIRONMENT"];

function parseEnv(text) {
  /** @type {Record<string, string>} */
  const out = {};
  for (const line of text.split("\n")) {
    const t = line.trim();
    if (!t || t.startsWith("#")) continue;
    const eq = t.indexOf("=");
    if (eq === -1) continue;
    const k = t.slice(0, eq).trim();
    let v = t.slice(eq + 1).trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[k] = v;
  }
  return out;
}

if (!existsSync(envPath)) {
  console.error(`Missing ${envPath}\nCopy .env.example to .env and add your Supabase keys.`);
  process.exit(1);
}

let env;
try {
  env = parseEnv(readFileSync(envPath, "utf8"));
} catch (e) {
  console.error("Could not read .env:", e);
  process.exit(1);
}

let ok = true;
for (const k of required) {
  const v = env[k]?.trim();
  if (!v || v.includes("YOUR_") || v === "your_anon_public_key") {
    console.error(`✗ ${k} is missing or still a placeholder.`);
    ok = false;
  } else {
    console.log(`✓ ${k}`);
  }
}

for (const k of optional) {
  const v = env[k]?.trim();
  if (!v) console.log(`○ ${k} (optional, needed for Teller bank link)`);
  else console.log(`✓ ${k}`);
}

if (!ok) {
  console.error("\nGet URL + anon key: Supabase → Project Settings → API.");
  process.exit(1);
}

console.log("\nEnv looks good for sign-in and API. Use the anon key only — never service_role in the client.");
