export function getComposerElements({
  documentImpl = document,
  form = null,
}: { readonly documentImpl?: Document; readonly form?: HTMLFormElement | null } = {}) {
  return {
    form,
    textarea: documentImpl.querySelector<HTMLTextAreaElement>("#pi-chat-message"),
    fileInput: documentImpl.querySelector<HTMLInputElement>("#pi-chat-images"),
    attachButton: documentImpl.querySelector<HTMLButtonElement>("#pi-chat-attach"),
    attachmentList: documentImpl.querySelector<HTMLElement>("#pi-chat-attachments"),
    sendButton: documentImpl.querySelector<HTMLButtonElement>("#pi-chat-send"),
    cancelButton: documentImpl.querySelector<HTMLButtonElement>("#pi-chat-cancel"),
    queueButton: documentImpl.querySelector<HTMLButtonElement>("#pi-chat-queue"),
    shell: form?.querySelector<HTMLElement>(".pi-chat-shell") || null,
    expandButton: documentImpl.querySelector<HTMLButtonElement>("#pi-chat-expand"),
  };
}
