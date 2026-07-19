const TASK_LINE = /^#(\S+)\s+\[(pending|in_progress|completed)\]\s+(.+)$/;

export interface ParsedTask {
  readonly id: string;
  readonly status: "pending" | "in_progress" | "completed";
  readonly subject: string;
}

export function parseTaskLines(text: unknown = "") {
  const tasks: ParsedTask[] = [];
  const passthroughLines: string[] = [];

  for (const line of String(text ?? "").split(/\r?\n/)) {
    const match = line.match(TASK_LINE);
    if (match) {
      const [, id, status, subject] = match;
      if (
        id &&
        subject &&
        (status === "pending" || status === "in_progress" || status === "completed")
      ) {
        tasks.push({ id, status, subject });
      }
    } else {
      passthroughLines.push(line);
    }
  }

  return { tasks, passthroughLines };
}
