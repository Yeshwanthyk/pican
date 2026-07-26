import { Effect, Schema } from "effect";
import { runPromise, runSync } from "../../../lib/runtime";

const WorkerStatusData = Schema.Struct({
  state: Schema.optionalKey(Schema.String),
  error: Schema.optionalKey(Schema.String),
  exitCode: Schema.optionalKey(Schema.Number),
  model: Schema.optionalKey(Schema.String),
  modelProvider: Schema.optionalKey(Schema.String),
  thinkingLevel: Schema.optionalKey(Schema.String),
});

interface WorkerStatusApi {
  readonly getWorkerStatus?: (
    sessionId: string,
  ) => Promise<{ readonly ok: boolean; json(): Promise<unknown> }>;
}

interface WorkerStatusWindow extends Pick<
  Window,
  "addEventListener" | "removeEventListener" | "dispatchEvent"
> {
  readonly CustomEvent: typeof CustomEvent;
  setInterval(handler: TimerHandler, timeout?: number): number;
  clearInterval(id: number): void;
}

export function setupWorkerStatusPolling({
  windowImpl = window,
  chatApi,
  sessionId = "",
  setStatus = () => {},
  setModelLabel = () => {},
  setThinkingLabel = () => {},
  updateContextUsage = () => {},
  getKnownModelLabel = () => "",
  setKnownModelLabel = () => {},
  getKnownThinkingLevel = () => "",
  setKnownThinkingLevel = () => {},
  getWorkerModelUpdate = () => null,
  getStatusText = () => "",
  setIntervalImpl = windowImpl.setInterval?.bind(windowImpl),
  clearIntervalImpl = windowImpl.clearInterval?.bind(windowImpl),
  CustomEventImpl = windowImpl.CustomEvent,
  intervalMs = 1500,
}: {
  readonly windowImpl?: WorkerStatusWindow;
  readonly chatApi?: WorkerStatusApi;
  readonly sessionId?: string;
  readonly setStatus?: (text: string, className?: string) => void;
  readonly setModelLabel?: (label: string) => void;
  readonly setThinkingLabel?: (level: string) => void;
  readonly updateContextUsage?: () => void;
  readonly getKnownModelLabel?: () => string;
  readonly setKnownModelLabel?: (label: string) => void;
  readonly getKnownThinkingLevel?: () => string;
  readonly setKnownThinkingLevel?: (level: string) => void;
  readonly getWorkerModelUpdate?: () => ((provider: string, model: string) => void) | null;
  readonly getStatusText?: () => string;
  readonly setIntervalImpl?: ((handler: () => void, timeout: number) => number) | null;
  readonly clearIntervalImpl?: ((id: number) => void) | null;
  readonly CustomEventImpl?: typeof CustomEvent;
  readonly intervalMs?: number;
} = {}) {
  let inflight = false;
  let pending = false;
  let lastWorkerState: string | null = null;

  function finishRefresh(): void {
    inflight = false;
    if (pending) {
      pending = false;
      void refresh();
    }
  }

  function refresh(): Promise<void> {
    if (inflight) {
      // Queue exactly one follow-up so an in-flight response cannot swallow a
      // newer state change, such as the assistant finishing while we poll stale
      // "running" state.
      pending = true;
      return Promise.resolve();
    }
    inflight = true;
    const request = chatApi?.getWorkerStatus?.(sessionId) ?? Promise.resolve(null);
    return request
      .then(
        async (response) => {
          if (!response?.ok) return;
          const data = await runPromise(
            Schema.decodeUnknownEffect(WorkerStatusData)(await response.json()),
          );
          const apiModelLabel = data.model
            ? data.model + (data.modelProvider ? " @ " + data.modelProvider : "")
            : "";
          if (apiModelLabel) setKnownModelLabel(apiModelLabel);
          if (data.thinkingLevel) setKnownThinkingLevel(data.thinkingLevel);
          // Interrupt acknowledgement means the runtime received Stop, not
          // that the turn is terminal. Keep "stopping" until status is idle.
          if (data.state === "running" && getStatusText() !== "stopping") {
            setStatus("running", "running");
          }
          if (data.state === "idle") setStatus("idle", "");
          if (data.state === "error") setStatus(data.error || "worker error", "error");
          if (data.state) {
            runSync(
              Effect.try({
                try: () =>
                  windowImpl.dispatchEvent(
                    new CustomEventImpl("pi-worker-status", { detail: data }),
                  ),
                catch: () => false,
              }),
            );
          }
          if (lastWorkerState === "running" && data.state === "idle") {
            runSync(
              Effect.try({
                try: () => windowImpl.dispatchEvent(new CustomEventImpl("pi-worker-done")),
                catch: () => false,
              }),
            );
          }
          if (data.state) lastWorkerState = data.state;
          setModelLabel(getKnownModelLabel());
          setThinkingLabel(getKnownThinkingLevel());
          updateContextUsage();
          const onWorkerModelUpdate = getWorkerModelUpdate?.();
          if (data.modelProvider && data.model && onWorkerModelUpdate) {
            onWorkerModelUpdate(data.modelProvider, data.model);
          }
        },
        () => setStatus("status unavailable", "error"),
      )
      .then(
        () => finishRefresh(),
        () => {
          setStatus("status unavailable", "error");
          finishRefresh();
        },
      );
  }

  const timer = setIntervalImpl ? setIntervalImpl(refresh, intervalMs) : null;
  void refresh();
  updateContextUsage();

  const onSessionReload = () => {
    void refresh();
    updateContextUsage();
  };
  windowImpl.addEventListener?.("pi-session-reload", onSessionReload);

  return {
    refresh,
    dispose: () => {
      // Leaving the interval running after unmount lets stale pollers from
      // previously-visited sessions keep writing #pi-chat-context-usage (a
      // global-id lookup), making the context gauge flicker between sessions.
      if (timer !== null) clearIntervalImpl?.(timer);
      windowImpl.removeEventListener?.("pi-session-reload", onSessionReload);
    },
  };
}
