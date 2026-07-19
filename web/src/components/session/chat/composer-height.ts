export function setupComposerHeightVar({
  documentImpl = document,
  windowImpl = window,
  form,
  ResizeObserverImpl = globalThis.ResizeObserver,
}: {
  readonly documentImpl?: Document;
  readonly windowImpl?: Window;
  readonly form?: HTMLFormElement | null;
  readonly ResizeObserverImpl?: typeof ResizeObserver;
} = {}) {
  if (!form) return { update: () => undefined };
  const composerForm = form;

  function update(): void {
    const height = Math.ceil(composerForm.getBoundingClientRect().height || 0);
    documentImpl.documentElement.style.setProperty("--pi-chat-composer-height", `${height}px`);
  }

  update();
  windowImpl.addEventListener("resize", update, { passive: true });
  if (ResizeObserverImpl) {
    new ResizeObserverImpl(update).observe(composerForm);
  }

  return { update };
}
