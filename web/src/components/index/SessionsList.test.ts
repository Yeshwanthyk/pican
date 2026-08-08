import { describe, expect, it } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/svelte";
import { normalizeSession } from "../../index/sessions";
import SessionsList from "./SessionsList.svelte";

const trackedProject = (path: string, sessionCount = 1) => ({
  path,
  enabled: true,
  tracked: true,
  source: "registered" as const,
  sessionCount,
});

describe("SessionsList compact home", () => {
  it("renders the tracked-project empty state without a load-more affordance", () => {
    const { container } = render(SessionsList, {
      props: { sessions: [], projects: [], loading: false, view: "home" },
    });

    expect(container.querySelector('[data-empty="tracked-projects"]')).toBeInTheDocument();
    expect(container.querySelector(".empty-add-project")).toBeInTheDocument();
    expect(container.querySelector(".load-more-btn")).not.toBeInTheDocument();
  });

  it("orders the core Home hierarchy as Pinned then Projects", () => {
    const project = "/Users/example/tracked";
    render(SessionsList, {
      props: {
        sessions: [
          normalizeSession({
            id: "project-session",
            name: "Project session",
            project,
            lastActivity: "2026-07-25T12:00:00Z",
          }),
          normalizeSession({
            id: "untracked-session",
            name: "Untracked session",
            project: "/Users/example/untracked",
            lastActivity: "2026-07-25T12:01:00Z",
          }),
          normalizeSession({
            id: "pinned-session",
            name: "Pinned session",
            project: "/Users/example/other",
            pinned: true,
            pinOrder: 1,
            lastActivity: "2026-07-25T12:02:00Z",
          }),
        ],
        projects: [trackedProject(project)],
        runningSessionIds: new Set(["untracked-session"]),
        loading: false,
        view: "home",
      },
    });

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Pinned", "Projects"]);
    expect(screen.queryByRole("link", { name: "Untracked session" })).not.toBeInTheDocument();
  });

  it("keeps the Pinned and Projects hierarchy legible in the empty state", () => {
    const { container } = render(SessionsList, {
      props: { sessions: [], projects: [], loading: false, view: "home" },
    });

    expect(
      screen.getAllByRole("heading", { level: 2 }).map((heading) => heading.textContent),
    ).toEqual(["Pinned", "Projects"]);
    expect(container.querySelector('[data-empty="pinned"]')).toHaveTextContent(
      "No pinned sessions",
    );
    expect(container.querySelector('[data-empty="tracked-projects"]')).toBeInTheDocument();
  });

  it.each([1, 8])("renders all %i preview pins in stable pin order", (pinCount) => {
    const sessions = Array.from({ length: pinCount }, (_, index) =>
      normalizeSession({
        id: `pin-${index}`,
        name: `Pin ${index}`,
        project: "/Users/example/pins",
        pinned: true,
        pinOrder: index + 1,
        lastActivity: new Date(Date.UTC(2026, 6, 24, 12, index)).toISOString(),
      }),
    ).reverse();
    const { container } = render(SessionsList, {
      props: { sessions, projects: [], loading: false, view: "home" },
    });

    const pinnedGroup = container.querySelector<HTMLElement>(
      '.activity-group[data-bucket="pinned"]',
    );
    expect(pinnedGroup).toBeInTheDocument();
    const ids = Array.from(pinnedGroup?.querySelectorAll<HTMLElement>(".activity-row") ?? []).map(
      (row) => row.dataset.sessionId,
    );
    expect(ids).toEqual(Array.from({ length: pinCount }, (_, index) => `pin-${index}`));
  });

  it("caps a 20-pin preview at eight and expands the complete stable order", async () => {
    const sessions = Array.from({ length: 20 }, (_, index) =>
      normalizeSession({
        id: `pin-${index}`,
        name: `Pin ${index}`,
        project: "/Users/example/pins",
        pinned: true,
        pinOrder: index + 1,
      }),
    ).reverse();
    const { container } = render(SessionsList, {
      props: { sessions, projects: [], loading: false, view: "home" },
    });

    const pinnedGroup = container.querySelector<HTMLElement>(
      '.activity-group[data-bucket="pinned"]',
    );
    expect(pinnedGroup?.querySelectorAll(".activity-row")).toHaveLength(8);
    const showAll = screen.getByRole("button", { name: "All 20" });
    expect(showAll).toHaveAttribute("aria-expanded", "false");

    await fireEvent.click(showAll);

    expect(pinnedGroup?.querySelectorAll(".activity-row")).toHaveLength(20);
    expect(
      Array.from(pinnedGroup?.querySelectorAll<HTMLElement>(".activity-row") ?? []).map(
        (row) => row.dataset.sessionId,
      ),
    ).toEqual(Array.from({ length: 20 }, (_, index) => `pin-${index}`));
    expect(screen.getByRole("button", { name: "Show fewer" })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
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
        projects: [trackedProject(project, 42)],
        loading: false,
        view: "home",
      },
    });

    const group = container.querySelector(`.activity-group[data-project="${project}"]`);
    expect(group?.querySelectorAll(".session-ticker-row")).toHaveLength(6);
    expect(group?.querySelector(".activity-group-action")).toHaveAttribute(
      "href",
      "/?project=%2FUsers%2Fexample%2Fnoisy",
    );
  });

  it("preserves tracked-project ordering", () => {
    const first = "/Users/example/first";
    const second = "/Users/example/second";
    render(SessionsList, {
      props: {
        sessions: [
          normalizeSession({ id: "second-session", project: second }),
          normalizeSession({ id: "first-session", project: first }),
        ],
        projects: [trackedProject(first), trackedProject(second)],
        loading: false,
        view: "home",
      },
    });

    expect(
      screen.getAllByRole("heading", { level: 3 }).map((heading) => heading.textContent),
    ).toEqual(["first", "second"]);
    expect(
      screen.getByRole("heading", { level: 3, name: "first" }).querySelector("a"),
    ).toHaveAttribute("title", first);
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
      projects: [trackedProject(project)],
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
      projects: [trackedProject(project)],
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

    expect(container.querySelector(`[data-project="${project}"] .session-ticker-row`)).toBe(row);
  });
});
