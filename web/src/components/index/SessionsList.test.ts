import { describe, expect, it } from "vitest";
import { fireEvent, render, within } from "@testing-library/svelte";
import { normalizeSession } from "../../index/sessions";
import SessionsList from "./SessionsList.svelte";

describe("SessionsList focused home", () => {
  it("renders the tracked-project empty state without a load-more affordance", () => {
    const { container } = render(SessionsList, {
      props: { sessions: [], projects: [], loading: false, view: "home" },
    });

    expect(container.querySelector('[data-empty="tracked-projects"]')).toBeInTheDocument();
    expect(container.querySelector(".empty-add-project")).toBeInTheDocument();
    expect(container.querySelector(".load-more-btn")).not.toBeInTheDocument();
  });

  it("caps each tracked-project preview at six and links to its full count", () => {
    const project = "/Users/example/noisy";
    const sessions = Array.from({ length: 8 }, (_, index) =>
      normalizeSession({
        id: `session-${index}`,
        project,
        lastActivity: new Date(Date.UTC(2026, 6, 24, 12, index)).toISOString(),
      }),
    );
    const { container } = render(SessionsList, {
      props: {
        sessions,
        projects: [
          { path: project, enabled: true, tracked: true, source: "registered", sessionCount: 42 },
        ],
        loading: false,
        view: "home",
      },
    });

    const heading = container.querySelector(`.home-feed-heading[data-project="${project}"]`);
    expect(
      container.querySelectorAll(
        `.home-feed-session[data-project="${project}"] .session-ticker-row`,
      ),
    ).toHaveLength(6);
    expect(heading?.querySelector(".project-view-all")).toHaveAttribute(
      "href",
      "/?project=%2FUsers%2Fexample%2Fnoisy",
    );
  });

  it("preserves a tracked session row in its project when live state changes", async () => {
    const project = "/Users/example/live";
    const value = normalizeSession({
      id: "live-session",
      project,
      lastActivity: "2026-07-25T12:00:00Z",
    });
    const props = {
      sessions: [value],
      projects: [
        { path: project, enabled: true, tracked: true, source: "registered", sessionCount: 1 },
      ],
      loading: false,
      view: "home" as const,
      runningSessionIds: new Set<string>(),
    };
    const { container, rerender } = render(SessionsList, { props });
    const row = container.querySelector<HTMLElement>(".session-ticker-row");
    expect(row).not.toBeNull();

    const more = within(row as HTMLElement).getByRole("button", {
      name: "More session actions",
    });
    await fireEvent.click(more);
    expect(more).toHaveAttribute("aria-expanded", "true");

    await rerender({
      ...props,
      runningSessionIds: new Set(["live-session"]),
    });

    const stableRow = container.querySelector<HTMLElement>(
      `[data-project="${project}"] .session-ticker-row`,
    );
    expect(container.querySelector('[data-bucket="now"] .session-ticker-row')).toBeNull();
    expect(stableRow).toBe(row);
    expect(
      within(stableRow as HTMLElement).getByRole("button", {
        name: "More session actions",
      }),
    ).toHaveAttribute("aria-expanded", "true");
  });

  it("preserves a tracked session row in its project when waiting metadata changes", async () => {
    const project = "/Users/example/waiting";
    const value = normalizeSession({
      id: "waiting-session",
      project,
      lastActivity: "2026-07-25T12:00:00Z",
    });
    const props = {
      sessions: [value],
      projects: [
        { path: project, enabled: true, tracked: true, source: "registered", sessionCount: 1 },
      ],
      loading: false,
      view: "home" as const,
    };
    const { container, rerender } = render(SessionsList, { props });
    const row = container.querySelector<HTMLElement>(".session-ticker-row");

    await rerender({
      ...props,
      sessions: [
        normalizeSession({
          ...value,
          waitingQuestion: "Ship it?",
          waitingSince: "2026-07-25T12:01:00Z",
        }),
      ],
    });

    expect(container.querySelector('[data-bucket="now"] .session-ticker-row')).toBeNull();
    expect(container.querySelector(`[data-project="${project}"] .session-ticker-row`)).toBe(row);
  });
});
