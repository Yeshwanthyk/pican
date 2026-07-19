import { Cause, Effect, Queue, Schedule, Schema, Stream } from "effect";
import { SseError } from "./errors";
import {
  StatusDeltaSchema,
  StatusSnapshotSchema,
  TasksUpdatedSchema,
  WorkflowUpdatedSchema,
} from "./schema";

export type StatusEvent =
  | { readonly type: "message"; readonly data: string }
  | { readonly type: "reload"; readonly id: string }
  | { readonly type: "status-snapshot"; readonly data: typeof StatusSnapshotSchema.Type }
  | { readonly type: "status-delta"; readonly data: typeof StatusDeltaSchema.Type }
  | { readonly type: "workflows-updated"; readonly data: typeof WorkflowUpdatedSchema.Type }
  | { readonly type: "tasks-updated"; readonly data: typeof TasksUpdatedSchema.Type }
  | { readonly type: "reconnect" };

export interface EventSourceLike {
  onmessage: ((event: MessageEvent<string>) => void) | null;
  addEventListener(type: string, listener: EventListener): void;
  close(): void;
}

export type EventSourceFactory = (url: string) => EventSourceLike;

const decodeSnapshot = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusSnapshotSchema));
const decodeDelta = Schema.decodeUnknownEffect(Schema.fromJsonString(StatusDeltaSchema));
const decodeWorkflow = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowUpdatedSchema));
const decodeTasks = Schema.decodeUnknownEffect(Schema.fromJsonString(TasksUpdatedSchema));

const parseJsonEvent = <A>(
  type: StatusEvent["type"],
  data: string,
  decode: (input: unknown) => Effect.Effect<A, unknown>,
): Effect.Effect<StatusEvent, SseError> =>
  decode(data).pipe(
    Effect.map((value) => ({ type, data: value }) as StatusEvent),
    Effect.mapError((cause) => new SseError({ phase: "parse", cause })),
  );

export const parseStatusEvent = (
  type: string,
  data: string,
): Effect.Effect<StatusEvent, SseError> => {
  if (type === "status-snapshot") return parseJsonEvent(type, data, decodeSnapshot);
  if (type === "status-delta") return parseJsonEvent(type, data, decodeDelta);
  if (type === "workflows-updated") return parseJsonEvent(type, data, decodeWorkflow);
  if (type === "tasks-updated") return parseJsonEvent(type, data, decodeTasks);
  if (data === "reload") return Effect.succeed({ type: "reload", id: "" });
  if (data.startsWith("reload:")) {
    return Effect.succeed({ type: "reload", id: data.slice("reload:".length) });
  }
  return Effect.succeed({ type: "message", data });
};

const defaultEventSourceFactory: EventSourceFactory = (url) => new globalThis.EventSource(url);

export const statusEvents = (
  topic = "__all__",
  eventSourceFactory: EventSourceFactory = defaultEventSourceFactory,
): Stream.Stream<StatusEvent, SseError> => {
  let everConnected = false;
  const source = Stream.callback<StatusEvent, SseError>((queue) =>
    Effect.acquireRelease(
      Effect.try({
        try: () => {
          const eventSource = eventSourceFactory(`/events?id=${encodeURIComponent(topic)}`);
          const emitParsed = (type: string, event: Event) => {
            const data = (event as MessageEvent<string>).data;
            Effect.runFork(
              parseStatusEvent(type, data).pipe(
                Effect.match({
                  onFailure: (error) =>
                    Effect.sync(() => Queue.failCauseUnsafe(queue, Cause.fail(error))),
                  onSuccess: (value) => Effect.sync(() => Queue.offerUnsafe(queue, value)),
                }),
              ),
            );
          };
          eventSource.onmessage = (event) => emitParsed("message", event);
          ["status-snapshot", "status-delta", "workflows-updated", "tasks-updated"].forEach(
            (type) => eventSource.addEventListener(type, (event) => emitParsed(type, event)),
          );
          eventSource.addEventListener("open", () => {
            if (everConnected) Queue.offerUnsafe(queue, { type: "reconnect" });
            everConnected = true;
          });
          eventSource.addEventListener("error", () =>
            Queue.failCauseUnsafe(
              queue,
              Cause.fail(
                new SseError({
                  phase: everConnected ? "stream" : "connect",
                  cause: "EventSource error",
                }),
              ),
            ),
          );
          return eventSource;
        },
        catch: (cause) => new SseError({ phase: "connect", cause }),
      }),
      (eventSource) => Effect.sync(() => eventSource.close()),
    ),
  );
  return source.pipe(Stream.retry(Schedule.exponential(250)));
};
