import "@testing-library/jest-dom/vitest";
import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/svelte";
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

describe("SessionCard compatibility wrapper", () => {
  it("renders a flat two-line activity row with quiet session metadata", () => {
    const { container } = render(SessionCard, {
      props: {
        session: session({
          runtime: "codex",
          nativeId: "thread-1",
          pinned: true,
          tokenTotal: 1200,
          costTotal: 0.25,
        }),
        now: Date.parse("2026-01-01T00:01:00Z"),
      },
    });

    const row = container.querySelector<HTMLElement>(".activity-row");
    const titleLine = container.querySelector(".activity-row-title-line");
    const metadataLine = container.querySelector(".activity-row-meta");
    expect(row).not.toBeNull();
    expect(row?.dataset.search).toContain("codex thread-1");
    expect(container.querySelector(".session-card")).not.toBeInTheDocument();
    expect(container.querySelectorAll(".activity-row-marker")).toHaveLength(1);
    expect(titleLine).toHaveTextContent("Session");
    expect(metadataLine).toHaveTextContent("idle");
    expect(metadataLine).toHaveTextContent("/repo");
    expect(metadataLine).toHaveTextContent("Codex");
    expect(metadataLine).toHaveTextContent("1 minute ago");
    expect(container.querySelector(".session-ticker-status")).not.toBeInTheDocument();
    expect(container.querySelector(".session-ticker-foot")).not.toBeInTheDocument();
    expect(container.querySelector(".activity-row-icon img")).toHaveAttribute(
      "src",
      "/codex-icon.svg",
    );
  });

  it.each([
    ["pi", "/pi-icon.svg"],
    ["claude", "/claude-icon.svg"],
  ])("renders the %s runtime type mark for idle activity", (runtime, src) => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime }) },
    });
    expect(container.querySelector(".activity-row-icon img")).toHaveAttribute("src", src);
  });

  it("renders an OpenCode type mark without using another runtime's icon", () => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime: "opencode" }) },
    });
    const mark = container.querySelector(".activity-row-icon > span");
    expect(mark).toHaveTextContent("O");
    expect(mark).toHaveAttribute("title", "OpenCode");
    expect(container.querySelector(".activity-row-icon img")).not.toBeInTheDocument();
  });

  it("keeps active status, project, runtime, and age on the second and final line", () => {
    const now = Date.parse("2026-01-01T00:02:00Z");
    const running = render(SessionCard, {
      props: {
        session: session({ currentActivity: "bash", activityStartedAt: "2026-01-01T00:00:00Z" }),
        running: true,
        now,
      },
    });
    const runningRow = running.container.querySelector<HTMLElement>(".activity-row");
    const runningMeta = running.container.querySelector<HTMLElement>(".activity-row-meta");
    expect(runningRow).toHaveAttribute("data-activity-state", "running");
    expect(runningMeta).toHaveAttribute("data-active-metadata");
    expect(runningMeta).toHaveTextContent("bash · 2m");
    expect(runningMeta).toHaveTextContent("/repo");
    expect(runningMeta).toHaveTextContent("Pi");
    expect(runningMeta).toHaveTextContent("2 minutes ago");
    expect(running.container.querySelector(".activity-row-copy")?.children).toHaveLength(2);
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
    expect(waiting.container.querySelector(".activity-row")).toHaveAttribute(
      "data-activity-state",
      "waiting",
    );
    expect(waiting.container.querySelector(".activity-row-meta")).toHaveTextContent(
      "waiting 2m — Ship it?",
    );
    expect(waiting.container.querySelector(".activity-row-copy")?.children).toHaveLength(2);
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
    expect(trigger.closest(".activity-row")).toHaveClass("activity-row--menu-open");
    const menu = screen.getByRole("menu");
    expect(within(menu).getByRole("menuitem", { name: "Pin session" })).toBeInTheDocument();
    expect(within(menu).getByRole("menuitem", { name: "Archive session" })).toBeInTheDocument();

    await fireEvent.click(document.body);
    expect(trigger).toHaveAttribute("aria-expanded", "false");
    expect(trigger.closest(".activity-row")).not.toHaveClass("activity-row--menu-open");
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
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
