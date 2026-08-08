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
  if (!form) return { update: () => undefined, dispose: () => undefined };
  const composerForm = form;
  let observer: ResizeObserver | null = null;
  let disposed = false;

  function update(): void {
    if (disposed) return;
    const height = Math.ceil(composerForm.getBoundingClientRect().height || 0);
    documentImpl.documentElement.style.setProperty("--pi-chat-composer-height", `${height}px`);
  }

  update();
  windowImpl.addEventListener("resize", update, { passive: true });
  if (ResizeObserverImpl) {
    observer = new ResizeObserverImpl(update);
    observer.observe(composerForm);
  }

  return {
    update,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      windowImpl.removeEventListener("resize", update);
      observer?.disconnect();
      observer = null;
    },
  };
}
