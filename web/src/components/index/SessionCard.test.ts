import "@testing-library/jest-dom/vitest";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SessionCard from "./SessionCard.svelte";
import { normalizeSession } from "../../index/sessions.js";
import type { NormalizedSession } from "../../index/sessions.js";

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

  it("renders the Pi runtime mark", () => {
    const { container } = render(SessionCard, { props: { session: session() } });
    expect(container.querySelector(".session-ticker-runtime-mark")).toHaveAttribute(
      "src",
      "/pi-icon.svg",
    );
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
});
