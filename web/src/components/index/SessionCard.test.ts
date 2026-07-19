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

describe("SessionCard runtime badge", () => {
  it("shows a semantic Codex badge and does not use the Pi mark", () => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime: "codex", nativeId: "thread-1" }) },
    });
    expect(screen.getByText("Codex")).toHaveAttribute("title", "Codex runtime");
    expect(container.querySelector(".session-card-runtime-mark")).toHaveAttribute(
      "src",
      "/codex-icon.svg",
    );
    expect(container.querySelector(".session-card-mark")).not.toBeInTheDocument();
    const card = container.querySelector<HTMLElement>(".session-card");
    expect(card).not.toBeNull();
    expect(card?.dataset.search).toContain("codex thread-1");
  });

  it("preserves the legacy Pi card treatment by default", () => {
    const { container } = render(SessionCard, {
      props: { session: session({ runtime: undefined }) },
    });
    expect(screen.queryByText("Codex")).not.toBeInTheDocument();
    expect(container.querySelector(".session-card-mark")).toHaveAttribute("src", "/pi-icon.svg");
    const card = container.querySelector<HTMLElement>(".session-card");
    expect(card).not.toBeNull();
    expect(card?.dataset.search).toContain("pi");
  });
});
