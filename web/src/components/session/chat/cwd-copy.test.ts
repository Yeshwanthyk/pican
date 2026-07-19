import { Effect } from "effect";
import { afterEach, assert, describe, expect, it, vi } from "vitest";
import { setupCwdCopy } from "./cwd-copy.js";

function setupDom(): void {
  document.body.innerHTML =
    '<form id="pi-chat-composer"></form><span class="pi-chat-cwd" data-cwd="/tmp/project">cwd: /tmp/project</span>';
}

function query(selector: string): HTMLElement {
  const element = document.querySelector<HTMLElement>(selector);
  assert(element);
  return element;
}

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("cwd copy", () => {
  it("copies the cwd with the Clipboard API and shows a success toast", async () => {
    setupDom();
    const writeText = vi.fn(() => Promise.resolve());
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });

    setupCwdCopy({
      documentImpl: document,
      windowImpl: window,
      tImpl: (key) => key,
    });
    query(".pi-chat-cwd").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(writeText).toHaveBeenCalledWith("/tmp/project");
    expect(query("#pi-chat-cwd-toast").textContent).toBe("composer.pathCopied");
  });

  it("falls back to execCommand when the Clipboard API fails", async () => {
    setupDom();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Effect.runPromise(Effect.fail("denied"))) },
    });
    document.execCommand = vi.fn(() => true);

    setupCwdCopy({
      documentImpl: document,
      windowImpl: window,
      tImpl: (key) => key,
    });
    query(".pi-chat-cwd").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(document.execCommand).toHaveBeenCalledWith("copy");
    expect(query("#pi-chat-cwd-toast").textContent).toBe("composer.pathCopied");
  });

  it("shows an error toast when copy fails", async () => {
    setupDom();
    Object.defineProperty(window.navigator, "clipboard", {
      configurable: true,
      value: { writeText: vi.fn(() => Effect.runPromise(Effect.fail("denied"))) },
    });
    document.execCommand = vi.fn(() => false);

    setupCwdCopy({
      documentImpl: document,
      windowImpl: window,
      tImpl: (key) => key,
    });
    query(".pi-chat-cwd").click();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const toast = query("#pi-chat-cwd-toast");
    expect(toast.textContent).toBe("common.copyFailed");
    expect(toast.style.background).toBe("var(--error)");
  });
});
