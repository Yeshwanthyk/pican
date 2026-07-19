import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import SessionHeader from "./SessionHeader.svelte";

const originalClipboard = navigator.clipboard;

afterEach(() => {
  vi.unstubAllGlobals();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: originalClipboard,
  });
});

describe("SessionHeader runtime commands", () => {
  it("uses the centered title as the pinned-session switcher trigger", () => {
    const { container } = render(SessionHeader, { props: { title: "Pinned work" } });
    const trigger = container.querySelector("#session-header-title");
    expect(trigger?.tagName).toBe("BUTTON");
    expect(trigger).toHaveAttribute("popovertarget", "pinned-session-switcher");
    expect(trigger).toHaveAccessibleName("Switch pinned session");
    expect(trigger?.querySelector(".session-header-runtime-mark")).toHaveAttribute(
      "src",
      "/pi-icon.svg",
    );
  });

  it("copies the legacy Pi resume command from the session UUID", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(SessionHeader, {
      props: { title: "Pi session", sessionUUID: "pi-uuid", runtime: "pi" },
    });

    const resume = container.querySelector("#resume-btn");
    expect(resume).toHaveAttribute("title", "Copy pi --session pi-uuid to clipboard");
    resume?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("pi --session pi-uuid"));
  });

  it("copies Codex resume with nativeId and identifies the runtime in page metadata", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(SessionHeader, {
      props: {
        title: "Codex session",
        sessionUUID: "projection-id",
        runtime: "codex",
        nativeId: "thread-123",
      },
    });

    const resume = container.querySelector("#resume-btn");
    expect(resume).toHaveAttribute("title", "Copy codex resume thread-123 to clipboard");
    expect(container.querySelector(".session-header-runtime")).toHaveAttribute(
      "title",
      "Codex thread thread-123",
    );
    expect(container.querySelector(".session-header-runtime-mark")).toHaveAttribute(
      "src",
      "/codex-icon.svg",
    );
    expect(document.title).toBe("Codex session · Codex");
    resume?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("codex resume thread-123"));
  });

  it("preserves runtime when starting a sibling session", async () => {
    const fetchImpl = vi.fn(async () => ({
      json: async () => ({ error: "stop" }),
    }));
    vi.stubGlobal("fetch", fetchImpl);
    const { container } = render(SessionHeader, {
      props: {
        title: "Codex session",
        cwd: "/repo",
        sessionId: "projection.jsonl",
        runtime: "codex",
        nativeId: "thread-123",
      },
    });

    container.querySelector<HTMLButtonElement>("#new-btn")?.click();
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(fetchImpl).toHaveBeenCalledWith("/api/new-session", {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        path: "/repo",
        sourceSessionId: "projection.jsonl",
        runtime: "codex",
      }),
      signal: expect.any(AbortSignal),
    });
  });

  it("shows danger worker-down and attention view-only substates", () => {
    const crashed = render(SessionHeader, {
      props: { title: "Crashed", workerStatus: { state: "error", exitCode: 9 } },
    });
    expect(crashed.container.querySelector(".session-header-state--danger")).toHaveTextContent(
      "worker down",
    );
    crashed.unmount();

    const viewOnly = render(SessionHeader, {
      props: { title: "Archive", chatAvailable: false },
    });
    expect(viewOnly.container.querySelector(".session-header-state--attention")).toHaveTextContent(
      "view only",
    );
  });
});
