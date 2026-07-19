import { afterEach, assert, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import ChatToolbar from "./ChatToolbar.svelte";
import { ChatToolbarState } from "./chat-toolbar-state.svelte.js";

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
    // Cancel + Queue surface only while a response is running; Send becomes Steer.
    expect(byId("pi-chat-cancel").style.display).toBe("");
    expect(byId("pi-chat-cancel").textContent).toBe("Cancel");
    expect(byId("pi-chat-queue").style.display).toBe("");
    expect(byId("pi-chat-queue").textContent).toBe("Queue");
    expect(byId("pi-chat-send").textContent).toBe("Steer");
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
});
