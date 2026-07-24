export function createComposerSendState({
  textarea = null,
  sendButton = null,
  getAttachments = () => ({ hasAttachments: () => false }),
  canSend = () => true,
}: {
  readonly textarea?: HTMLTextAreaElement | null;
  readonly sendButton?: HTMLButtonElement | null;
  readonly getAttachments?: () => { readonly hasAttachments?: () => boolean } | null;
  readonly canSend?: () => boolean;
} = {}) {
  function hasComposerContent() {
    const value = textarea ? textarea.value : "";
    return value.trim().length > 0 || !!getAttachments()?.hasAttachments?.();
  }

  function updateSendEnabled() {
    if (!sendButton) return;
    // Don't fight transient sending/disabled state set by sendChatMessage.
    if (sendButton.dataset.sending === "1") return;
    sendButton.disabled = !canSend() || !hasComposerContent();
  }

  return {
    hasComposerContent,
    updateSendEnabled,
  };
}
