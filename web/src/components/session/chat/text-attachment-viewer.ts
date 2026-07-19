import type { TextAttachment } from "./text-attachments";

export function setupTextAttachmentViewer({
  documentImpl = document,
}: { readonly documentImpl?: Document } = {}) {
  const attachmentModal = documentImpl.getElementById("pi-chat-attachment-modal");
  const attachmentQuote = attachmentModal
    ? attachmentModal.querySelector(".pi-chat-attachment-card-quote")
    : null;
  const attachmentNote = attachmentModal
    ? attachmentModal.querySelector<HTMLElement>(".pi-chat-attachment-card-note")
    : null;

  function open(att: Partial<TextAttachment> = {}): void {
    if (!attachmentModal) return;
    if (attachmentQuote) attachmentQuote.textContent = att.original || "";
    if (attachmentNote) {
      attachmentNote.textContent = att.note || "";
      attachmentNote.hidden = !att.note;
    }
    attachmentModal.hidden = false;
  }

  function close(): void {
    if (attachmentModal) attachmentModal.hidden = true;
  }

  const onClick = (event: MouseEvent): void => {
    const ElementImpl = documentImpl.defaultView?.Element ?? Element;
    if (
      event.target instanceof ElementImpl &&
      event.target.closest('[data-action="close-attachment"]')
    )
      close();
  };
  const onKeydown = (event: KeyboardEvent): void => {
    if (event.key === "Escape" && attachmentModal && !attachmentModal.hidden) close();
  };

  if (attachmentModal) {
    attachmentModal.addEventListener("click", onClick);
    documentImpl.addEventListener("keydown", onKeydown);
  }

  return {
    open,
    close,
    dispose: () => {
      attachmentModal?.removeEventListener("click", onClick);
      documentImpl.removeEventListener("keydown", onKeydown);
    },
  };
}
