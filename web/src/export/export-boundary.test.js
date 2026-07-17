import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const exportEntry = path.join(srcRoot, 'export', 'export-entry.js');

const forbidden = [
  'session/chat/',
  'session/live/',
  'session/session-globals.js',
  'components/session/chat/',
  'components/session/ChatComposer.svelte',
  'components/session/LiveReload.svelte',
];

function normalize(file) {
  return path.relative(srcRoot, file).split(path.sep).join('/');
}

function resolveImport(specifier, importer) {
  if (!specifier.startsWith('.')) return null;
  const base = path.resolve(path.dirname(importer), specifier);
  const candidates = [base, `${base}.js`, `${base}.svelte`, path.join(base, 'index.js')];
  return (
    candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile()) ||
    null
  );
}

function importsFor(file) {
  return importsForSource(fs.readFileSync(file, 'utf8'));
}

function importsForSource(source) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
    /\bexport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g,
  ];
  for (const re of patterns) {
    let match;
    while ((match = re.exec(source))) specs.push(match[1]);
  }
  return specs;
}

function collectGraph(entry) {
  const seen = new Set();
  const stack = [entry];
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

describe('export source boundary', () => {
  it('does not import live-only session modules', () => {
    const graph = collectGraph(exportEntry);
    const leaks = graph.filter((file) =>
      forbidden.some((prefix) => file.startsWith(prefix) || file === prefix),
    );
    expect(leaks).toEqual([]);
  });

  it('collects re-export edges when walking the source graph', () => {
    expect(importsFor(path.join(srcRoot, 'export', 'export-entry.js'))).toContain(
      '../session/data/session-data.js',
    );
    expect(importsForSource("export { setup } from '../session/live/live-events.js';")).toEqual([
      '../session/live/live-events.js',
    ]);
  });
});
