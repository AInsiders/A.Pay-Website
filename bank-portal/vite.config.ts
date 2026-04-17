import { defineConfig } from "vite";

// For GitHub Pages project sites, set VITE_BASE=/your-repo-name/ (leading and trailing slashes).
const raw = process.env.VITE_BASE;
const base = raw && raw.trim() !== "" ? raw : "/";

export default defineConfig({
  base,
  build: {
    // Project root (parent of bank-portal/): index.html + assets/ live next to README, supabase/, etc.
    outDir: "..",
    emptyOutDir: false,
  },
});
