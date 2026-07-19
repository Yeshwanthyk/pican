import { describe, expect, it, afterEach } from "vitest";
import { render, cleanup } from "@testing-library/svelte";
import SessionEntry from "./SessionEntry.svelte";
import type { SessionEntry as SessionEntryData } from "../../session/data/session-types.js";

afterEach(cleanup);

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
