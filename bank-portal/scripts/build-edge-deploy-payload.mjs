/**
 * Builds JSON payloads for Supabase MCP deploy_edge_function (stdout).
 * Usage: node build-edge-deploy-payload.mjs teller-nonce
 */
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fn = process.argv[2];
const projectId = "wwyyasygbhpbghkozzln";
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "supabase", "functions");

const shared = {
  cors: readFileSync(join(root, "_shared", "cors.ts"), "utf8"),
  supabase: readFileSync(join(root, "_shared", "supabase.ts"), "utf8"),
  teller_fetch: readFileSync(join(root, "_shared", "teller_fetch.ts"), "utf8"),
};

function rewriteImports(src) {
  return src.replaceAll('"../_shared/', '"./_shared/');
}

const bundles = {
  "teller-nonce": {
    name: "teller-nonce",
    verify_jwt: true,
    files: [
      { name: "index.ts", content: rewriteImports(readFileSync(join(root, "teller-nonce", "index.ts"), "utf8")) },
      { name: "_shared/cors.ts", content: shared.cors },
      { name: "_shared/supabase.ts", content: shared.supabase },
    ],
  },
  "teller-data": {
    name: "teller-data",
    verify_jwt: true,
    files: [
      { name: "index.ts", content: rewriteImports(readFileSync(join(root, "teller-data", "index.ts"), "utf8")) },
      { name: "_shared/cors.ts", content: shared.cors },
      { name: "_shared/supabase.ts", content: shared.supabase },
      { name: "_shared/teller_fetch.ts", content: shared.teller_fetch },
    ],
  },
  "teller-enrollment-complete": {
    name: "teller-enrollment-complete",
    verify_jwt: true,
    files: [
      {
        name: "index.ts",
        content: rewriteImports(readFileSync(join(root, "teller-enrollment-complete", "index.ts"), "utf8")),
      },
      { name: "_shared/cors.ts", content: shared.cors },
      { name: "_shared/supabase.ts", content: shared.supabase },
    ],
  },
  "teller-webhook": {
    name: "teller-webhook",
    verify_jwt: false,
    files: [
      { name: "index.ts", content: rewriteImports(readFileSync(join(root, "teller-webhook", "index.ts"), "utf8")) },
      { name: "_shared/cors.ts", content: shared.cors },
      { name: "_shared/supabase.ts", content: shared.supabase },
    ],
  },
};

const b = bundles[fn];
if (!b) {
  console.error("Unknown function:", fn);
  process.exit(1);
}

const out = {
  project_id: projectId,
  name: b.name,
  entrypoint_path: "index.ts",
  verify_jwt: b.verify_jwt,
  files: b.files,
};
const outStr = JSON.stringify(out);
if (process.argv[3]) {
  writeFileSync(process.argv[3], outStr, { encoding: "utf8" });
} else {
  process.stdout.write(outStr);
}
