import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/svelte";
import VersionController from "./VersionController.svelte";
import { openVersionModal } from "../../shared/version";

function jsonResponse(body: unknown, ok = true, status = 200): Promise<Response> {
  return Promise.resolve(
    new Response(JSON.stringify(body), { status: ok ? status : status || 500 }),
  );
}

function versionStatus(): HTMLElement {
  const element = document.querySelector<HTMLElement>("[data-version-status]");
  expect(element).not.toBeNull();
  return element ?? document.body;
}

beforeEach(() => {
  document.body.innerHTML =
    '<button data-version-row data-action="version"><span>pican</span><span class="version-status" data-version-status>…</span></button>';
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.restoreAllMocks();
});

describe("VersionController", () => {
  it("populates the status label from /api/version", async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse({ current: "1.0.0", latest: "1.1.0", hasUpdate: true }),
    );
    render(VersionController, { props: { fetchImpl } });
    await waitFor(() => expect(versionStatus().textContent).toBe("v1.0.0 → v1.1.0"));
    expect(versionStatus().classList.contains("has-update")).toBe(true);
  });

  it("opens a dev-build modal through the shared bridge", async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse({
        current: "v0.0.1-beta.24-3-gd7e8bf2-dirty",
        isDev: true,
        hasUpdate: false,
        latest: "0.0.1-beta.24",
      }),
    );
    render(VersionController, { props: { fetchImpl } });
    await waitFor(() => expect(versionStatus().textContent).toBe("v0.0.1-beta.24"));
    openVersionModal();
    expect(await screen.findByText(/local development build/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Check for updates" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Update & Restart" })).not.toBeInTheDocument();
  });

  it("shows an inline loading state while a manual check is in flight", async () => {
    let resolveCheck: ((value: Response) => void) | undefined;
    const fetchImpl = vi.fn((url: RequestInfo | URL): Promise<Response> => {
      if (String(url).includes("check-update"))
        return new Promise((resolve) => {
          resolveCheck = resolve;
        });
      return jsonResponse({ current: "1.0.0", latest: "1.0.0", hasUpdate: false });
    });
    render(VersionController, { props: { fetchImpl, minCheckMs: 0 } });
    await waitFor(() => expect(versionStatus().textContent).toBe("v1.0.0"));
    openVersionModal();
    const checkBtn = await screen.findByRole("button", { name: "Check for updates" });
    await fireEvent.click(checkBtn);
    expect(checkBtn).toHaveClass("is-loading");
    expect(checkBtn).toHaveTextContent("Checking…");
    expect(checkBtn).toBeDisabled();
    expect(document.querySelector<HTMLElement>(".version-modal-status")?.hidden).toBe(true);
    resolveCheck?.(
      new Response(JSON.stringify({ current: "1.0.0", latest: "1.0.0", hasUpdate: false })),
    );
  });

  it("renders an update modal with an Update button", async () => {
    const fetchImpl = vi.fn(() =>
      jsonResponse({ current: "1.0.0", latest: "1.1.0", hasUpdate: true, changelog: "- new" }),
    );
    render(VersionController, { props: { fetchImpl } });
    await waitFor(() => expect(versionStatus().textContent).toContain("v1.1.0"));
    openVersionModal();
    expect(await screen.findByRole("button", { name: "Update & Restart" })).toBeInTheDocument();
  });
});
