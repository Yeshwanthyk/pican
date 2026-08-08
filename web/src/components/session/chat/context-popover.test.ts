import { afterEach, describe, expect, it, vi } from "vitest";
import { setupContextPopover } from "./context-popover.js";

afterEach(() => {
  document.body.innerHTML = "";
});

function renderDom() {
  document.body.innerHTML = `
    <div class="pi-chat-shell">
      <button id="pi-chat-context-usage">usage</button>
      <div id="pi-chat-context-popover" style="display:none">
        <button class="pi-popover-close"></button>
        <div class="pi-popover-arrow"></div>
      </div>
    </div>
  `;
  const shell = document.querySelector<HTMLElement>(".pi-chat-shell");
  const usage = document.querySelector<HTMLElement>("#pi-chat-context-usage");
  if (shell) shell.getBoundingClientRect = () => new DOMRect(10, 0, 300, 400);
  if (usage) usage.getBoundingClientRect = () => new DOMRect(150, 300, 20, 20);
}

describe("setupContextPopover", () => {
  it("toggles the popover and refreshes context usage before positioning", () => {
    renderDom();
    const updateContextUsage = vi.fn();
    setupContextPopover({ documentImpl: document, windowImpl: window, updateContextUsage });

    document.getElementById("pi-chat-context-usage")?.click();

    const popover = document.querySelector<HTMLElement>("#pi-chat-context-popover");
    expect(popover?.style.display).toBe("block");
    expect(updateContextUsage).toHaveBeenCalledTimes(1);
    expect(popover?.style.left).toBe("50px");
    expect(popover?.style.bottom).toBe("108px");
    expect(popover?.querySelector<HTMLElement>(".pi-popover-arrow")?.style.left).toBe("100px");

    document.getElementById("pi-chat-context-usage")?.click();
    expect(popover?.style.display).toBe("none");
  });

  it("keeps composer focus while opening on compact layouts", () => {
    renderDom();
    setupContextPopover({ documentImpl: document, windowImpl: window });
    const pointerDown = new MouseEvent("pointerdown", { bubbles: true, cancelable: true });

    document.getElementById("pi-chat-context-usage")?.dispatchEvent(pointerDown);

    expect(pointerDown.defaultPrevented).toBe(true);
  });

  it("closes from the close button and outside clicks", () => {
    renderDom();
    setupContextPopover({ documentImpl: document, windowImpl: window });
    const popover = document.querySelector<HTMLElement>("#pi-chat-context-popover");
    document.getElementById("pi-chat-context-usage")?.click();

    popover?.querySelector<HTMLButtonElement>(".pi-popover-close")?.click();
    expect(popover?.style.display).toBe("none");

    document.getElementById("pi-chat-context-usage")?.click();
    document.body.click();
    expect(popover?.style.display).toBe("none");
  });

  it("repositions while visible on resize", () => {
    renderDom();
    setupContextPopover({ documentImpl: document, windowImpl: window });
    const popover = document.querySelector<HTMLElement>("#pi-chat-context-popover");
    document.getElementById("pi-chat-context-usage")?.click();
    if (popover) popover.style.left = "0px";

    window.dispatchEvent(new Event("resize"));

    expect(popover?.style.left).toBe("50px");
  });

  it("disposes all listeners idempotently", () => {
    renderDom();
    const controller = setupContextPopover({ documentImpl: document, windowImpl: window });
    const popover = document.querySelector<HTMLElement>("#pi-chat-context-popover");

    controller.dispose?.();
    controller.dispose?.();
    document.getElementById("pi-chat-context-usage")?.click();
    window.dispatchEvent(new Event("resize"));

    expect(popover?.style.display).toBe("none");
  });
});
