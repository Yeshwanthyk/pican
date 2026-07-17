const TASK_LINE = /^#(\S+)\s+\[(pending|in_progress|completed)\]\s+(.+)$/;

export function parseTaskLines(text) {
  const tasks = [];
  const passthroughLines = [];

  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = line.match(TASK_LINE);
    if (match) {
      tasks.push({ id: match[1], status: match[2], subject: match[3] });
    } else {
      passthroughLines.push(line);
    }
  }

  return { tasks, passthroughLines };
}
