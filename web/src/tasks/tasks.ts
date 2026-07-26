import { Effect, Schema } from "effect";
import type { ApiError } from "../lib/errors";
import { HttpError, NetworkError } from "../lib/errors";
import * as Http from "../lib/http";
import type { FetchLike } from "../lib/http";
import { withBasePath } from "../shared/base-path";
import { runPromise } from "../lib/runtime";
import { TaskExecutionSchema, TaskListSchema } from "../lib/schema";
import type { Task } from "../lib/schema";

export const tasksSelectionStorageKey = "pican:tasks:selected-project";

const TaskInputSchema = Schema.StructWithRest(Schema.Struct({}), [
  Schema.Record(Schema.String, Schema.Unknown),
]);
type TaskInput = typeof TaskInputSchema.Type;

export type TaskStatus = "pending" | "in_progress" | "completed";
export type NormalizedTask = Task & {
  readonly id: string;
  readonly subject: string;
  readonly description: string;
  readonly status: TaskStatus;
  readonly owner: string;
  readonly agentType: string;
  readonly execution: Task["execution"] | null;
  readonly blockedBy: ReadonlyArray<string>;
  readonly updatedAt: string;
};

export interface NormalizedTaskStore {
  readonly path: string;
  readonly scope: "project" | "session" | "global";
  readonly sessionId: string;
  readonly tasks: ReadonlyArray<NormalizedTask>;
}

const isTaskStatus = (value: unknown): value is TaskStatus =>
  value === "pending" || value === "in_progress" || value === "completed";
const isTaskExecution = Schema.is(TaskExecutionSchema);

export function normalizeTask(task: TaskInput = {}): NormalizedTask {
  const execution = isTaskExecution(task.execution) ? task.execution : null;
  return {
    ...task,
    id: task.id == null ? "" : String(task.id),
    subject: typeof task.subject === "string" ? task.subject : "",
    description: typeof task.description === "string" ? task.description : "",
    status: isTaskStatus(task.status) ? task.status : "pending",
    owner: typeof task.owner === "string" ? task.owner : "",
    agentType: typeof task.agentType === "string" ? task.agentType : "",
    execution,
    blockedBy: Array.isArray(task.blockedBy) ? task.blockedBy.map(String) : [],
    updatedAt: typeof task.updatedAt === "string" ? task.updatedAt : "",
  };
}

export function normalizeTaskStore(store: TaskInput = {}): NormalizedTaskStore {
  const scope = store.scope;
  return {
    path: typeof store.path === "string" ? store.path : "",
    scope: scope === "session" || scope === "global" ? scope : "project",
    sessionId: typeof store.sessionId === "string" ? store.sessionId : "",
    tasks: Array.isArray(store.tasks)
      ? store.tasks.flatMap((task) =>
          typeof task === "object" && task !== null ? [normalizeTask(task)] : [],
        )
      : [],
  };
}

export function storesForSelection(
  stores: ReadonlyArray<NormalizedTaskStore> = [],
  selection = "",
): ReadonlyArray<NormalizedTaskStore> {
  return stores.filter((store) =>
    selection === "global" ? store.scope === "global" : store.scope !== "global",
  );
}

export function taskGroupsByStatus(
  stores: ReadonlyArray<NormalizedTaskStore> = [],
  status: TaskStatus,
): ReadonlyArray<NormalizedTaskStore> {
  return stores
    .map((store) => ({ ...store, tasks: store.tasks.filter((task) => task.status === status) }))
    .filter((store) => store.tasks.length > 0);
}

export function taskCount(groups: ReadonlyArray<NormalizedTaskStore> = []): number {
  return groups.reduce((total, group) => total + group.tasks.length, 0);
}

export function shortSessionId(sessionId = ""): string {
  return sessionId.length > 12 ? sessionId.slice(0, 8) + "…" : sessionId;
}

export function defaultFetchTasks(project: string, session = "") {
  const query = new URLSearchParams({ project });
  if (session) query.set("session", session);
  return runPromise(Http.get(`/api/tasks?${query}`, TaskListSchema));
}

const responseText = (response: Response): Effect.Effect<string, NetworkError> =>
  Effect.tryPromise({
    try: () => response.text(),
    catch: (cause) => new NetworkError({ cause }),
  });

const taskOutputEffect = (
  project: string,
  taskId: string,
  fetchImpl: FetchLike,
): Effect.Effect<string, ApiError> =>
  Effect.tryPromise({
    try: () =>
      fetchImpl(
        withBasePath(
          `/api/tasks/output?project=${encodeURIComponent(project)}&taskId=${encodeURIComponent(taskId)}`,
        ),
        { headers: { Accept: "text/plain" } },
      ),
    catch: (cause) => new NetworkError({ cause }),
  }).pipe(
    Effect.flatMap((response) =>
      responseText(response).pipe(
        Effect.flatMap((body) =>
          response.ok
            ? Effect.succeed(body)
            : Effect.fail(
                new HttpError({
                  status: response.status,
                  url: response.url,
                  body,
                }),
              ),
        ),
      ),
    ),
  );

export function defaultFetchTaskOutput(
  project: string,
  taskId: string,
  { fetchImpl = globalThis.fetch }: { readonly fetchImpl?: FetchLike } = {},
) {
  return runPromise(taskOutputEffect(project, taskId, fetchImpl));
}
