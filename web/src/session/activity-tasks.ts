import type { TaskList } from "../lib/schema";

// A flattened task row for the session activity dock's Tasks section. Every
// field is a string so the dock can render whatever the wire delivered.
export interface DockTask {
  readonly id: string;
  readonly subject: string;
  readonly status: string;
  readonly updatedAt: string;
}

// Dock chips rank live work first: in_progress > failed > pending > completed;
// anything else falls to the end. Labels for ranks 0-3 exist in
// web/src/shared/english.ts (session.inProgress / session.failed /
// session.pending / session.completed).
function taskStatusRank(status: string): number {
  if (status === "in_progress") return 0;
  if (status === "failed") return 1;
  if (status === "pending") return 2;
  if (status === "completed") return 3;
  return 4;
}

// Latest per id wins: when both rows carry an updatedAt the one with the later
// timestamp wins; otherwise (equal timestamps or a missing one on either side)
// the later occurrence in the payload array wins.
function isMoreRecent(next: DockTask, current: DockTask): boolean {
  if (current.updatedAt && next.updatedAt && next.updatedAt < current.updatedAt) {
    return false;
  }
  return true;
}

// Flatten every store's tasks into DockTask rows, keeping the latest status
// per id, then rank live statuses first and recency within each group.
export function flattenDockTasks(payload: TaskList): DockTask[] {
  const latestById = new Map<string, DockTask>();
  for (const store of payload.stores) {
    for (const task of store.tasks ?? []) {
      const row: DockTask = {
        id: String(task.id ?? ""),
        subject: String(task.subject ?? ""),
        status: String(task.status ?? "unknown"),
        updatedAt: String(task.updatedAt ?? ""),
      };
      const current = latestById.get(row.id);
      if (!current || isMoreRecent(row, current)) {
        latestById.set(row.id, row);
      }
    }
  }
  return [...latestById.values()].sort(compareDockTasks);
}

function compareDockTasks(a: DockTask, b: DockTask): number {
  const byStatus = taskStatusRank(a.status) - taskStatusRank(b.status);
  if (byStatus !== 0) return byStatus;
  const byUpdatedAt = b.updatedAt.localeCompare(a.updatedAt);
  if (byUpdatedAt !== 0) return byUpdatedAt;
  return a.subject.localeCompare(b.subject);
}

// i18n key for a dock status chip. All mapped keys exist in
// web/src/shared/english.ts; anything unmapped returns "" so the caller shows
// the raw status text instead.
export function taskStatusLabelKey(status: string): string {
  if (status === "in_progress") return "session.inProgress";
  if (status === "completed") return "session.completed";
  if (status === "pending") return "session.pending";
  if (status === "failed") return "session.failed";
  return "";
}
