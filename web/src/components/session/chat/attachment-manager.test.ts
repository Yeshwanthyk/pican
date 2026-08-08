import { describe, expect, it, vi } from "vitest";
import { setupAttachmentManager } from "./attachment-manager.js";

function setupDom() {
  document.body.innerHTML =
    '<textarea id="message"></textarea><input id="files"><button id="attach"></button><div id="attachments"></div><div id="pi-chat-attachment-modal" hidden><pre class="pi-chat-attachment-card-quote"></pre><div class="pi-chat-attachment-card-note" hidden></div><button type="button" data-action="close-attachment"></button></div>';
  return {
    textarea:
      document.querySelector<HTMLTextAreaElement>("#message") ?? document.createElement("textarea"),
    fileInput:
      document.querySelector<HTMLInputElement>("#files") ?? document.createElement("input"),
    attachButton:
      document.querySelector<HTMLButtonElement>("#attach") ?? document.createElement("button"),
    attachmentList:
      document.querySelector<HTMLElement>("#attachments") ?? document.createElement("div"),
  };
}

describe("attachment manager", () => {
  it("renders image previews from pasted files and deduplicates them", () => {
    const { textarea, fileInput, attachButton, attachmentList } = setupDom();
    const updateSendEnabled = vi.fn();
    window.URL.createObjectURL = vi.fn(() => "blob:preview");
    setupAttachmentManager({
      documentImpl: document,
      windowImpl: window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
      updateSendEnabled,
    });

    const file = new File(["blob"], "screenshot.png", { type: "image/png" });
    const pasteEvent = new Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(pasteEvent, "clipboardData", {
      value: { files: [file, file], items: [], getData: () => "" },
    });
    textarea.dispatchEvent(pasteEvent);

    expect(attachmentList.children.length).toBe(1);
    expect(attachmentList.firstElementChild?.classList.contains("image-only")).toBe(true);
    expect(attachmentList.querySelector(".pi-chat-attachment-preview")?.getAttribute("src")).toBe(
      "blob:preview",
    );
    expect(pasteEvent.defaultPrevented).toBe(true);
    expect(updateSendEnabled).toHaveBeenCalled();
  });

  it("folds text attachments into composed messages", () => {
    const { textarea, fileInput, attachButton, attachmentList } = setupDom();
    const manager = setupAttachmentManager({
      documentImpl: document,
      windowImpl: window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
    });

    window.dispatchEvent(
      new CustomEvent("pi-chat-attach-text", {
        detail: { original: "selected text", note: "adjust wording" },
      }),
    );

    const chip = attachmentList.querySelector(".pi-chat-attachment-text");
    expect(chip).toBeTruthy();
    expect(manager.hasAttachments()).toBe(true);
    expect(manager.composeMessage("please update")).toBe(
      "> selected text\n\nadjust wording\n\nplease update",
    );

    if (chip instanceof HTMLElement) chip.click();
    expect(document.querySelector<HTMLElement>("#pi-chat-attachment-modal")?.hidden).toBe(false);
    expect(document.querySelector(".pi-chat-attachment-card-quote")?.textContent).toBe(
      "selected text",
    );
  });

  it("restores cleared attachment state", () => {
    const { textarea, fileInput, attachButton, attachmentList } = setupDom();
    window.URL.createObjectURL = vi.fn(() => "blob:preview");
    window.URL.revokeObjectURL = vi.fn();
    const manager = setupAttachmentManager({
      documentImpl: document,
      windowImpl: window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
    });

    const file = new File(["blob"], "retry.png", { type: "image/png" });
    manager.restore({
      files: [file],
      textAttachments: [{ original: "quoted", note: "" }],
    });
    expect(attachmentList.children.length).toBe(2);

    const files = manager.files().slice();
    const textAttachments = manager.textAttachments().slice();
    manager.clear();
    expect(attachmentList.children.length).toBe(0);
    expect(window.URL.revokeObjectURL).toHaveBeenCalledWith("blob:preview");

    manager.restore({ files, textAttachments });
    expect(attachmentList.children.length).toBe(2);
  });

  it("disposes global, input, paste, and viewer listeners idempotently", () => {
    const { textarea, fileInput, attachButton, attachmentList } = setupDom();
    const manager = setupAttachmentManager({
      documentImpl: document,
      windowImpl: window,
      textarea,
      fileInput,
      attachButton,
      attachmentList,
    });
    window.dispatchEvent(
      new CustomEvent("pi-chat-attach-text", { detail: { original: "selected text" } }),
    );
    attachmentList.querySelector<HTMLElement>(".pi-chat-attachment-text")?.click();
    const modal = document.querySelector<HTMLElement>("#pi-chat-attachment-modal");
    expect(modal?.hidden).toBe(false);

    manager.dispose();
    manager.dispose();
    window.dispatchEvent(
      new CustomEvent("pi-chat-attach-text", { detail: { original: "stale text" } }),
    );
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));

    expect(manager.hasAttachments()).toBe(false);
    expect(attachmentList.children.length).toBe(0);
    expect(modal?.hidden).toBe(false);
  });
});
