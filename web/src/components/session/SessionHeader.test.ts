import { afterEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/svelte";
import SessionHeader from "./SessionHeader.svelte";
import { defaultRuntimeCapabilities } from "../../lib/runtime-capabilities";

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

  it("uses a static title with working-directory context when pinned navigation is enabled", () => {
    const { container } = render(SessionHeader, {
      props: {
        title: "Pinned work",
        cwd: "/Users/yesh/code/personal/pican",
        pinnedNavigationEnabled: true,
      },
    });
    const context = container.querySelector("#session-header-title");
    expect(context?.tagName).toBe("DIV");
    expect(context).not.toHaveAttribute("popovertarget");
    expect(context).toHaveTextContent("Pinned work");
    expect(context).toHaveTextContent("~/code/personal/pican");
    expect(container.querySelector(".session-header-title-chevron")).toBeNull();
    expect(container.querySelector(".session-header-bar")).toHaveClass(
      "session-header-bar--pinned-navigation",
    );
  });

  it("copies the server-provided Pi resume command", async () => {
    const writeText = vi.fn(async () => {});
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const { container } = render(SessionHeader, {
      props: { title: "Pi session", runtime: "pi", resumeCommand: "pi --session pi-uuid" },
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
        runtime: "codex",
        nativeId: "thread-123",
        resumeCommand: "codex resume thread-123",
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

  it("hides runtime actions that the descriptor does not support", () => {
    const { container } = render(SessionHeader, {
      props: {
        title: "Future session",
        runtime: "future",
        runtimeLabel: "Future",
        capabilities: defaultRuntimeCapabilities("future"),
      },
    });

    expect(container.querySelector("#new-session-header-btn")).toBeNull();
    expect(container.querySelector<HTMLButtonElement>("#resume-btn")).toBeDisabled();
    expect(container.querySelector(".session-header-runtime")?.textContent).toContain("F");
  });

  it("uses OpenCode identity and server capabilities without assuming Pi controls", () => {
    const { container } = render(SessionHeader, {
      props: {
        title: "OpenCode session",
        runtime: "opencode",
        runtimeLabel: "OpenCode",
        nativeId: "ses_123",
        capabilities: {
          ...defaultRuntimeCapabilities("opencode"),
          create: true,
          resume: true,
          chat: true,
          cancel: true,
          modelListing: true,
        },
        resumeCommand: "opencode --session ses_123",
      },
    });

    expect(container.querySelector(".session-header-runtime")).toHaveAttribute(
      "title",
      "OpenCode session ses_123",
    );
    expect(container.querySelector(".session-header-runtime-mark")).toHaveTextContent("O");
    expect(container.querySelector("#new-session-header-btn")).not.toBeNull();
    expect(container.querySelector<HTMLButtonElement>("#resume-btn")).not.toBeDisabled();
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
