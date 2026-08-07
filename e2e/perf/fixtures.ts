import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence.toString(36).padStart(6, "0")}`;
}

function writeJsonl(path: string, entries: readonly unknown[]): void {
  writeFileSync(
    path,
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
}

export interface CatalogFixture {
  readonly projectPaths: readonly string[];
  readonly sessionIds: readonly string[];
  readonly serializedBytes: number;
}

export function generateCatalogFixture({
  sessionsDir,
  projectPaths,
  sessionsPerProject,
}: {
  readonly sessionsDir: string;
  readonly projectPaths: readonly string[];
  readonly sessionsPerProject: number;
}): CatalogFixture {
  const sessionDir = join(sessionsDir, "--home-user-demo-project--");
  mkdirSync(sessionDir, { recursive: true });
  const sessionIds: string[] = [];
  let serializedBytes = 0;
  const base = Date.parse("2026-08-07T12:00:00.000Z");

  projectPaths.forEach((cwd, projectIndex) => {
    for (
      let sessionIndex = 0;
      sessionIndex < sessionsPerProject;
      sessionIndex += 1
    ) {
      const sessionId = `perf-catalog-${projectIndex}-${sessionIndex}-${nextId("s")}.jsonl`;
      const timestamp = new Date(
        base + (projectIndex * sessionsPerProject + sessionIndex) * 1000,
      );
      const userId = nextId("u");
      const assistantId = nextId("a");
      const entries = [
        {
          type: "session",
          version: 3,
          id: nextId("session"),
          timestamp: timestamp.toISOString(),
          cwd,
        },
        {
          type: "message",
          id: userId,
          parentId: null,
          timestamp: timestamp.toISOString(),
          message: {
            role: "user",
            content: [
              {
                type: "text",
                text: `Project ${projectIndex} task ${sessionIndex}`,
              },
            ],
            timestamp: timestamp.getTime(),
          },
        },
        {
          type: "message",
          id: assistantId,
          parentId: userId,
          timestamp: new Date(timestamp.getTime() + 1).toISOString(),
          message: {
            role: "assistant",
            content: [{ type: "text", text: "Ready to continue." }],
            timestamp: timestamp.getTime() + 1,
          },
        },
      ];
      const path = join(sessionDir, sessionId);
      writeJsonl(path, entries);
      utimesSync(path, timestamp, timestamp);
      serializedBytes += Buffer.byteLength(
        entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
      );
      sessionIds.push(sessionId);
    }
  });

  return { projectPaths, sessionIds, serializedBytes };
}

export interface TranscriptFixture {
  readonly sessionId: string;
  readonly lastEntryId: string;
  readonly entryCount: number;
  readonly serializedBytes: number;
}

export function generateTranscriptFixture({
  sessionsDir,
  cwd,
  messageCount,
}: {
  readonly sessionsDir: string;
  readonly cwd: string;
  readonly messageCount: number;
}): TranscriptFixture {
  const sessionDir = join(sessionsDir, "--home-user-demo-project--");
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = `perf-transcript-${messageCount}-${nextId("s")}.jsonl`;
  const base = Date.parse("2026-08-07T13:00:00.000Z");
  const entries: unknown[] = [
    {
      type: "session",
      version: 3,
      id: nextId("session"),
      timestamp: new Date(base).toISOString(),
      cwd,
    },
  ];
  let parentId: string | null = null;

  for (let index = 0; index < messageCount; index += 1) {
    const id = nextId(index % 2 === 0 ? "u" : "a");
    const role = index % 2 === 0 ? "user" : "assistant";
    const content =
      role === "assistant" && index % 20 === 1
        ? `### Update ${index}\n\n\`\`\`ts\nconst item = ${index};\n\`\`\`\n\nThe work is still progressing.`
        : `Transcript message ${index}: deterministic performance fixture content.`;
    entries.push({
      type: "message",
      id,
      parentId,
      timestamp: new Date(base + index + 1).toISOString(),
      message: {
        role,
        content: [{ type: "text", text: content }],
        timestamp: base + index + 1,
      },
    });
    parentId = id;
  }

  const serialized =
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(join(sessionDir, sessionId), serialized);
  return {
    sessionId,
    lastEntryId: parentId ?? "",
    entryCount: entries.length,
    serializedBytes: Buffer.byteLength(serialized),
  };
}
