import { Match, Schema } from "effect";

export class NetworkError extends Schema.TaggedErrorClass<NetworkError>()("NetworkError", {
  cause: Schema.Defect(),
}) {}

export class HttpError extends Schema.TaggedErrorClass<HttpError>()("HttpError", {
  status: Schema.Number,
  url: Schema.String,
  body: Schema.String,
}) {
  get isUnauthorized(): boolean {
    return this.status === 401;
  }

  get isNotFound(): boolean {
    return this.status === 404;
  }

  get isServerError(): boolean {
    return this.status >= 500 && this.status < 600;
  }
}

export class DecodeError extends Schema.TaggedErrorClass<DecodeError>()("DecodeError", {
  url: Schema.String,
  issue: Schema.String,
}) {}

export class AbortError extends Schema.TaggedErrorClass<AbortError>()("AbortError", {}) {}

export class TimeoutError extends Schema.TaggedErrorClass<TimeoutError>()("TimeoutError", {
  url: Schema.String,
  millis: Schema.Number,
}) {}

export class StorageError extends Schema.TaggedErrorClass<StorageError>()("StorageError", {
  key: Schema.String,
  op: Schema.Literals(["read", "write", "parse"]),
  cause: Schema.Defect(),
}) {}

export class SseError extends Schema.TaggedErrorClass<SseError>()("SseError", {
  phase: Schema.Literals(["connect", "stream", "parse"]),
  cause: Schema.Defect(),
}) {}

export class WorkerDownError extends Schema.TaggedErrorClass<WorkerDownError>()("WorkerDownError", {
  code: Schema.Number,
}) {}

export type ApiError = NetworkError | HttpError | DecodeError | AbortError | TimeoutError;
export type AppError = ApiError | StorageError | SseError | WorkerDownError;

const AppErrorSchema = Schema.Union([
  NetworkError,
  HttpError,
  DecodeError,
  AbortError,
  TimeoutError,
  StorageError,
  SseError,
  WorkerDownError,
]);
const isAppError = Schema.is(AppErrorSchema);

export const describeError = (error: unknown): string =>
  isAppError(error)
    ? Match.value(error).pipe(
        Match.tagsExhaustive({
          NetworkError: () => "network unavailable",
          HttpError: ({ status }) => `request failed (${status})`,
          DecodeError: () => "invalid response from server",
          AbortError: () => "request cancelled",
          TimeoutError: ({ millis }) => `request timed out after ${millis}ms`,
          StorageError: ({ op }) => `browser storage ${op} failed`,
          SseError: ({ phase }) => `live updates ${phase} failed`,
          WorkerDownError: ({ code }) => `worker exited (${code}) — stream ended here`,
        }),
      )
    : "something went wrong";
