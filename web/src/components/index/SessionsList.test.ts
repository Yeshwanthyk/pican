import { describe, expect, it } from "vitest";
import { render } from "@testing-library/svelte";
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

    const group = container.querySelector(`[data-project="${project}"]`);
    expect(group?.querySelectorAll(".session-ticker-row")).toHaveLength(6);
    expect(group?.querySelector(".project-view-all")).toHaveAttribute(
      "href",
      "/?project=%2FUsers%2Fexample%2Fnoisy",
    );
  });
});
