import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let sequence = 0;

function nextId(prefix: string): string {
  sequence += 1;
  return `${prefix}-${sequence.toString(36).padStart(6, "0")}`;
}

function writeJsonl(path: string, entries: readonly unknown[]): void {
  writeFileSync(path, entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
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
    for (let sessionIndex = 0; sessionIndex < sessionsPerProject; sessionIndex += 1) {
      const sessionId = `perf-catalog-${projectIndex}-${sessionIndex}-${nextId("s")}.jsonl`;
      const timestamp = new Date(base + (projectIndex * sessionsPerProject + sessionIndex) * 1000);
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

export type TranscriptFixtureProfile = "light" | "activity-tool";

export interface TranscriptFixture {
  readonly sessionId: string;
  readonly lastEntryId: string;
  readonly entryCount: number;
  readonly renderItemCount: number;
  readonly entryIds: readonly string[];
  readonly renderItemIds: readonly string[];
  readonly profile: TranscriptFixtureProfile;
  readonly serializedBytes: number;
}

export function generateTranscriptFixture({
  sessionsDir,
  cwd,
  messageCount,
  profile = "light",
}: {
  readonly sessionsDir: string;
  readonly cwd: string;
  readonly messageCount: number;
  readonly profile?: TranscriptFixtureProfile;
}): TranscriptFixture {
  const sessionDir = join(sessionsDir, "--home-user-demo-project--");
  mkdirSync(sessionDir, { recursive: true });
  const sessionId = `perf-transcript-${messageCount}-${process.pid}-${nextId("s")}.jsonl`;
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
  const entryIds: string[] = [];
  const renderItemIds: string[] = [];

  for (let index = 0; index < messageCount; index += 1) {
    const activityPhase = index % 4;
    const prefix =
      profile === "activity-tool"
        ? activityPhase === 0
          ? "u"
          : activityPhase === 2
            ? "r"
            : "a"
        : index % 2 === 0
          ? "u"
          : "a";
    const id = nextId(prefix);
    const timestamp = new Date(base + index + 1).toISOString();
    let message: Record<string, unknown>;

    if (profile === "activity-tool" && activityPhase === 1) {
      const callId = `call-${id}`;
      message = {
        role: "assistant",
        content: [
          {
            type: "thinking",
            thinking: `Inspecting deterministic activity fixture ${index}.`,
          },
          {
            type: "toolCall",
            id: callId,
            name: index % 8 === 1 ? "read" : "bash",
            arguments: {
              path: `/fixture/module-${index % 32}.ts`,
              command: `printf activity-${index}`,
            },
          },
        ],
        timestamp: base + index + 1,
      };
    } else if (profile === "activity-tool" && activityPhase === 2) {
      const previousId = entryIds.at(-1) ?? "";
      message = {
        role: "toolResult",
        toolCallId: `call-${previousId}`,
        content: [
          {
            type: "text",
            text: `Activity result ${index}\nline one\nline two\nline three`,
          },
        ],
        details: { path: `/fixture/module-${index % 32}.ts` },
        timestamp: base + index + 1,
      };
    } else {
      const role =
        profile === "activity-tool" && activityPhase === 3
          ? "assistant"
          : index % 2 === 0
            ? "user"
            : "assistant";
      const content =
        role === "assistant" && index % 20 === 1
          ? `### Update ${index}\n\n\`\`\`ts\nconst item = ${index};\n\`\`\`\n\nThe work is still progressing.`
          : `Transcript message ${index}: deterministic performance fixture content.`;
      message = {
        role,
        content: [{ type: "text", text: content }],
        timestamp: base + index + 1,
      };
    }

    entries.push({ type: "message", id, parentId, timestamp, message });
    entryIds.push(id);
    // A tool result is represented by its preceding assistant activity group,
    // whose canonical target list still contains both IDs in exact order.
    if (!(profile === "activity-tool" && activityPhase === 2)) {
      renderItemIds.push(id);
    }
    parentId = id;
  }

  const serialized = entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n";
  writeFileSync(join(sessionDir, sessionId), serialized);
  return {
    sessionId,
    lastEntryId: parentId ?? "",
    entryCount: entries.length,
    renderItemCount: renderItemIds.length,
    entryIds,
    renderItemIds,
    profile,
    serializedBytes: Buffer.byteLength(serialized),
  };
}
