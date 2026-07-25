import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/svelte";
import SessionCard from "./SessionCard.svelte";
import { normalizeSession } from "../../index/sessions.js";
import type { NormalizedSession } from "../../index/sessions.js";

afterEach(() => vi.unstubAllGlobals());

function session(overrides: Partial<NormalizedSession> = {}): NormalizedSession {
  return normalizeSession({
    id: "session.jsonl",
    name: "Session",
    project: "/repo",
    lastActivity: "2026-01-01T00:00:00Z",
    chatAvailable: true,
    model: "model",
    modelProvider: "provider",
    runtime: "pi",
    ...overrides,
  });
}

describe("SessionCard ticker row", () => {
  it("renders the flat title, context, metrics, and inline markers", () => {
    const { container } = render(SessionCard, {
      props: {
        session: session({
          runtime: "codex",
          nativeId: "thread-1",
          pinned: true,
          btw: true,
          tokenTotal: 1200,
          costTotal: 0.25,
        }),
        now: Date.parse("2026-01-01T00:01:00Z"),
      },
    });
    const row = container.querySelector<HTMLElement>(".session-ticker-row");
    expect(row).not.toBeNull();
    expect(row?.dataset.search).toContain("codex thread-1");
    expect(container.querySelector(".session-card")).not.toBeInTheDocument();
    expect(screen.getByText("⌖")).toBeInTheDocument();
    expect(screen.getByText("~")).toBeInTheDocument();
    expect(screen.getByText("/repo")).toBeInTheDocument();
    expect(screen.getByText("provider/model")).toBeInTheDocument();
    expect(container.querySelector(".session-ticker-runtime-mark")).toHaveAttribute(
      "src",
      "/codex-icon.svg",
    );
    expect(screen.getByText("1.2k tok · $0.25")).toBeInTheDocument();
  });

  it.each([
    ["pi", "/pi-icon.svg"],
    ["claude", "/claude-icon.svg"],
  ])("renders the %s runtime mark", (runtime, src) => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime }) },
    });
    expect(container.querySelector(".session-ticker-runtime-mark")).toHaveAttribute("src", src);
  });

  it("renders an OpenCode mark without using another runtime's icon", () => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime: "opencode" }) },
    });
    const mark = container.querySelector(".session-ticker-runtime-mark");
    expect(mark).toHaveTextContent("O");
    expect(mark).toHaveAttribute("title", "OpenCode");
    expect(mark).not.toHaveAttribute("src");
  });

  it("renders running and waiting status lines with distinct semantics", () => {
    const now = Date.parse("2026-01-01T00:02:00Z");
    const running = render(SessionCard, {
      props: {
        session: session({ currentActivity: "bash", activityStartedAt: "2026-01-01T00:00:00Z" }),
        running: true,
        now,
      },
    });
    expect(running.container.querySelector(".session-ticker-row--running")).toBeInTheDocument();
    expect(screen.getByText("bash · 2m")).toBeInTheDocument();
    running.unmount();

    const waiting = render(SessionCard, {
      props: {
        session: session({
          waitingQuestion: "Ship it?",
          waitingSince: "2026-01-01T00:00:00Z",
          waitingOptions: ["Ship", "Hold"],
        }),
        running: true,
        now,
      },
    });
    expect(waiting.container.querySelector(".session-ticker-row--waiting")).toBeInTheDocument();
    expect(screen.getByText("waiting 2m — Ship it?")).toBeInTheDocument();
  });

  it("disables archive with a precise running or waiting reason", () => {
    const running = render(SessionCard, {
      props: { session: session(), running: true },
    });
    expect(screen.getByRole("button", { name: "Archive session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive session" })).toHaveAttribute(
      "title",
      "Stop this session before archiving it.",
    );
    running.unmount();

    render(SessionCard, {
      props: { session: session({ waitingQuestion: "Ship it?" }), running: true },
    });
    expect(screen.getByRole("button", { name: "Archive session" })).toBeDisabled();
    expect(screen.getByRole("button", { name: "Archive session" })).toHaveAttribute(
      "title",
      "Answer this session before archiving it.",
    );
  });

  it("keeps narrow session actions behind one labeled menu trigger", async () => {
    render(SessionCard, {
      props: { session: session() },
    });

    const trigger = screen.getByRole("button", { name: "More session actions" });
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();

    await fireEvent.click(trigger);
    expect(trigger).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByRole("menu")).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Pin session" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "Archive session" })).toBeInTheDocument();
  });

  it("optimistically archives and restores through the local archive endpoint", async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(new Response(JSON.stringify({ ok: true }), { status: 200 })),
    );
    vi.stubGlobal("fetch", fetchMock);
    const value = session();
    const { rerender } = render(SessionCard, { props: { session: value } });

    await fireEvent.click(screen.getByRole("button", { name: "Archive session" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore session" })).toBeInTheDocument(),
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Restore session" })).not.toBeDisabled(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/archives",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "session.jsonl", archived: true }),
      }),
    );

    await rerender({ session: value });
    await fireEvent.click(screen.getByRole("button", { name: "Restore session" }));
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Archive session" })).toBeInTheDocument(),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/archives",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ sessionId: "session.jsonl", archived: false }),
      }),
    );
  });
});
