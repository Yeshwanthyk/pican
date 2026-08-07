import { fireEvent, render, waitFor } from "@testing-library/svelte";
import { marked } from "marked";
import { afterEach, describe, expect, it, vi } from "vitest";
import type {
  ToolResultLookup,
  ToolResultLookupSource,
} from "../../session/data/session-data.svelte.js";
import type { SessionEntry } from "../../session/data/session-types.js";
import type { ToolRunStatus } from "../../session/render/group-tool-runs.js";
import ActivityFold from "./ActivityFold.svelte";

afterEach(() => {
  vi.restoreAllMocks();
});

const assistantEntry: SessionEntry = {
  id: "assistant-tools",
  timestamp: "2026-01-01T00:00:00Z",
  type: "message",
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "**private working**" },
      {
        type: "toolCall",
        id: "edit-call",
        name: "edit",
        arguments: { path: "src/app.ts" },
      },
      {
        type: "toolCall",
        id: "task-call",
        name: "TaskCreate",
        arguments: { subject: "Nested extension card" },
      },
    ],
  },
};

const editResult: SessionEntry = {
  id: "edit-result",
  parentId: "assistant-tools",
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "edit-call",
    content: [{ type: "text", text: "expensive output" }],
    details: { diff: "@@ -1 +1 @@\n-old\n+new" },
  },
};

const taskResult: SessionEntry = {
  id: "task-result",
  parentId: "edit-result",
  type: "message",
  message: {
    role: "toolResult",
    toolCallId: "task-call",
    content: [{ type: "text", text: "extension output" }],
  },
};

function mount({
  live = false,
  status = "success",
}: { readonly live?: boolean; readonly status?: ToolRunStatus } = {}) {
  const entries = [assistantEntry, editResult, taskResult];
  const toolResultMap: ReadonlyMap<string, ToolResultLookup> = new Map([
    [
      "edit-call",
      {
        entry: editResult,
        message: editResult.message!,
        details: { diff: "@@ -1 +1 @@\n-old\n+new" },
        resultCount: 1,
        hasError: false,
        hasEdits: true,
      },
    ],
    [
      "task-call",
      {
        entry: taskResult,
        message: taskResult.message!,
        details: null,
        resultCount: 1,
        hasError: false,
        hasEdits: false,
      },
    ],
  ]);
  const model: ToolResultLookupSource & { readonly renderedTools: null } = {
    entries,
    toolResultMap,
    renderedTools: null,
  };
  return render(ActivityFold, {
    props: {
      entries: [assistantEntry],
      model,
      toolCount: 2,
      durationSeconds: 3,
      hasEdits: true,
      status,
      live,
    },
  });
}

describe("ActivityFold", () => {
  it("renders an accessible completed summary without mounting closed activity contents", () => {
    const { container } = mount();
    const fold = container.querySelector<HTMLDetailsElement>(".activity-fold");
    const summary = fold?.querySelector("summary");

    expect(fold?.open).toBe(false);
    expect(fold?.firstElementChild).toBe(summary);
    expect(summary?.textContent).toContain("3s thinking · 2 tool runs · edits");
    expect(summary?.textContent).toContain("completed");
    expect(fold?.dataset.activityBodyMounted).toBe("false");
    expect(new URLSearchParams(fold?.dataset.activityTargetIds ?? "").getAll("id")).toEqual([
      "assistant-tools",
      "edit-result",
      "task-result",
    ]);
    expect(fold?.querySelector(".activity-body")).not.toBeInTheDocument();
    expect(fold?.querySelector(".activity-thinking")).not.toBeInTheDocument();
    expect(fold?.querySelector(".tool-execution")).not.toBeInTheDocument();
    expect(container.textContent).not.toContain("private working");
    expect(container.textContent).not.toContain("expensive output");
    expect(container.textContent).not.toContain("Nested extension card");
  });

  it("parses thinking lazily and caches each unchanged entry revision once mounted", async () => {
    const thinkingBlock = { type: "thinking", thinking: "**cache this thought**" };
    const entry: SessionEntry = {
      id: "cache-thinking",
      type: "message",
      message: { role: "assistant", content: [thinkingBlock] },
    };
    const props = {
      entries: [entry],
      model: { entries: [entry], toolResultMap: new Map(), renderedTools: null },
      toolCount: 0,
      durationSeconds: 1,
      hasEdits: false,
      status: "success" as const,
    };
    const parse = vi.spyOn(marked, "parse");
    const parseCount = (content: string) =>
      parse.mock.calls.filter(([parsed]) => parsed === content).length;
    const { container, rerender } = render(ActivityFold, { props });
    const summary = container.querySelector<HTMLElement>("summary");
    if (!summary) return;

    expect(parseCount("**cache this thought**")).toBe(0);
    await fireEvent.click(summary);
    await waitFor(() => expect(parseCount("**cache this thought**")).toBe(1));

    await rerender({ ...props, entries: [entry], durationSeconds: 2 });
    expect(parseCount("**cache this thought**")).toBe(1);

    thinkingBlock.thinking = "**revised thought**";
    await rerender({ ...props, entries: [entry], durationSeconds: 3 });
    await waitFor(() => expect(parseCount("**revised thought**")).toBe(1));
    expect(container.querySelector(".activity-thinking strong")?.textContent).toBe(
      "revised thought",
    );
  });

  it("mounts on first open and retains the same nested DOM when reclosed", async () => {
    const { container } = mount();
    const fold = container.querySelector<HTMLDetailsElement>(".activity-fold");
    const summary = fold?.querySelector<HTMLElement>("summary");
    expect(fold).not.toBeNull();
    expect(summary).not.toBeNull();
    if (!fold || !summary) return;

    await fireEvent.click(summary);
    await waitFor(() => expect(fold.dataset.activityBodyMounted).toBe("true"));

    const body = fold.querySelector<HTMLElement>(".activity-body");
    const nestedToolFold = fold.querySelector<HTMLDetailsElement>(".tool-fold");
    expect(fold.open).toBe(true);
    expect(body).toBeInTheDocument();
    expect(fold.querySelector(".activity-thinking strong")?.textContent).toBe("private working");
    expect(fold.querySelector(".tool-diff")).toBeInTheDocument();
    expect(fold.querySelector(".task-tool-card")).toBeInTheDocument();

    if (nestedToolFold) nestedToolFold.open = true;
    await fireEvent.click(summary);

    expect(fold.open).toBe(false);
    expect(fold.querySelector(".activity-body")).toBe(body);
    expect(fold.querySelector(".tool-fold")).toBe(nestedToolFold);
    expect(nestedToolFold?.open).toBe(true);
  });

  it("keeps pending live activity open and mounted", () => {
    const { container } = mount({ live: true, status: "pending" });
    const fold = container.querySelector<HTMLDetailsElement>(".activity-fold.pending");

    expect(fold?.open).toBe(true);
    expect(fold?.dataset.activityBodyMounted).toBe("true");
    expect(fold?.querySelector(".activity-body")).toBeInTheDocument();
    expect(fold?.querySelector(".tool-execution")).toBeInTheDocument();
    expect(fold?.querySelector("summary")?.textContent).toContain("running TaskCreate");
  });
});
