export function readComposerConfig({ form = null, setChatStatus = () => {} } = {}) {
  if (!form) return { ready: false, sessionId: '', chatAvailable: false };

  const sessionId = form.dataset.sessionId;
  const chatAvailable = form.dataset.chatAvailable !== 'false';
  if (!chatAvailable) {
    const reason = form.dataset.chatDisabledReason || 'chat unavailable';
    setChatStatus('unavailable', 'error');
    form.title = reason;
    return { ready: false, sessionId, chatAvailable };
  }

  return { ready: true, sessionId, chatAvailable };
}
