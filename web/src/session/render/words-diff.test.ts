import { describe, expect, it } from "vitest";
import { parseWordsDiff } from "./words-diff.js";

describe("parseWordsDiff", () => {
  it("tracks unified line numbers and highlights only the paired changed middle", () => {
    const diff = parseWordsDiff(
      "--- a/file.ts\n+++ b/file.ts\n@@ -8,2 +8,2 @@\n-const count = 10;\n+const count = 12;\n unchanged",
    );

    expect(diff).toMatchObject({ additions: 1, deletions: 1, changedLines: 2 });
    expect(diff.rows.map(({ kind, oldLine, newLine }) => ({ kind, oldLine, newLine }))).toEqual([
      { kind: "removed", oldLine: 8, newLine: null },
      { kind: "added", oldLine: null, newLine: 8 },
      { kind: "context", oldLine: 9, newLine: 9 },
    ]);
    expect(diff.rows[0]?.segments).toEqual([
      { text: "const count = 1", changed: false },
      { text: "0", changed: true },
      { text: ";", changed: false },
    ]);
    expect(diff.rows[1]?.segments).toEqual([
      { text: "const count = 1", changed: false },
      { text: "2", changed: true },
      { text: ";", changed: false },
    ]);
  });

  it("does not render a trailing patch newline as a context row", () => {
    const diff = parseWordsDiff("@@ -1 +1 @@\n-old\n+new\n");
    expect(diff.rows).toHaveLength(2);
  });
});
