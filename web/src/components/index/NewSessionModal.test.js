import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/svelte";
import userEvent from "@testing-library/user-event";
import NewSessionModal from "./NewSessionModal.svelte";

describe("NewSessionModal runtimes", () => {
  it("selects the server default and disables unavailable runtimes with their reason", async () => {
    const fetchRuntimes = vi.fn(async () => ({
      defaultRuntime: "codex",
      runtimes: [
        { id: "pi", available: false, reason: "pi is not installed" },
        { id: "codex", available: true },
      ],
    }));
    render(NewSessionModal, { props: { open: true, fetchRuntimes } });

    const codex = await screen.findByRole("radio", { name: "Codex" });
    const pi = screen.getByRole("radio", { name: /Pi/ });
    expect(codex).toHaveAttribute("aria-checked", "true");
    expect(codex.querySelector(".runtime-segment-mark")).toHaveAttribute("src", "/codex-icon.svg");
    expect(pi.querySelector(".runtime-segment-mark")).toHaveAttribute("src", "/pi-icon.svg");
    expect(pi).toBeDisabled();
    expect(pi).toHaveTextContent("pi is not installed");

    await userEvent.click(pi);
    expect(codex).toHaveAttribute("aria-checked", "true");
    expect(fetchRuntimes).toHaveBeenCalledTimes(1);
  });

  it("supports radio-group arrow keys while skipping unavailable runtimes", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "pi",
          runtimes: [
            { id: "pi", available: true },
            { id: "unavailable", available: false, reason: "disabled" },
            { id: "codex", available: true },
          ],
        }),
      },
    });

    const pi = await screen.findByRole("radio", { name: "Pi" });
    const codex = screen.getByRole("radio", { name: "Codex" });
    pi.focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(codex).toHaveFocus();
    expect(codex).toHaveAttribute("aria-checked", "true");
    await userEvent.keyboard("{ArrowLeft}");
    expect(pi).toHaveAttribute("aria-checked", "true");
  });

  it("shows the reason and disables creation when the only runtime is unavailable", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "codex",
          runtimes: [{ id: "codex", available: false, reason: "startup sync failed" }],
        }),
      },
    });

    const codex = await screen.findByRole("radio", { name: /Codex/ });
    expect(codex).toBeDisabled();
    expect(codex).toHaveTextContent("startup sync failed");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("keeps the old single-Pi flow free of a runtime selector", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "pi",
          runtimes: [{ id: "pi", available: true }],
        }),
      },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(screen.queryByRole("radiogroup", { name: "Runtime" })).not.toBeInTheDocument();
  });

  it("silently enables creation when Codex is the only runtime", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "codex",
          runtimes: [{ id: "codex", available: true }],
        }),
      },
    });

    await waitFor(() => expect(screen.getByRole("button", { name: "Create" })).toBeEnabled());
    expect(screen.queryByRole("radiogroup", { name: "Runtime" })).not.toBeInTheDocument();
  });
});
