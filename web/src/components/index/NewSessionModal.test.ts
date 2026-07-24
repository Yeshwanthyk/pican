import "@testing-library/jest-dom/vitest";
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

  it("renders a server label for an open runtime ID", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "custom-runtime",
          runtimes: [
            { id: "pi", label: "Backend Pi", available: true },
            {
              id: "custom-runtime",
              label: "Custom Runtime",
              available: true,
              capabilities: { create: true },
            },
          ],
        }),
      },
    });

    expect(await screen.findByRole("radio", { name: "Pi" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "Custom Runtime" })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.queryByText("runtime.custom-runtime")).not.toBeInTheDocument();
  });

  it("renders OpenCode as a selectable capability-driven runtime", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "opencode",
          runtimes: [
            { id: "pi", available: true },
            {
              id: "opencode",
              available: true,
              capabilities: { create: true, chat: true, modelListing: true },
            },
          ],
        }),
      },
    });

    const opencode = await screen.findByRole("radio", { name: "OpenCode" });
    expect(opencode).toHaveAttribute("aria-checked", "true");
    expect(opencode.querySelector(".runtime-segment-mark")).toHaveTextContent("O");
    expect(screen.getByRole("button", { name: "Create" })).toBeEnabled();
  });

  it("shows but disables a runtime without create capability", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "future",
          runtimes: [
            { id: "future", label: "Future", available: true, capabilities: { create: false } },
          ],
        }),
      },
    });

    const future = await screen.findByRole("radio", { name: /Future/ });
    expect(future).toBeDisabled();
    expect(future).toHaveTextContent("Doesn't support creating sessions");
    expect(screen.getByRole("button", { name: "Create" })).toBeDisabled();
  });

  it("shows the no-permission-prompt warning for Claude creation", async () => {
    render(NewSessionModal, {
      props: {
        open: true,
        fetchRuntimes: async () => ({
          defaultRuntime: "claude",
          runtimes: [
            { id: "pi", label: "Pi", available: true, capabilities: { create: true } },
            {
              id: "claude",
              label: "Claude",
              available: true,
              capabilities: { create: true },
            },
          ],
        }),
      },
    });

    expect(
      await screen.findByText("Claude runs without permission prompts and can access your system."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("radio", { name: "Claude" }).querySelector(".runtime-segment-mark"),
    ).toHaveAttribute("src", "/claude-icon.svg");
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
