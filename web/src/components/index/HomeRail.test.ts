import "@testing-library/jest-dom/vitest";
import { fireEvent, render, screen } from "@testing-library/svelte";
import { describe, expect, it, vi } from "vitest";
import { normalizeSession } from "../../index/sessions.js";
import HomeRail from "./HomeRail.svelte";

describe("HomeRail", () => {
  it("shows a waiting question and sends an inline answer", async () => {
    const onAnswer = vi.fn(async () => true);
    const waiting = normalizeSession({
      id: "waiting.jsonl",
      name: "Release",
      project: "/repo",
      waitingQuestion: "Ship it?",
      waitingOptions: ["Ship", "Hold"],
    });
    render(HomeRail, { props: { waitingSessions: [waiting], onAnswer } });

    expect(screen.getByText("Waiting on you")).toBeInTheDocument();
    await fireEvent.click(screen.getByRole("button", { name: "Answer Ship for Ship it?" }));
    expect(onAnswer).toHaveBeenCalledWith(waiting, "Ship");
  });

  it("shows every waiting session alongside schedules", () => {
    render(HomeRail, {
      props: {
        waitingSessions: [
          normalizeSession({
            id: "release.jsonl",
            name: "Release",
            waitingQuestion: "Ship it?",
          }),
          normalizeSession({
            id: "deploy.jsonl",
            name: "Deploy",
            waitingQuestion: "Choose a region",
          }),
        ],
        schedules: [
          {
            id: "daily",
            name: "Daily digest",
            instructions: "Summarize",
            modelProvider: "",
            modelId: "",
            thinkingLevel: "",
            projectPath: "/repo",
            cronExpr: "0 9 * * *",
            timezone: "America/Toronto",
            enabled: true,
            nextRunAt: "2026-07-20T13:00:00Z",
            createdAt: "2026-07-19T00:00:00Z",
            updatedAt: "2026-07-19T00:00:00Z",
          },
        ],
      },
    });

    expect(screen.getByRole("link", { name: "Release" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deploy" })).toBeInTheDocument();
    expect(screen.getByText("Schedules")).toBeInTheDocument();
    expect(screen.getByText("1 active")).toBeInTheDocument();
  });

  it("shows the idle schedules summary", () => {
    render(HomeRail, {
      props: {
        schedules: [
          {
            id: "daily",
            name: "Daily digest",
            instructions: "Summarize",
            modelProvider: "",
            modelId: "",
            thinkingLevel: "",
            projectPath: "/repo",
            cronExpr: "0 9 * * *",
            timezone: "America/Toronto",
            enabled: true,
            nextRunAt: "2026-07-20T13:00:00Z",
            createdAt: "2026-07-19T00:00:00Z",
            updatedAt: "2026-07-19T00:00:00Z",
          },
        ],
      },
    });
    expect(screen.getByText("1 active")).toBeInTheDocument();
    expect(screen.getByText(/Next: Daily digest/)).toBeInTheDocument();
  });
});
