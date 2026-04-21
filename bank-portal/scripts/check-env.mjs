import fs from "node:fs";
import path from "node:path";

const envPath = path.resolve(process.cwd(), ".env");
const examplePath = path.resolve(process.cwd(), ".env.example");

function readEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return {};
  const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
  const out = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const idx = trimmed.indexOf("=");
    if (idx === -1) continue;
    const key = trimmed.slice(0, idx).trim();
    let value = trimmed.slice(idx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

const env = readEnvFile(envPath);
const example = readEnvFile(examplePath);
const required = ["VITE_SUPABASE_URL", "VITE_SUPABASE_ANON_KEY"];
const optional = ["VITE_TELLER_APP_ID", "VITE_TELLER_ENVIRONMENT", "VITE_BASE"];

const missing = required.filter((key) => !(env[key] || process.env[key]));

console.log("A.Pay Website env check");
console.log(`- .env present: ${fs.existsSync(envPath) ? "yes" : "no"}`);
console.log(`- .env.example present: ${fs.existsSync(examplePath) ? "yes" : "no"}`);

for (const key of required) {
  const source = env[key] ? ".env" : process.env[key] ? "process env" : "missing";
  console.log(`- ${key}: ${source}`);
}

for (const key of optional) {
  const source = env[key] ? ".env" : process.env[key] ? "process env" : example[key] ? ".env.example only" : "not set";
  console.log(`- ${key}: ${source}`);
}

if (missing.length) {
  console.error(`Missing required env values: ${missing.join(", ")}`);
  process.exit(1);
}

console.log("Env looks good.");
