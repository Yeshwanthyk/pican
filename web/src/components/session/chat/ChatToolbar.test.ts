import { afterEach, assert, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import ChatToolbar from "./ChatToolbar.svelte";
import { ChatToolbarState } from "./chat-toolbar-state.svelte.js";
import { QueueStore } from "./queue-store.svelte.js";
import { defaultRuntimeCapabilities } from "../../../lib/runtime-capabilities";

function byId(elementId: string): HTMLElement {
  const element = document.getElementById(elementId);
  assert(element);
  return element;
}

function button(elementId: string): HTMLButtonElement {
  const element = document.querySelector<HTMLButtonElement>(`#${elementId}`);
  assert(element);
  return element;
}

afterEach(() => {
  cleanup();
});

describe("ChatToolbar", () => {
  it("renders runtime anchors and reflects toolbar state", () => {
    const toolbar = new ChatToolbarState();
    toolbar.modelLabel = "gpt-test";
    toolbar.setStatus("running", "running");
    render(ChatToolbar, { props: { chatAvailable: true, toolbar } });

    expect(button("pi-chat-attach").disabled).toBe(false);
    expect(byId("pi-chat-status").textContent).toBe("running");
    expect(byId("pi-chat-status").className).toBe("pi-chat-status running");
    expect(button("pi-chat-thinking-label").disabled).toBe(false);
    expect(byId("pi-chat-model-label").textContent).toBe("gpt-test");
    expect(byId("pi-chat-model-label").style.display).toBe("");
    // Stop stays independent from the two clear routing choices.
    expect(byId("pi-chat-cancel").style.display).toBe("");
    expect(byId("pi-chat-cancel").textContent).toBe("Stop");
    expect(byId("pi-chat-queue").style.display).toBe("");
    expect(byId("pi-chat-queue")).toHaveTextContent("Queue next");
    expect(byId("pi-chat-send").textContent).toBe("Steer now");
    expect(byId("pi-chat-send").getAttribute("title")).toBe(
      "Add this message to the response in progress",
    );
  });

  it("falls back to defaults and hides controls when unavailable", () => {
    const toolbar = new ChatToolbarState();
    render(ChatToolbar, { props: { chatAvailable: false, toolbar } });

    expect(button("pi-chat-attach").disabled).toBe(true);
    expect(byId("pi-chat-status").textContent).toBe("unavailable");
    expect(button("pi-chat-thinking-label").disabled).toBe(true);
    expect(byId("pi-chat-thinking-label").style.display).toBe("none");
    expect(button("pi-chat-model-label").disabled).toBe(true);
    expect(byId("pi-chat-model-label").style.display).toBe("none");
    expect(byId("pi-chat-model-label").textContent).toBe("Model");
    expect(button("pi-chat-cancel").disabled).toBe(true);
  });

  it("shows the idle default status when chat is available", () => {
    const toolbar = new ChatToolbarState();
    render(ChatToolbar, { props: { chatAvailable: true, toolbar } });

    expect(byId("pi-chat-status").textContent).toBe("idle");
    expect(byId("pi-chat-cancel").style.display).toBe("none");
    expect(byId("pi-chat-queue").style.display).toBe("none");
    expect(byId("pi-chat-send").textContent).toBe("Send");
  });

  it("keeps the queue button visible while idle when the queue is non-empty", () => {
    const toolbar = new ChatToolbarState();
    const queueStore = new QueueStore();
    queueStore.items = [
      {
        id: "q-1",
        kind: "queued",
        position: 1,
        text: "first",
        displayText: "first",
        createdAt: "2026-01-01T00:00:00Z",
      },
    ];
    render(ChatToolbar, { props: { chatAvailable: true, toolbar, queueStore } });

    expect(byId("pi-chat-queue").style.display).toBe("");
    expect(byId("pi-chat-queue").querySelector(".pi-chat-queue-badge")?.textContent).toBe("1");
    expect(byId("pi-chat-queue").querySelector(".pi-chat-queue-paused")).toBeNull();
  });

  it("keeps the queue button visible while idle when the queue is paused", () => {
    const toolbar = new ChatToolbarState();
    const queueStore = new QueueStore();
    queueStore.setPaused(true);
    render(ChatToolbar, { props: { chatAvailable: true, toolbar, queueStore } });

    expect(byId("pi-chat-queue").style.display).toBe("");
    expect(byId("pi-chat-queue").className).toContain("pi-chat-queue--paused");
    expect(byId("pi-chat-queue").querySelector(".pi-chat-queue-paused")).not.toBeNull();
  });

  it("keeps Stop disabled while an accepted interrupt is settling", () => {
    const toolbar = new ChatToolbarState();
    toolbar.setStatus("stopping", "running");
    render(ChatToolbar, { props: { chatAvailable: true, toolbar } });

    expect(button("pi-chat-cancel").disabled).toBe(true);
    expect(byId("pi-chat-status")).toHaveTextContent("stopping");
  });

  it("omits unsupported runtime controls and prevents steering", () => {
    const toolbar = new ChatToolbarState();
    toolbar.setStatus("running", "running");
    render(ChatToolbar, {
      props: {
        chatAvailable: true,
        toolbar,
        capabilities: { ...defaultRuntimeCapabilities("future"), chat: true },
      },
    });

    expect(document.querySelector("#pi-chat-attach")).toBeNull();
    expect(document.querySelector("#pi-chat-thinking-label")).toBeNull();
    expect(document.querySelector("#pi-chat-model-label")).toBeNull();
    expect(document.querySelector("#pi-chat-cancel")).toBeNull();
    expect(document.querySelector("#pi-chat-queue")).toBeNull();
    expect(byId("pi-chat-send").style.display).toBe("none");
  });

  it("shows only OpenCode's proven live controls", () => {
    const toolbar = new ChatToolbarState();
    toolbar.modelLabel = "anthropic/claude-sonnet-4";
    toolbar.setStatus("running", "running");
    render(ChatToolbar, {
      props: {
        chatAvailable: true,
        toolbar,
        capabilities: {
          ...defaultRuntimeCapabilities("opencode"),
          chat: true,
          cancel: true,
          modelListing: true,
          modelSwitching: true,
        },
      },
    });

    expect(document.querySelector("#pi-chat-attach")).toBeNull();
    expect(document.querySelector("#pi-chat-thinking-label")).toBeNull();
    expect(byId("pi-chat-model-label")).toHaveTextContent("anthropic/claude-sonnet-4");
    expect(byId("pi-chat-cancel")).toHaveTextContent("Stop");
    expect(document.querySelector("#pi-chat-queue")).toBeNull();
    expect(byId("pi-chat-send").style.display).toBe("none");
  });
});
