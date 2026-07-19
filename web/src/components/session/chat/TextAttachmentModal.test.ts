import { afterEach, assert, describe, expect, it } from "vitest";
import { cleanup, render } from "@testing-library/svelte";
import TextAttachmentModal from "./TextAttachmentModal.svelte";

afterEach(cleanup);

describe("TextAttachmentModal", () => {
  it("renders the IDs and hooks used by the chat composer runtime", () => {
    render(TextAttachmentModal);

    const modal = document.getElementById("pi-chat-attachment-modal");
    assert(modal);
    expect(modal.hidden).toBe(true);
    expect(modal.querySelector('[data-action="close-attachment"]')).toBeTruthy();
    expect(modal.querySelector(".pi-chat-attachment-card-quote")).toBeTruthy();
    const note = modal.querySelector<HTMLElement>(".pi-chat-attachment-card-note");
    assert(note);
    expect(note.hidden).toBe(true);
  });
});
