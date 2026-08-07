import { describe, expect, it, afterEach, vi } from "vitest";
import { render, cleanup, fireEvent } from "@testing-library/svelte";
import SessionEntry from "./SessionEntry.svelte";
import type { SessionEntry as SessionEntryData } from "../../session/data/session-types.js";
import type { ToolResultLookup } from "../../session/data/session-data.svelte.js";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function model(entries: SessionEntryData[] = []) {
  return { entries, renderedTools: null };
}

describe("SessionEntry", () => {
  it("renders a user message with its text under an entry anchor", () => {
    const entry = { id: "u", type: "message", message: { role: "user", content: "hello" } };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });
    const node = container.querySelector("#entry-u");
    expect(node).not.toBeNull();
    expect(node).toHaveClass("user-message");
    expect(node?.textContent).toContain("hello");
    expect(node?.querySelector(".user-who")?.textContent).toContain("YOU");
  });

  it("hides unavailable fork and removes message label editing", () => {
    const entry = { id: "u", type: "message", message: { role: "user", content: "hello" } };
    const { container } = render(SessionEntry, {
      props: { entry, model: model([entry]), live: true, canFork: false },
    });
    expect(container.querySelector(".fork-btn")).toBeNull();
    expect(container.querySelector(".label-btn")).toBeNull();
    expect(container.querySelector('[aria-label="Add or edit label"]')).toBeNull();
  });

  it("copies only the user message content and shows brief feedback", async () => {
    vi.useFakeTimers();
    const copyText = vi.fn(async () => true);
    const entry = {
      id: "u",
      type: "message",
      timestamp: "2026-01-01T00:00:00Z",
      message: { role: "user", content: "hello **there**" },
    };
    const { container } = render(SessionEntry, {
      props: { entry, model: model([entry]), copyText },
    });

    const copy = container.querySelector<HTMLButtonElement>(".copy-message-btn");
    expect(copy).toHaveAttribute("aria-label", "Copy message");
    if (!copy) return;
    await fireEvent.click(copy);

    expect(copyText).toHaveBeenCalledWith("hello **there**");
    await Promise.resolve();
    expect(copy).toHaveAttribute("aria-label", "Copied");
    expect(copy.querySelector('[aria-live="polite"]')?.textContent).toBe("Copied");

    vi.advanceTimersByTime(1500);
    await vi.runAllTimersAsync();
    expect(copy).toHaveAttribute("aria-label", "Copy message");
  });

  it("copies only assistant text blocks, excluding thinking and tool activity", async () => {
    const copyText = vi.fn(async () => true);
    const entry = {
      id: "a",
      type: "message",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "private reasoning" },
          { type: "text", text: "First paragraph." },
          { type: "toolCall", id: "call-1", name: "read", arguments: {} },
          { type: "text", text: "Second paragraph." },
        ],
      },
    };
    const { container } = render(SessionEntry, {
      props: { entry, model: model([entry]), copyText },
    });

    const copy = container.querySelector<HTMLButtonElement>(".copy-message-btn");
    expect(copy).not.toBeNull();
    if (!copy) return;
    await fireEvent.click(copy);

    expect(copyText).toHaveBeenCalledWith("First paragraph.\n\nSecond paragraph.");
  });

  it("renders an assistant message", () => {
    const entry = {
      id: "a",
      type: "message",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });
    const node = container.querySelector("#entry-a");
    expect(node).toHaveClass("assistant-message");
    expect(node?.textContent).toContain("hi");
    expect(node?.querySelector(".assistant-who")?.textContent).toBe("ASSISTANT");
  });

  it("uses indexed activity results without scanning entries", () => {
    const entry: SessionEntryData = {
      id: "indexed-assistant",
      type: "message",
      message: {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "indexed-edit",
            name: "edit",
            arguments: { path: "indexed.ts" },
          },
        ],
      },
    };
    const resultEntry: SessionEntryData = {
      id: "indexed-edit-result",
      type: "message",
      message: {
        role: "toolResult",
        toolCallId: "indexed-edit",
        isError: true,
        content: [],
        details: { diff: "@@ -1 +1 @@\n-old\n+new" },
      },
    };
    const lookup: ToolResultLookup = {
      entry: resultEntry,
      message: resultEntry.message!,
      details: { diff: "@@ -1 +1 @@\n-old\n+new" },
      resultCount: 1,
      hasError: true,
      hasEdits: true,
    };
    const entriesRead = vi.fn((): SessionEntryData[] => []);
    const indexedModel = {
      get entries(): SessionEntryData[] {
        return entriesRead();
      },
      toolResultMap: new Map([["indexed-edit", lookup]]),
      renderedTools: null,
    };

    const { container } = render(SessionEntry, { props: { entry, model: indexedModel } });

    expect(entriesRead).not.toHaveBeenCalled();
    expect(container.querySelector(".activity-fold.error")).not.toBeNull();
    expect(container.querySelector(".tool-fold-status")?.classList).toContain("error");
    expect(container.querySelector(".tool-diff-sheet")).not.toBeNull();
  });

  it("renders thinking through the safe Markdown pipeline", () => {
    const entry = {
      id: "thinking",
      type: "message",
      message: {
        role: "assistant",
        content: [{ type: "thinking", thinking: "**Checking the package**\n\n- inspect exports" }],
      },
    };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });

    expect(container.querySelector(".activity-thinking-text strong")?.textContent).toBe(
      "Checking the package",
    );
    expect(container.querySelector(".activity-thinking-text li")?.textContent).toBe(
      "inspect exports",
    );
    expect(container.querySelector(".activity-thinking-text")?.textContent).not.toContain("**");
  });

  it("renders nothing for tool-result entries", () => {
    const entry = {
      id: "r",
      type: "message",
      message: { role: "toolResult", toolCallId: "c", content: [] },
    };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });
    expect(container.querySelector("#entry-r")).toBeNull();
  });

  it("renders a model change but omits implicit ones", () => {
    const entry = { id: "m", type: "model_change", provider: "p", modelId: "x" };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });
    expect(container.querySelector("#entry-m.model-change")?.textContent).toContain("p/x");

    cleanup();
    const implicit = {
      id: "m2",
      type: "model_change",
      provider: "p",
      modelId: "x",
      implicit: true,
    };
    const { container: c2 } = render(SessionEntry, {
      props: { entry: implicit, model: model([implicit]) },
    });
    expect(c2.querySelector("#entry-m2")).toBeNull();
  });

  it("renders a collapsed subagent result card", () => {
    const entry = {
      id: "subagent-result",
      type: "custom_message",
      customType: "subagent-result",
      content: "**Review complete**",
      display: true,
      details: { id: "agent-1", title: "Review UI", status: "done" },
    };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });

    const card = container.querySelector("#entry-subagent-result");
    expect(card).toHaveClass("subagent-result-card", "done");
    expect(card?.querySelector(".subagent-result-header")?.textContent).toContain(
      "Subagent agent-1 — Review UI",
    );
    expect(card?.querySelector<HTMLDetailsElement>("details")?.open).toBe(false);
    expect(card?.querySelector("strong")?.textContent).toBe("Review complete");
  });

  it("keeps the generic custom message renderer for other custom types", () => {
    const entry = {
      id: "custom",
      type: "custom_message",
      customType: "notice",
      content: "Heads up",
      display: true,
    };
    const { container } = render(SessionEntry, { props: { entry, model: model([entry]) } });

    expect(container.querySelector(".hook-type")?.textContent).toBe("[notice]");
    expect(container.querySelector(".subagent-result-card")).toBeNull();
  });
});
