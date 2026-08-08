import { beforeEach, describe, expect, it, vi } from "vitest";
import { highlightPendingCode } from "./lazy-highlight.js";

describe("highlightPendingCode", () => {
  beforeEach(() => {
    document.body.innerHTML = "";
  });

  it("highlights only pending code inside the supplied subtree", () => {
    document.body.innerHTML = `
      <section id="new">
        <code id="language" data-highlight-pending data-lang="ts">const value = 1</code>
        <code id="auto" data-highlight-pending>plain value</code>
        <code id="done" class="hljs">already highlighted</code>
      </section>
      <code id="outside" data-highlight-pending>outside</code>
    `;
    const highlighter = {
      getLanguage: vi.fn((language: string) => language === "ts"),
      highlight: vi.fn(() => ({ value: '<span class="keyword">const</span> value = 1' })),
      highlightAuto: vi.fn(() => ({ value: '<span class="text">plain value</span>' })),
    };

    highlightPendingCode(document.getElementById("new")!, highlighter);

    expect(highlighter.highlight).toHaveBeenCalledOnce();
    expect(highlighter.highlightAuto).toHaveBeenCalledOnce();
    expect(document.getElementById("language")).not.toHaveAttribute("data-highlight-pending");
    expect(document.getElementById("language")).not.toHaveAttribute("data-lang");
    expect(document.getElementById("auto")).not.toHaveAttribute("data-highlight-pending");
    expect(document.getElementById("done")).toHaveTextContent("already highlighted");
    expect(document.getElementById("outside")).toHaveAttribute("data-highlight-pending");
  });

  it("keeps a failed node pending and continues with later nodes", () => {
    document.body.innerHTML = `
      <section id="scope">
        <code id="bad" data-highlight-pending>bad</code>
        <code id="good" data-highlight-pending>good</code>
      </section>
    `;
    const highlightAuto = vi
      .fn()
      .mockReturnValueOnce(null as never)
      .mockReturnValueOnce({ value: "<span>good</span>" });

    highlightPendingCode(document.getElementById("scope")!, {
      getLanguage: () => false,
      highlight: () => ({ value: "" }),
      highlightAuto,
    });

    expect(document.getElementById("bad")).toHaveAttribute("data-highlight-pending");
    expect(document.getElementById("good")).not.toHaveAttribute("data-highlight-pending");
    expect(document.getElementById("good")?.innerHTML).toBe("<span>good</span>");
  });
});
