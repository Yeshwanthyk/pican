import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/svelte";
import SessionsList from "./SessionsList.svelte";

describe("SessionsList plain states", () => {
  it("renders the first-run instruction with the default project", () => {
    const { container } = render(SessionsList, {
      props: { sessions: [], loading: false, defaultProject: "~/code/pican" },
    });

    expect(container.querySelector('[data-empty="first-run"]')).toBeInTheDocument();
    expect(screen.getByText("no sessions yet")).toBeInTheDocument();
    expect(screen.getByText("press + to start one in ~/code/pican")).toBeInTheDocument();
  });
});
