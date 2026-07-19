import { describe, expect, it, vi } from "vitest";
import { setupWorkerStatusPolling } from "./worker-status.js";

const response = (data: unknown): Response =>
  new Response(JSON.stringify(data), {
    status: 200,
    headers: { "content-type": "application/json" },
  });

function statusWindow(target = new EventTarget()) {
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
    CustomEvent,
    setInterval: (_handler: TimerHandler, _timeout?: number) => 0,
    clearInterval: (_id: number) => undefined,
  };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("setupWorkerStatusPolling", () => {
  it("updates status, labels, context usage, and model selector state", async () => {
    let knownModelLabel = "";
    let knownThinkingLevel = "";
    const setStatus = vi.fn();
    const setModelLabel = vi.fn();
    const setThinkingLabel = vi.fn();
    const updateContextUsage = vi.fn();
    const onWorkerModelUpdate = vi.fn();

    setupWorkerStatusPolling({
      windowImpl: statusWindow(),
      sessionId: "s",
      chatApi: {
        getWorkerStatus: vi.fn(() =>
          Promise.resolve(
            response({
              state: "running",
              model: "gpt-4o",
              modelProvider: "openai",
              thinkingLevel: "high",
            }),
          ),
        ),
      },
      setStatus,
      setModelLabel,
      setThinkingLabel,
      updateContextUsage,
      getKnownModelLabel: () => knownModelLabel,
      setKnownModelLabel: (label) => {
        knownModelLabel = label;
      },
      getKnownThinkingLevel: () => knownThinkingLevel,
      setKnownThinkingLevel: (level) => {
        knownThinkingLevel = level;
      },
      getWorkerModelUpdate: () => onWorkerModelUpdate,
      setIntervalImpl: () => 0,
      CustomEventImpl: CustomEvent,
    });
    await tick();

    expect(setStatus).toHaveBeenCalledWith("running", "running");
    expect(setModelLabel).toHaveBeenCalledWith("gpt-4o @ openai");
    expect(setThinkingLabel).toHaveBeenCalledWith("high");
    expect(updateContextUsage).toHaveBeenCalled();
    expect(onWorkerModelUpdate).toHaveBeenCalledWith("openai", "gpt-4o");
  });

  it("dispatches pi-worker-done on running to idle transition", async () => {
    const events: string[] = [];
    const windowImpl = new EventTarget();
    windowImpl.addEventListener("pi-worker-done", (event) => events.push(event.type));
    const getWorkerStatus = vi
      .fn()
      .mockResolvedValueOnce(response({ state: "running" }))
      .mockResolvedValueOnce(response({ state: "idle" }));

    const controller = setupWorkerStatusPolling({
      windowImpl: statusWindow(windowImpl),
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => 0,
      CustomEventImpl: CustomEvent,
    });
    await tick();
    await controller.refresh();

    expect(events).toEqual(["pi-worker-done"]);
  });

  it("refreshes immediately on session reload", async () => {
    const windowImpl = new EventTarget();
    const getWorkerStatus = vi.fn(() => Promise.resolve(response({ state: "idle" })));

    setupWorkerStatusPolling({
      windowImpl: statusWindow(windowImpl),
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => 0,
      CustomEventImpl: CustomEvent,
    });
    await tick();
    const initialCalls = getWorkerStatus.mock.calls.length;

    windowImpl.dispatchEvent(new Event("pi-session-reload"));
    await tick();

    expect(getWorkerStatus.mock.calls.length).toBe(initialCalls + 1);
  });

  it("coalesces refreshes while a request is in flight", async () => {
    let resolveFirst: (response: Response) => void = () => undefined;
    const first = new Promise<Response>((resolve) => {
      resolveFirst = resolve;
    });
    const getWorkerStatus = vi
      .fn()
      .mockImplementationOnce(() => first)
      .mockResolvedValue(response({ state: "idle" }));

    const controller = setupWorkerStatusPolling({
      windowImpl: statusWindow(),
      chatApi: { getWorkerStatus },
      setIntervalImpl: () => 0,
      CustomEventImpl: CustomEvent,
    });

    void controller.refresh();
    void controller.refresh();
    expect(getWorkerStatus).toHaveBeenCalledTimes(1);

    resolveFirst(response({ state: "running" }));
    await tick();
    await tick();
    expect(getWorkerStatus).toHaveBeenCalledTimes(2);
  });

  it("clears the polling interval on dispose", () => {
    const setIntervalImpl = vi.fn(() => 42);
    const clearIntervalImpl = vi.fn();

    const controller = setupWorkerStatusPolling({
      windowImpl: statusWindow(),
      chatApi: { getWorkerStatus: vi.fn(() => Promise.resolve(response({ state: "idle" }))) },
      setIntervalImpl,
      clearIntervalImpl,
      CustomEventImpl: CustomEvent,
    });

    expect(setIntervalImpl).toHaveBeenCalledTimes(1);
    controller.dispose();
    expect(clearIntervalImpl).toHaveBeenCalledWith(42);
  });
});
