import { describe, expect, it } from "vitest";
import { runtimeDisplay } from "./runtime-display";

describe("runtimeDisplay", () => {
  it("uses translated runtime labels and known icons", () => {
    expect(runtimeDisplay("CODEX", "ignored")).toEqual({
      id: "codex",
      label: "Codex",
      icon: "/codex-icon.svg",
      initial: "C",
    });
  });

  it("renders OpenCode and unknown runtimes without pretending they are Pi", () => {
    expect(runtimeDisplay("opencode")).toEqual({
      id: "opencode",
      label: "OpenCode",
      icon: "",
      initial: "O",
    });
    expect(runtimeDisplay("future", "Future Runtime")).toEqual({
      id: "future",
      label: "Future Runtime",
      icon: "",
      initial: "F",
    });
  });
});
