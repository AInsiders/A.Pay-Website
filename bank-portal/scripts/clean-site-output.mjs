/**
 * Removes previous production output from the project root (parent of bank-portal/)
 * so we can rebuild without using emptyOutDir on the whole repo.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..", "..");

for (const name of ["index.html", "assets", ".nojekyll"]) {
  const p = path.join(root, name);
  try {
    const st = fs.statSync(p);
    if (st.isDirectory()) fs.rmSync(p, { recursive: true, force: true });
    else fs.unlinkSync(p);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
  }
}
