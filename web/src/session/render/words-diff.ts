export interface DiffSegment {
  readonly text: string;
  readonly changed: boolean;
}

export interface UnifiedDiffRow {
  readonly kind: "context" | "added" | "removed";
  readonly oldLine: number | null;
  readonly newLine: number | null;
  readonly marker: " " | "+" | "-";
  readonly segments: readonly DiffSegment[];
}

export interface WordsDiff {
  readonly rows: readonly UnifiedDiffRow[];
  readonly additions: number;
  readonly deletions: number;
  readonly changedLines: number;
}

function splitChange(before: string, after: string): [DiffSegment[], DiffSegment[]] {
  let prefix = 0;
  const maxPrefix = Math.min(before.length, after.length);
  while (prefix < maxPrefix && before[prefix] === after[prefix]) prefix += 1;

  let suffix = 0;
  const maxSuffix = Math.min(before.length - prefix, after.length - prefix);
  while (
    suffix < maxSuffix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  )
    suffix += 1;

  const segments = (text: string): DiffSegment[] => {
    const end = suffix > 0 ? text.length - suffix : text.length;
    return [
      { text: text.slice(0, prefix), changed: false },
      { text: text.slice(prefix, end), changed: true },
      { text: text.slice(end), changed: false },
    ].filter((segment) => segment.text.length > 0);
  };
  return [segments(before), segments(after)];
}

export function parseWordsDiff(patch: string): WordsDiff {
  const rows: UnifiedDiffRow[] = [];
  let oldLine = 1;
  let newLine = 1;
  let additions = 0;
  let deletions = 0;

  const lines = patch.replace(/\r\n?/g, "\n").split("\n");
  if (lines.at(-1) === "") lines.pop();
  for (const rawLine of lines) {
    const hunk = rawLine.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      continue;
    }
    if (/^(diff --git|index |--- |\+\+\+ |\\ No newline)/.test(rawLine)) continue;
    if (rawLine.startsWith("-")) {
      rows.push({
        kind: "removed",
        oldLine: oldLine++,
        newLine: null,
        marker: "-",
        segments: [{ text: rawLine.slice(1), changed: false }],
      });
      deletions += 1;
      continue;
    }
    if (rawLine.startsWith("+")) {
      rows.push({
        kind: "added",
        oldLine: null,
        newLine: newLine++,
        marker: "+",
        segments: [{ text: rawLine.slice(1), changed: false }],
      });
      additions += 1;
      continue;
    }
    const text = rawLine.startsWith(" ") ? rawLine.slice(1) : rawLine;
    rows.push({
      kind: "context",
      oldLine: oldLine++,
      newLine: newLine++,
      marker: " ",
      segments: [{ text, changed: false }],
    });
  }

  for (let index = 0; index < rows.length;) {
    if (rows[index]?.kind !== "removed") {
      index += 1;
      continue;
    }
    const removedStart = index;
    while (rows[index]?.kind === "removed") index += 1;
    const addedStart = index;
    while (rows[index]?.kind === "added") index += 1;
    const pairs = Math.min(addedStart - removedStart, index - addedStart);
    for (let pair = 0; pair < pairs; pair += 1) {
      const removed = rows[removedStart + pair];
      const added = rows[addedStart + pair];
      if (!removed || !added) continue;
      const [removedSegments, addedSegments] = splitChange(
        removed.segments.map((segment) => segment.text).join(""),
        added.segments.map((segment) => segment.text).join(""),
      );
      rows[removedStart + pair] = { ...removed, segments: removedSegments };
      rows[addedStart + pair] = { ...added, segments: addedSegments };
    }
  }

  return { rows, additions, deletions, changedLines: additions + deletions };
}
