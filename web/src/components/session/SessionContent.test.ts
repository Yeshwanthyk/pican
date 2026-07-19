import { describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/svelte";
import SessionContent from "./SessionContent.svelte";
import { SessionDataModel } from "../../session/data/session-data.svelte.js";
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
    get renderedTools(): unknown {
      return model.renderedTools;
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
});
