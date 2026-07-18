import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// Build the control UI into the Neonika dist tree so the gateway HTTP server
// can serve it from dist/control-ui next to the compiled runtime (dist/src).
const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, "../dist/control-ui");

export default defineConfig({
  // Absolute base: the gateway serves the build under /control-ui/* and the SPA
  // index.html under /mission-control/*. Absolute asset paths (/control-ui/assets,
  // /control-ui/fonts) resolve identically from any /mission-control/<view> depth.
  base: "/control-ui/",
  publicDir: path.resolve(here, "public"),
  build: {
    outDir,
    emptyOutDir: true,
    sourcemap: true,
    chunkSizeWarningLimit: 1024,
  },
  server: {
    host: true,
    port: 5173,
    strictPort: false,
    // Dev-only: proxy the live Neonika API so the UI reads real data while
    // developing standalone. Production is served same-origin by the gateway,
    // so this proxy never affects the build.
    proxy: {
      "/api": {
        target: process.env.NEONIKA_PROXY ?? "http://localhost:8797",
        changeOrigin: true,
      },
    },
  },
});
