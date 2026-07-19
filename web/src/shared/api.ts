import { Effect, Schema } from "effect";
import type { ApiError } from "../lib/errors";
import * as Http from "../lib/http";
import { runPromise } from "../lib/runtime";
import {
  ApiErrorBodySchema,
  DirBrowseSchema,
  GitDiffSchema,
  GitInfoSchema,
  GitRenameResponseSchema,
  ModelListSchema,
  NewSessionResponseSchema,
  OkResponseSchema,
  PeerListSchema,
  PeerMutationResponseSchema,
  PeerSessionListSchema,
  ProjectListSchema,
  ProjectMutationResponseSchema,
  PinMutationResponseSchema,
  QueueItemSchema,
  QueuePauseResponseSchema,
  QueueRemoveResponseSchema,
  QueueStateSchema,
  RecentLocationsSchema,
  RuntimesResponseSchema,
  ScheduleListSchema,
  ScheduleMutationResponseSchema,
  ScheduleRunListSchema,
  ScheduleRunResponseSchema,
  SessionListSchema,
  SettingsResponseSchema,
  SubagentListSchema,
  TaskListSchema,
  VersionInfoSchema,
  WorkflowRunDetailSchema,
  WorkflowRunListSchema,
} from "../lib/schema";

export interface LegacyFetchOptions {
  readonly fetchImpl?: Http.FetchLike;
}

const LegacyError = globalThis.Error;
const decodeErrorBody = Schema.decodeUnknownEffect(Schema.fromJsonString(ApiErrorBodySchema));
const decodeErrorString = Schema.decodeUnknownEffect(Schema.NonEmptyString);

const legacyHttpMessage = (status: number, body: string): Effect.Effect<string> =>
  decodeErrorBody(body).pipe(
    Effect.flatMap((payload) => decodeErrorString(payload.error)),
    Effect.catch(() => Effect.succeed(`HTTP ${status}`)),
  );

const legacyFailure = <A>(effect: Effect.Effect<A, ApiError>): Effect.Effect<A, unknown> =>
  effect.pipe(
    Effect.catchTags({
      NetworkError: ({ cause }) => Effect.fail(cause),
      HttpError: (error) =>
        legacyHttpMessage(error.status, error.body).pipe(
          Effect.flatMap((message) => Effect.fail(new LegacyError(message))),
        ),
      DecodeError: () => Effect.fail(new LegacyError("invalid json response")),
      AbortError: () => Effect.fail(new LegacyError("request cancelled")),
      TimeoutError: ({ millis }) =>
        Effect.fail(new LegacyError(`request timed out after ${millis}ms`)),
    }),
  );

const legacyGetFetch =
  (fetchImpl: Http.FetchLike): Http.FetchLike =>
  (input) =>
    fetchImpl(input, { headers: { Accept: "application/json" } });

const legacyPostFetch =
  (fetchImpl: Http.FetchLike): Http.FetchLike =>
  (input, init) =>
    fetchImpl(input, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: init?.body,
    });

export function getJSON(url: string, { fetchImpl = globalThis.fetch }: LegacyFetchOptions = {}) {
  return runPromise(
    legacyFailure(Http.get(url, Schema.Unknown, { fetchImpl: legacyGetFetch(fetchImpl) })),
  );
}

export function postJSON(
  url: string,
  body: unknown,
  { fetchImpl = globalThis.fetch }: LegacyFetchOptions = {},
) {
  return runPromise(
    legacyFailure(Http.post(url, body, Schema.Unknown, { fetchImpl: legacyPostFetch(fetchImpl) })),
  );
}

const query = (path: string, values: Readonly<Record<string, string | undefined>>) => {
  const params = new URLSearchParams();
  Object.entries(values).forEach(([key, value]) => {
    if (value !== undefined && value !== "") params.set(key, value);
  });
  const encoded = params.toString();
  return encoded === "" ? path : `${path}?${encoded}`;
};

export const effects = {
  get: Http.get,
  post: Http.post,
  put: Http.put,
  patch: Http.patch,
  del: Http.del,
  sessions: {
    list: (
      values: { readonly limit?: number; readonly offset?: number; readonly query?: string } = {},
    ) =>
      Http.get(
        query("/api/sessions", {
          limit: values.limit === undefined ? undefined : String(values.limit),
          offset: values.offset === undefined ? undefined : String(values.offset),
          q: values.query,
        }),
        SessionListSchema,
      ),
    create: (path: string, runtime = "pi") =>
      Http.post("/api/new-session", { path, runtime }, NewSessionResponseSchema),
    recentLocations: Http.get("/api/recent-locations", RecentLocationsSchema),
    runtimes: Http.get("/api/runtimes", RuntimesResponseSchema),
    projects: Http.get("/api/projects", ProjectListSchema),
    updateProject: (path: string, action: string) =>
      Http.post("/api/projects", { path, action }, ProjectMutationResponseSchema),
    updatePin: (sessionId: string, pinned: boolean) =>
      Http.post("/api/pins", { sessionId, pinned }, PinMutationResponseSchema),
  },
  schedules: {
    list: Http.get("/api/schedules", ScheduleListSchema),
    runs: (id: string) => Http.get(query("/api/schedule/runs", { id }), ScheduleRunListSchema),
    create: (body: unknown) => Http.post("/api/schedules", body, ScheduleMutationResponseSchema),
    update: (id: string, body: unknown) =>
      Http.post(query("/api/schedule", { id }), body, ScheduleMutationResponseSchema),
    run: (id: string) =>
      Http.post(query("/api/schedule/run", { id }), {}, ScheduleRunResponseSchema),
    delete: (id: string) => Http.del(query("/api/schedule", { id }), OkResponseSchema),
  },
  peers: {
    list: Http.get("/api/peers", PeerListSchema),
    sessions: Http.get("/api/peers/sessions", PeerSessionListSchema),
    upsert: (name: string, baseUrl: string, token: string) =>
      Http.post("/api/peers", { name, baseUrl, token }, PeerMutationResponseSchema),
    remove: (name: string) =>
      Http.post("/api/peers", { name, action: "remove" }, PeerMutationResponseSchema),
  },
  directory: {
    browse: (path: string) => Http.get(query("/api/fs/browse", { path }), DirBrowseSchema),
  },
  models: Http.get("/api/models", ModelListSchema),
  tasks: {
    list: (project: string, session?: string) =>
      Http.get(query("/api/tasks", { project, session }), TaskListSchema),
  },
  workflows: {
    list: (session?: string) =>
      Http.get(query("/api/workflows", { session }), WorkflowRunListSchema),
    detail: (runId: string) =>
      Http.get(query("/api/workflows/run", { runId }), WorkflowRunDetailSchema),
  },
  subagents: {
    list: (session?: string) => Http.get(query("/api/subagents", { session }), SubagentListSchema),
  },
  queue: {
    get: (sessionId: string) =>
      Http.get(query("/api/chat/queue", { id: sessionId }), QueueStateSchema),
    add: (sessionId: string, body: unknown) =>
      Http.post(query("/api/chat/queue", { id: sessionId }), body, QueueItemSchema),
    remove: (sessionId: string, position: number) =>
      Http.del(
        query("/api/chat/queue", { id: sessionId, position: String(position) }),
        QueueRemoveResponseSchema,
      ),
    pause: (sessionId: string, paused: boolean) =>
      Http.patch(query("/api/chat/queue", { id: sessionId }), { paused }, QueuePauseResponseSchema),
  },
  git: {
    info: (sessionId: string) => Http.get(query("/api/git/info", { id: sessionId }), GitInfoSchema),
    diff: (sessionId: string) => Http.get(query("/api/git/diff", { id: sessionId }), GitDiffSchema),
    rename: (sessionId: string, name: string) =>
      Http.post(
        query("/api/git/rename-branch", { id: sessionId }),
        { name },
        GitRenameResponseSchema,
      ),
  },
  version: Http.get("/api/version", VersionInfoSchema),
  settings: {
    get: Http.get("/api/settings", SettingsResponseSchema),
    save: (settings: Readonly<Record<string, string>>) =>
      Http.post("/api/settings", { settings }, SettingsResponseSchema),
  },
} as const;
