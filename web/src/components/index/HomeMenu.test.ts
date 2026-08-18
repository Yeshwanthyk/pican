import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/svelte";
import { describe, expect, it } from "vitest";
import { normalizePeerHost } from "../../index/peers.js";
import HomeMenu from "./HomeMenu.svelte";

const peerHost = (name: string, online: boolean) =>
  normalizePeerHost({
    name,
    baseUrl: "",
    online,
    sessions: [],
    error: "",
  });

describe("HomeMenu", () => {
  it("shows a Machines entry with an online count that links to settings", () => {
    render(HomeMenu, {
      props: {
        open: true,
        peerHosts: [peerHost("alpha", true), peerHost("beta", false)],
      },
    });

    const link = screen.getByRole("menuitem", { name: /Machines/ });
    expect(link).toHaveAttribute("href", "/settings");
    expect(link).toHaveTextContent("1/2 online");
  });

  it("omits the Machines entry when no peer hosts are registered", () => {
    render(HomeMenu, { props: { open: true, peerHosts: [] } });

    expect(screen.queryByRole("menuitem", { name: /Machines/ })).not.toBeInTheDocument();
  });
});
