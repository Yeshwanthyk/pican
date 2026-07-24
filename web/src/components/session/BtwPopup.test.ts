import { afterEach, assert, beforeEach, describe, expect, it, vi } from "vitest";
import { tick } from "svelte";
import { render, cleanup } from "@testing-library/svelte";
import { Option, Schema } from "effect";
const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));
import BtwPopup from "./BtwPopup.svelte";

class FakeEventSource extends EventTarget implements EventSource {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSED = 2;
  static instances: FakeEventSource[] = [];
  readonly CONNECTING = 0;
  readonly OPEN = 1;
  readonly CLOSED = 2;
  readonly withCredentials = false;
  readonly readyState = 1;
  onerror: ((this: EventSource, event: Event) => unknown) | null = null;
  onmessage: ((this: EventSource, event: MessageEvent) => unknown) | null = null;
  onopen: ((this: EventSource, event: Event) => unknown) | null = null;
  private readonly listeners = new Map<string, (event: MessageEvent) => void>();
  closed = false;

  constructor(readonly url: string) {
    super();
    FakeEventSource.instances.push(this);
  }

  addEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: unknown,
    options?: boolean | AddEventListenerOptions,
  ): void {
    void options;
    if (typeof listener === "function") {
      this.listeners.set(type, (event) => listener.call(this, event));
    }
  }

  removeEventListener<K extends keyof EventSourceEventMap>(
    type: K,
    listener: (this: EventSource, event: EventSourceEventMap[K]) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: (this: EventSource, event: MessageEvent) => unknown,
    options?: boolean | EventListenerOptions,
  ): void;
  removeEventListener(
    type: string,
    listener: unknown,
    options?: boolean | EventListenerOptions,
  ): void {
    void listener;
    void options;
    this.listeners.delete(type);
  }

  emit(type: string, data: string): void {
    const event = new MessageEvent(type, { data });
    if (type === "message" && this.onmessage) this.onmessage.call(this, event);
    else this.listeners.get(type)?.(event);
  }

  close(): void {
    this.closed = true;
  }
}

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await flush();
    await tick();
  }
};

// A fetch router that covers every endpoint the popup touches.
interface RouterOverrides {
  readonly new?: unknown;
  readonly btw?: unknown;
  readonly status?: unknown;
  readonly session?: unknown;
  readonly sent?: string[];
}

function jsonResponse(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

function router(overrides: RouterOverrides = {}) {
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    if (url.startsWith("/api/btw/new"))
      return jsonResponse(overrides.new ?? { id: "new-sess.jsonl" });
    if (url.startsWith("/api/btw")) return jsonResponse(overrides.btw ?? { sessionId: "" });
    if (url.startsWith("/api/worker-status"))
      return jsonResponse(overrides.status ?? { state: "idle" });
    if (url.startsWith("/api/session")) return jsonResponse(overrides.session ?? { entries: [] });
    if (url.startsWith("/api/chat/cancel")) return jsonResponse({ ok: true });
    if (url.startsWith("/api/chat")) {
      (overrides.sent || []).push(url);
      return jsonResponse({ status: "queued" });
    }
    void init;
    return jsonResponse({});
  });
}

interface SetupOptions {
  readonly fetchImpl?: typeof window.fetch;
  readonly mobile?: boolean;
  readonly button?: boolean;
  readonly composer?: boolean;
}

function query<ElementType extends Element = HTMLElement>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  assert(element);
  return element;
}

function byId(elementId: string): HTMLElement {
  const element = document.getElementById(elementId);
  assert(element);
  return element;
}

function setupEnv({
  fetchImpl,
  mobile = false,
  button = true,
  composer = false,
}: SetupOptions = {}): void {
  if (button) {
    const b = document.createElement("button");
    b.id = "pi-btw-button";
    b.textContent = "btw";
    document.body.appendChild(b);
  }
  if (composer) {
    const ta = document.createElement("textarea");
    ta.id = "pi-chat-message";
    document.body.appendChild(ta);
  }
  window.fetch = fetchImpl ?? router();
  Object.defineProperty(window, "EventSource", { configurable: true, value: FakeEventSource });
  Object.defineProperty(window, "ResizeObserver", {
    configurable: true,
    value: class FakeResizeObserver {
      observe(): void {}
      disconnect(): void {}
      unobserve(): void {}
    },
  });
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: mobile
      ? (queryValue: string): MediaQueryList => ({
          matches: true,
          media: queryValue,
          onchange: null,
          addEventListener: () => undefined,
          removeEventListener: () => undefined,
          dispatchEvent: () => true,
          addListener: () => undefined,
          removeListener: () => undefined,
        })
      : undefined,
  });
}

beforeEach(() => {
  FakeEventSource.instances = [];
  localStorage.clear();
});

afterEach(() => {
  cleanup();
  document.body.innerHTML = "";
  vi.restoreAllMocks();
  Object.defineProperty(window, "matchMedia", { configurable: true, value: undefined });
});

describe("BtwPopup", () => {
  it("stays hidden when the trigger button is absent", async () => {
    setupEnv({ button: false });
    render(BtwPopup);
    await settle();
    expect(query<HTMLElement>(".pi-btw-window").hidden).toBe(true);
  });

  it("builds the window with new + close + input on open", async () => {
    const fetchImpl = router();
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();

    const w = query<HTMLElement>(".pi-btw-window");
    expect(w.hidden).toBe(false);
    expect(w.querySelector(".pi-btw-new")).not.toBeNull();
    expect(w.querySelector(".pi-btw-close")).not.toBeNull();
    expect(w.querySelector("#pi-btw-input")).not.toBeNull();
    expect(fetchImpl).toHaveBeenCalledWith(
      "/api/btw?parent=__global__",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("renders the transcript as markdown", async () => {
    const fetchImpl = router({
      btw: { sessionId: "sess-1.jsonl" },
      session: {
        entries: [
          { id: "a", type: "message", message: { role: "user", content: "hi" } },
          {
            id: "b",
            type: "message",
            message: { role: "assistant", content: [{ type: "text", text: "**bold** answer" }] },
          },
        ],
      },
    });
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();

    const msgs = document.querySelectorAll(".pi-btw-msg");
    expect(msgs.length).toBe(2);
    const userMessage = msgs[0];
    const assistantMessage = msgs[1];
    assert(userMessage);
    assert(assistantMessage);
    expect(userMessage.textContent?.trim()).toBe("hi");
    expect(assistantMessage.querySelector("strong")).not.toBeNull();
    expect(assistantMessage.textContent).toContain("bold");
  });

  it("renders tool calls as chips", async () => {
    const fetchImpl = router({
      btw: { sessionId: "sess-1.jsonl" },
      session: {
        entries: [
          {
            id: "a",
            type: "message",
            message: {
              role: "assistant",
              content: [
                { type: "text", text: "reading" },
                { type: "toolCall", id: "t1", name: "read", arguments: { path: "/repo/foo.go" } },
              ],
            },
          },
        ],
      },
    });
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();

    const tool = query(".pi-btw-tool");
    expect(tool.textContent).toContain("read");
  });

  it("creates a session then sends when none exists yet, passing cwd + parent", async () => {
    const sent: string[] = [];
    const fetchImpl = router({ new: { id: "new-sess.jsonl" }, sent });
    setupEnv({ fetchImpl });
    render(BtwPopup, { props: { cwd: "/repo/foo", parentId: "parent-1.jsonl" } });

    byId("pi-btw-button").click();
    await settle();

    query<HTMLInputElement>("#pi-btw-input").value = "do a thing";
    byId("pi-btw-form").dispatchEvent(new Event("submit"));
    await settle();

    const call = fetchImpl.mock.calls.find((c) => String(c[0]).startsWith("/api/btw/new"));
    assert(call);
    const init = call[1];
    assert(init);
    assert(typeof init.body === "string");
    expect(init.method).toBe("POST");
    const decodedBody = decodeJson(init.body);
    expect(Option.getOrNull(decodedBody)).toEqual({
      path: "/repo/foo",
      parent: "parent-1.jsonl",
    });
    expect(sent[0]).toContain("new-sess.jsonl");
    expect(document.querySelector(".pi-btw-msg.user")).not.toBeNull();
  });

  it("new button is lazy: clears the window without creating a session", async () => {
    const fetchImpl = router({ btw: { sessionId: "sess-1.jsonl" } });
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();
    query<HTMLElement>(".pi-btw-new").click();
    await settle();

    expect(fetchImpl.mock.calls.some((c) => String(c[0]).startsWith("/api/btw/new"))).toBe(false);
    expect(document.querySelector(".pi-btw-empty")).not.toBeNull();
  });

  it("shows a working indicator and toggles the send button to cancel while running", async () => {
    const fetchImpl = router({ btw: { sessionId: "sess-1.jsonl" } });
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();

    query<HTMLInputElement>("#pi-btw-input").value = "go";
    byId("pi-btw-form").dispatchEvent(new Event("submit"));
    await settle();

    const send = byId("pi-btw-send");
    expect(send.classList.contains("cancel")).toBe(true);
    expect(document.querySelector(".pi-btw-msg.working")).not.toBeNull();

    send.click();
    await settle();
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).startsWith("/api/chat/cancel"))).toBe(
      true,
    );
  });

  it("does not expose cancel when that runtime capability is absent", async () => {
    const fetchImpl = router({ btw: { sessionId: "sess-1.jsonl" } });
    setupEnv({ fetchImpl });
    render(BtwPopup, { props: { canCancel: false } });

    byId("pi-btw-button").click();
    await settle();
    query<HTMLInputElement>("#pi-btw-input").value = "go";
    byId("pi-btw-form").dispatchEvent(new Event("submit"));
    await settle();

    const send = byId("pi-btw-send");
    expect(send.style.display).toBe("none");
    send.click();
    await settle();
    expect(fetchImpl.mock.calls.some((c) => String(c[0]).startsWith("/api/chat/cancel"))).toBe(
      false,
    );
  });

  it.each(["pacman", "comet"])("uses the %s activity indicator while working", async (style) => {
    localStorage.setItem("pican:spinner-style", style);
    const fetchImpl = router({ btw: { sessionId: "sess-1.jsonl" } });
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();
    query<HTMLInputElement>("#pi-btw-input").value = "go";
    byId("pi-btw-form").dispatchEvent(new Event("submit"));
    await settle();

    expect(document.querySelector(`.pi-btw-spinner.activity-indicator--${style}`)).not.toBeNull();
  });

  it("renders streaming assistant text from chat-preview events", async () => {
    const fetchImpl = router({ btw: { sessionId: "sess-1.jsonl" } });
    setupEnv({ fetchImpl });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();

    const es = FakeEventSource.instances.find((e) => e.url.includes("sess-1.jsonl"));
    assert(es);
    es.emit("chat-preview", JSON.stringify({ content: "partial answer", done: false }));
    await settle();

    const streaming = query(".pi-btw-msg.assistant.working .pi-btw-md");
    expect(streaming.textContent).toContain("partial answer");
  });

  it("switches session in realtime on a per-parent btw-changed event", async () => {
    const fetchImpl = router({ btw: { sessionId: "sess-1.jsonl" } });
    setupEnv({ fetchImpl });
    render(BtwPopup, { props: { parentId: "parent-1.jsonl" } });

    byId("pi-btw-button").click();
    await settle();

    const globalES = FakeEventSource.instances.find((e) => e.url.includes("parent-1.jsonl"));
    assert(globalES);
    globalES.emit("btw-changed", JSON.stringify({ sessionId: "sess-2.jsonl" }));
    await settle();

    expect(FakeEventSource.instances.some((e) => e.url.includes("sess-2.jsonl"))).toBe(true);
  });

  it("closes when the main composer is focused on mobile", async () => {
    setupEnv({ mobile: true, composer: true });
    render(BtwPopup);

    byId("pi-btw-button").click();
    await settle();
    expect(query<HTMLElement>(".pi-btw-window").hidden).toBe(false);

    byId("pi-chat-message").dispatchEvent(new FocusEvent("focus"));
    await tick();
    expect(query<HTMLElement>(".pi-btw-window").hidden).toBe(true);
  });

  it("does not auto-reopen on mobile even if it was open before", async () => {
    localStorage.setItem("pican:btw:window", JSON.stringify({ open: true }));
    setupEnv({ mobile: true });
    render(BtwPopup);
    await settle();
    expect(query<HTMLElement>(".pi-btw-window").hidden).toBe(true);
  });

  it("does not auto-reopen or fetch when btw is unsupported", async () => {
    localStorage.setItem("pican:btw:window", JSON.stringify({ open: true }));
    const fetchImpl = router();
    setupEnv({ fetchImpl });
    render(BtwPopup, { props: { enabled: false } });
    await settle();

    expect(byId("pi-btw-button").hidden).toBe(true);
    expect(query<HTMLElement>(".pi-btw-window").hidden).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("toggles closed on a second button click", async () => {
    setupEnv();
    render(BtwPopup);
    const btn = byId("pi-btw-button");

    btn.click();
    await settle();
    btn.click();
    await tick();

    expect(query<HTMLElement>(".pi-btw-window").hidden).toBe(true);
    expect(btn.getAttribute("aria-expanded")).toBe("false");
  });
});
