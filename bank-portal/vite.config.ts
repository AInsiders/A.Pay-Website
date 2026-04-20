import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import legacy from "@vitejs/plugin-legacy";

/** Config file lives in bank-portal/ — pin root + env so `.env` loads here even if `vite` is run from the repo root. */
const portalRoot = path.dirname(fileURLToPath(import.meta.url));

// For GitHub Pages project sites, set VITE_BASE=/your-repo-name/ (leading and trailing slashes).
const raw = process.env.VITE_BASE;
// Default to relative assets so the site works on GitHub Pages project sites
// even when VITE_BASE is not set.
const base = raw && raw.trim() !== "" ? raw : "./";

export default defineConfig({
  root: portalRoot,
  envDir: portalRoot,
  base,
  plugins: [
    legacy({
      // Helps “some browsers” that don’t fully support modern ESM bundles.
      targets: ["defaults", "not IE 11"],
    }),
  ],
  build: {
    // Project root (parent of bank-portal/): index.html + assets/ live next to README, supabase/, etc.
    outDir: "..",
    emptyOutDir: false,
  },
});
