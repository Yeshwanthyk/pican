import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";
import { resolve } from "node:path";

// Builds the static export snapshot bundle as a single self-contained IIFE.
// The output (dist-export/export.js) is inlined verbatim into a <script> tag by
// internal/ui/export.go, alongside the vendor marked/highlight.js globals it
// reads from window. No code splitting, no manifest, no dynamic imports — the
// snapshot must run from a single file with no server.
//
// The svelte plugin is required so the export bundle can compile the SAME
// Svelte components the live app uses (Svelte migration, see
// docs/dev/svelte-migration-plan.md). Components carry no <style> blocks (all
// CSS lives in internal/ui/embedded/styles/session.css), so no CSS chunk is
// emitted — the snapshot stays a single JS file. TestExportBundleIsSelfContained
// guards against any live-only module leaking into this graph.
export default defineConfig({
  plugins: [svelte({ emitCss: false })],
  resolve: {
    alias: {
      // SessionDataModel only needs the pure buildSessionLookups export. Keep
      // the static bundle off session-data.ts, whose live decode path uses the
      // application Effect runtime bridge.
      [resolve(__dirname, "src/session/data/session-data.js")]: resolve(
        __dirname,
        "src/export/export-session-data.js",
      ),
      [resolve(__dirname, "src/session/ui/toggle-state.js")]: resolve(
        __dirname,
        "src/export/export-toggle-state.js",
      ),
    },
  },
  build: {
    outDir: "dist-export",
    emptyOutDir: true,
    lib: {
      entry: resolve(__dirname, "src/export/export-entry.ts"),
      formats: ["iife"],
      name: "PiExport",
      fileName: () => "export.js",
    },
    minify: true,
  },
});
