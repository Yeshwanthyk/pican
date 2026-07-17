export function setupComposerHeightVar({
  documentImpl = document,
  windowImpl = window,
  form,
  ResizeObserverImpl = windowImpl.ResizeObserver,
} = {}) {
  if (!form) return { update: () => {} };

  function update() {
    const height = Math.ceil(form.getBoundingClientRect().height || 0);
    documentImpl.documentElement.style.setProperty('--pi-chat-composer-height', `${height}px`);
  }

  update();
  windowImpl.addEventListener('resize', update, { passive: true });
  if (ResizeObserverImpl) {
    new ResizeObserverImpl(update).observe(form);
  }

  return { update };
}
