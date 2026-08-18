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

  it("shows every waiting session", () => {
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
      },
    });

    expect(screen.getByRole("link", { name: "Release" })).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Deploy" })).toBeInTheDocument();
  });
});
