export function setupTextareaControls({
  windowImpl = window,
  textarea,
  shell,
  form,
  isMobileTextInputMode = () => false,
  getSlashSelector = () => null,
  getMentionSelector = () => null,
  getThinkingSelector = () => null,
  getModelSelector = () => null,
  updateSendEnabled = () => {},
  updateComposerHeight = () => {},
} = {}) {
  function resizeTextarea() {
    if (!textarea || shell?.classList.contains('expanded')) return;
    textarea.style.height = 'auto';
    const cs = windowImpl.getComputedStyle(textarea);
    const max = parseFloat(cs.maxHeight) || 200;
    const min = parseFloat(cs.minHeight) || 48;
    const next = Math.max(min, Math.min(textarea.scrollHeight, max));
    textarea.style.height = next + 'px';
    updateComposerHeight();
  }

  function syncCollapsedState() {
    if (!textarea || !shell) return;
    const hasComposerFocus = shell.contains(textarea.ownerDocument?.activeElement);
    shell.classList.toggle('composer-collapsed', !textarea.value && !hasComposerFocus);
  }

  function autoResize() {
    syncCollapsedState();
    resizeTextarea();
  }

  const onInput = () => {
    autoResize();
    updateSendEnabled();
  };

  const onFocusIn = () => {
    shell?.classList.remove('composer-collapsed');
    resizeTextarea();
  };

  const onFocusOut = (event) => {
    if (shell?.contains(event.relatedTarget)) return;
    shell?.classList.toggle('composer-collapsed', !textarea?.value);
    resizeTextarea();
  };

  const onKeydown = (event) => {
    if (getSlashSelector()?.handleKeydown?.(event)) return;
    if (getMentionSelector()?.handleKeydown?.(event)) return;
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      if (isMobileTextInputMode()) return;
      event.preventDefault();
      form?.requestSubmit?.();
    }
    if (event.key === 'Tab' && event.shiftKey) {
      event.preventDefault();
      getThinkingSelector()?.cycle?.();
    }
    if (event.ctrlKey && (event.key.toLowerCase() === 'i' || event.key.toLowerCase() === 'l')) {
      event.preventDefault();
      getModelSelector()?.open?.();
    }
  };

  if (textarea) {
    textarea.addEventListener('input', onInput);
    textarea.addEventListener('keydown', onKeydown);
    shell?.addEventListener('focusin', onFocusIn);
    shell?.addEventListener('focusout', onFocusOut);
    autoResize();
  }
  updateSendEnabled();

  return {
    autoResize,
    dispose: () => {
      textarea?.removeEventListener('input', onInput);
      textarea?.removeEventListener('keydown', onKeydown);
      shell?.removeEventListener('focusin', onFocusIn);
      shell?.removeEventListener('focusout', onFocusOut);
    },
  };
}
