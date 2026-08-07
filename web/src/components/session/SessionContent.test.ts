import { describe, expect, it, onTestFinished, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import SessionContent from "./SessionContent.svelte";
import { SessionDataModel } from "../../session/data/session-data.svelte.js";
import { createSessionNavigator } from "../../session/navigation/session-navigation.js";
import { sessionEntryFromUnknown, type SessionEntry } from "../../session/data/session-types.js";

const entries: SessionEntry[] = [
  {
    id: "root",
    timestamp: "2026-01-01T00:00:00Z",
    type: "message",
    message: { role: "user", content: "hi" },
  },
  {
    id: "mid",
    parentId: "root",
    timestamp: "2026-01-01T00:01:00Z",
    type: "message",
    message: { role: "assistant", content: "mid" },
  },
  {
    id: "leaf",
    parentId: "mid",
    timestamp: "2026-01-01T00:02:00Z",
    type: "message",
    message: { role: "user", content: "leaf" },
  },
  {
    id: "other",
    parentId: "root",
    timestamp: "2026-01-01T00:03:00Z",
    type: "message",
    message: { role: "assistant", content: "other branch" },
  },
];

function normalizedEntries(values: readonly unknown[]): SessionEntry[] {
  return values.flatMap((value) => {
    const entry = sessionEntryFromUnknown(value);
    return entry ? [entry] : [];
  });
}

function contentModel(model: SessionDataModel) {
  return {
    get activePath(): SessionEntry[] {
      return normalizedEntries(model.activePath);
    },
    get entries(): SessionEntry[] {
      return normalizedEntries(model.entries);
    },
    get toolResultMap() {
      return model.toolResultMap;
    },
    get renderedTools(): unknown {
      return model.renderedTools;
    },
    get workerStatus() {
      return model.workerStatus;
    },
  };
}

function mount(
  extra: Partial<{
    readonly entries: SessionEntry[];
    readonly header: Record<string, unknown>;
    readonly leafId: string;
  }> = {},
) {
  const model = new SessionDataModel({ entries, header: {}, leafId: "leaf", ...extra });
  return { model, ...render(SessionContent, { props: { model: contentModel(model) } }) };
}

describe("SessionContent", () => {
  it("renders the active root→leaf path in order (not off-path branches)", () => {
    const { container } = mount();
    const ids = [...container.querySelectorAll("#messages-list > div")].map((d) => d.id);
    expect(ids).toEqual(["entry-root", "entry-mid", "entry-leaf"]);
    // 'other' is on a different branch → not rendered
    expect(container.querySelector("#entry-other")).not.toBeInTheDocument();
  });

  it("reactively re-renders the path when the active leaf changes", async () => {
    const { container, model } = mount();
    model.navigateTo("other");
    await Promise.resolve();
    const ids = [...container.querySelectorAll("#messages-list > div")].map((d) => d.id);
    expect(ids).toEqual(["entry-root", "entry-other"]);
  });

  it("reactively appends a new entry that extends the active path (live reload)", async () => {
    const { container, model } = mount();
    const newEntry = {
      id: "leaf2",
      parentId: "leaf",
      timestamp: "2026-01-01T00:04:00Z",
      type: "message",
      message: { role: "assistant", content: "new" },
    };
    // Mimic live reconcile: in-place entries splice + byId refill.
    model.entries.push(newEntry);
    model.byId.set("leaf2", newEntry);
    model.navigateTo("leaf2");
    await Promise.resolve();
    expect(container.querySelector("#entry-leaf2")).toBeInTheDocument();
  });

  it("reactively updates indexed tool results across append and same-id replacement", async () => {
    const activeEntries = [
      {
        id: "root-tool",
        type: "message",
        message: { role: "user", content: "run it" },
      },
      {
        id: "assistant-tool",
        parentId: "root-tool",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "live-tool-call",
              name: "bash",
              arguments: { command: "printf live" },
            },
          ],
        },
      },
    ];
    const model = new SessionDataModel({
      entries: activeEntries,
      header: {},
      leafId: "assistant-tool",
    });
    const { container } = render(SessionContent, {
      props: { model: contentModel(model), live: true },
    });
    expect(container.querySelector(".tool-fold-status")?.classList).toContain("pending");

    const runningResult = {
      id: "live-tool-result",
      parentId: "assistant-tool",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "live-tool-call",
        isRunning: true,
        content: [{ type: "text", text: "partial output" }],
      },
    };
    model.reconcile([runningResult], { isDelta: true });
    await Promise.resolve();

    expect(container.querySelector(".tool-fold-status")?.classList).toContain("pending");
    expect(container.textContent).toContain("partial output");

    const completedResult = {
      ...runningResult,
      message: {
        ...runningResult.message,
        isRunning: false,
        content: [{ type: "text", text: "complete output" }],
      },
    };
    model.reconcile([...activeEntries, completedResult], { replaceExisting: true });
    await Promise.resolve();

    expect(container.querySelector(".tool-fold-status")?.classList).toContain("success");
    expect(container.textContent).toContain("complete output");
    expect(container.textContent).not.toContain("partial output");
  });

  it("renders a long tool run in a collapsed group without changing entry anchors", () => {
    const groupedEntries = [
      ...entries.slice(0, 1),
      {
        id: "tools",
        parentId: "root",
        type: "message",
        message: {
          role: "assistant",
          content: ["bash", "read", "edit", "write", "ls"].map((name, index) => ({
            type: "toolCall",
            id: `call-${index}`,
            name,
            arguments: {},
          })),
        },
      },
    ];
    const model = new SessionDataModel({ entries: groupedEntries, header: {}, leafId: "tools" });
    const { container } = render(SessionContent, { props: { model: contentModel(model) } });

    const group = container.querySelector<HTMLDetailsElement>(".activity-fold");
    expect(group?.open).toBe(false);
    expect(group?.querySelector("summary")?.textContent).toContain("5 tool runs");
    expect(group?.id).toBe("entry-tools");
    expect(group?.dataset.activityBodyMounted).toBe("false");
    expect(group?.querySelector(".activity-body")).not.toBeInTheDocument();
  });

  it("mounts and opens a closed fold before navigating to a deep tool result", async () => {
    const groupedEntries = [
      ...entries.slice(0, 1),
      {
        id: "tools",
        parentId: "root",
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "deep-call",
              name: "bash",
              arguments: { command: "printf deep" },
            },
          ],
        },
      },
      {
        id: "deep-result",
        parentId: "tools",
        type: "message",
        message: {
          role: "toolResult",
          toolCallId: "deep-call",
          content: [{ type: "text", text: "deep output" }],
        },
      },
    ];
    const model = new SessionDataModel({
      entries: groupedEntries,
      header: {},
      leafId: "deep-result",
    });
    const { container } = render(SessionContent, { props: { model: contentModel(model) } });
    container.id = "content";
    const fold = container.querySelector<HTMLDetailsElement>(".activity-fold");
    expect(fold?.open).toBe(false);
    expect(fold?.querySelector("#entry-deep-result")).not.toBeInTheDocument();

    const scrollIntoView = vi.fn();
    const originalScrollIntoView = HTMLElement.prototype.scrollIntoView;
    HTMLElement.prototype.scrollIntoView = scrollIntoView;
    onTestFinished(() => {
      HTMLElement.prototype.scrollIntoView = originalScrollIntoView;
    });

    const nav = createSessionNavigator();
    nav.navigateTo("deep-result", "target", "deep-result");

    await waitFor(() => {
      expect(fold?.open).toBe(true);
      expect(fold?.dataset.activityBodyMounted).toBe("true");
      expect(fold?.querySelector("#entry-deep-result")).toBeInTheDocument();
      expect(scrollIntoView).toHaveBeenCalledWith({ block: "center" });
    });
  });

  it("keeps completed and failed activity closed when it is not the live turn", () => {
    const failedEntries = [
      ...entries.slice(0, 1),
      {
        id: "tools",
        parentId: "root",
        type: "message",
        message: {
          role: "assistant",
          content: ["bash", "edit"].map((name, index) => ({
            type: "toolCall",
            id: `call-${index}`,
            name,
            arguments: {},
          })),
        },
      },
      {
        id: "result-0",
        parentId: "tools",
        type: "message",
        message: { role: "toolResult", toolCallId: "call-0", content: [], isError: false },
      },
      {
        id: "result-1",
        parentId: "result-0",
        type: "message",
        message: { role: "toolResult", toolCallId: "call-1", content: [], isError: true },
      },
    ];
    const model = new SessionDataModel({
      entries: failedEntries,
      header: {},
      leafId: "result-1",
    });
    const { container } = render(SessionContent, { props: { model: contentModel(model) } });

    expect(container.querySelector<HTMLDetailsElement>(".activity-fold.error")?.open).toBe(false);
  });

  it("auto-opens only pending activity in the live viewer", () => {
    const activeEntries = [
      ...entries.slice(0, 1),
      {
        id: "active-tools",
        parentId: "root",
        timestamp: new Date().toISOString(),
        type: "message",
        message: {
          role: "assistant",
          content: [
            {
              type: "toolCall",
              id: "live-call",
              name: "bash",
              arguments: { command: "make test" },
            },
          ],
        },
      },
    ];
    const model = new SessionDataModel({
      entries: activeEntries,
      header: {},
      leafId: "active-tools",
    });
    const { container } = render(SessionContent, {
      props: { model: contentModel(model), live: true },
    });

    const fold = container.querySelector<HTMLDetailsElement>(".activity-fold.pending");
    expect(fold?.open).toBe(true);
    expect(fold?.dataset.activityBodyMounted).toBe("true");
    expect(fold?.querySelector(".activity-body")).toBeInTheDocument();
    expect(fold?.querySelector("summary")?.textContent).toContain("running bash make test");
  });

  it("runs afterRender(container) when the path changes", async () => {
    const afterRender = vi.fn();
    const model = new SessionDataModel({ entries, header: {}, leafId: "leaf" });
    render(SessionContent, { props: { model: contentModel(model), afterRender } });
    await Promise.resolve();
    expect(afterRender).toHaveBeenCalled();
    expect(afterRender.mock.calls[0]?.[0]?.id).toBe("messages-list");
  });

  it("renders the worker crash at the end of the saved transcript", () => {
    const model = new SessionDataModel({ entries, header: {}, leafId: "leaf" });
    model.setWorkerStatus({ state: "error", exitCode: 23 });
    const { container } = render(SessionContent, { props: { model: contentModel(model) } });

    const marker = container.querySelector(".plain-state--worker-down");
    expect(marker?.textContent).toContain("worker exited (23) — stream ended here");
    expect(marker?.textContent).toContain(
      "send your next message to restart the worker · transcript is saved",
    );
    expect(container.querySelector("#messages-list")?.lastElementChild).toBe(marker);
  });
});
