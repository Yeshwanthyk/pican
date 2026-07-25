import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const exportEntry = path.join(srcRoot, "export", "export-entry.ts");

const forbidden: ReadonlyArray<string> = [
  "lib/http.ts",
  "lib/runtime.ts",
  "lib/sse.ts",
  "shared/api.ts",
  "shared/status-events.ts",
  "session/chat/",
  "session/live/",
  "session/session-globals.ts",
  "session/pinned-tabs-model.svelte.ts",
  "components/session/chat/",
  "components/session/ChatComposer.svelte",
  "components/session/LiveReload.svelte",
  "components/session/PinnedChips.svelte",
  "components/session/PinnedTabsStrip.svelte",
];

function normalize(file: string): string {
  return path.relative(srcRoot, file).split(path.sep).join("/");
}

function resolveImport(specifier: string, importer: string): string | null {
  if (!specifier.startsWith(".")) return null;
  if (
    normalize(importer) === "session/data/session-data.svelte.ts" &&
    specifier === "./session-data.js"
  ) {
    return path.join(srcRoot, "export", "export-session-data.ts");
  }
  if (
    normalize(importer) === "session/ui/session-ui-runner.ts" &&
    specifier === "./toggle-state.js"
  ) {
    return path.join(srcRoot, "export", "export-toggle-state.ts");
  }
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [
    base,
    base.replace(/\.js$/, ".ts"),
    `${base}.ts`,
    `${base}.svelte`,
    path.join(base, "index.ts"),
  ];
  return (
    candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ||
    null
  );
}

function importsFor(file: string): string[] {
  return importsForSource(fs.readFileSync(file, "utf8"));
}

function importsForSource(source: string): string[] {
  const specs: string[] = [];
  const patterns: ReadonlyArray<RegExp> = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source))) {
      const specifier = match[1];
      if (specifier !== undefined) specs.push(specifier);
    }
  }
  return specs;
}

function collectGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack: string[] = [entry];
  while (stack.length) {
    const file = stack.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    for (const specifier of importsFor(file)) {
      const resolved = resolveImport(specifier, file);
      if (resolved) stack.push(resolved);
    }
  }
  return Array.from(seen).map(normalize).sort();
}

describe("export source boundary", () => {
  it("does not import live-only session modules", () => {
    const graph = collectGraph(exportEntry);
    const leaks = graph.filter((file) =>
      forbidden.some((prefix) => file.startsWith(prefix) || file === prefix),
    );
    expect(leaks).toEqual([]);
  });

  it("collects re-export edges when walking the source graph", () => {
    expect(importsFor(path.join(srcRoot, "export", "export-entry.ts"))).toContain(
      "./export-session-data.js",
    );
    expect(importsForSource("export { setup } from '../session/live/live-events.js';")).toEqual([
      "../session/live/live-events.js",
    ]);
  });

  it("contains no browser network primitive", () => {
    const graph = collectGraph(exportEntry);
    const networkPattern = /\b(?:fetch|EventSource|WebSocket|XMLHttpRequest)\s*\(/;
    const leaks = graph.filter((file) =>
      networkPattern.test(fs.readFileSync(path.join(srcRoot, file), "utf8")),
    );
    expect(leaks).toEqual([]);
  });
});
