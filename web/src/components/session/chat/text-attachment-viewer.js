export function setupTextAttachmentViewer({ documentImpl = document } = {}) {
  const attachmentModal = documentImpl.getElementById('pi-chat-attachment-modal');
  const attachmentQuote = attachmentModal
    ? attachmentModal.querySelector('.pi-chat-attachment-card-quote')
    : null;
  const attachmentNote = attachmentModal
    ? attachmentModal.querySelector('.pi-chat-attachment-card-note')
    : null;

  function open(att = {}) {
    if (!attachmentModal) return;
    if (attachmentQuote) attachmentQuote.textContent = att.original || '';
    if (attachmentNote) {
      attachmentNote.textContent = att.note || '';
      attachmentNote.hidden = !att.note;
    }
    attachmentModal.hidden = false;
  }

  function close() {
    if (attachmentModal) attachmentModal.hidden = true;
  }

  const onClick = (event) => {
    if (event.target.closest('[data-action="close-attachment"]')) close();
  };
  const onKeydown = (event) => {
    if (event.key === 'Escape' && attachmentModal && !attachmentModal.hidden) close();
  };

  if (attachmentModal) {
    attachmentModal.addEventListener('click', onClick);
    documentImpl.addEventListener('keydown', onKeydown);
  }

  return {
    open,
    close,
    dispose: () => {
      attachmentModal?.removeEventListener('click', onClick);
      documentImpl.removeEventListener('keydown', onKeydown);
    },
  };
}
