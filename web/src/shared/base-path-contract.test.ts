import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const sourceRoot = join(process.cwd(), "src");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      if (name === "export") return [];
      return sourceFiles(path);
    }
    return /\.(?:ts|svelte)$/.test(name) && !name.endsWith(".test.ts") ? [path] : [];
  });
}

describe("live base-path static contract", () => {
  it("does not emit root-relative runtime URLs outside the shared helper", () => {
    const violations: string[] = [];
    const sinks = [
      /\b(?:href|src)\s*=\s*["'`]\/(?!\/)/g,
      /\b(?:fetch|fetchImpl|EventSource|EventSourceImpl)\s*\(\s*["'`]\/(?!\/)/g,
      /\b(?:pushState|replaceState)\s*\([^)]*,\s*["'`]\/(?!\/)/g,
    ];
    for (const file of sourceFiles(sourceRoot)) {
      const name = relative(sourceRoot, file);
      if (name === "shared/base-path.ts") continue;
      const source = readFileSync(file, "utf8");
      for (const pattern of sinks) {
        for (const match of source.matchAll(pattern)) {
          const line = source.slice(0, match.index).split("\n").length;
          violations.push(`${name}:${line}: ${match[0]}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});
