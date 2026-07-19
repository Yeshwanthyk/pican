// Navigation + scroll only. The message pane (#messages) is rendered reactively
// by the Svelte <SessionContent> component from the shared SessionDataModel, so
// the navigator no longer builds DOM, caches nodes, or wires per-entry buttons.
// It just moves the active leaf/target (which the reactive model reads to
// recompute the path) and scrolls to the requested entry once Svelte has
// flushed. Copy/fork/label buttons are handled by a single delegated click
// listener in session-content-runtime.js.
export function openAncestorDetails(element: HTMLElement | null | undefined): void {
  let current = element?.parentElement;
  while (current) {
    if (current instanceof HTMLDetailsElement) current.open = true;
    current = current.parentElement;
  }
}

interface SessionNavigatorOptions {
  readonly documentImpl?: Document;
  readonly renderTree?: () => void;
  readonly onNavigate?: (leafId: string, targetId: string) => void;
  readonly setTimeoutImpl?: (callback: () => void, delay?: number) => unknown;
}

export function createSessionNavigator({
  documentImpl = document,
  renderTree = () => {},
  onNavigate = () => {},
  setTimeoutImpl = (fn, delay = 0) => setTimeout(fn, delay),
}: SessionNavigatorOptions = {}) {
  function navigateTo(
    targetId: string,
    scrollMode: "target" | "bottom" | "none" = "target",
    scrollToEntryId: string | null = null,
  ): void {
    // Updating the model's active leaf/target re-derives the path; <SessionContent>
    // re-renders #messages reactively. renderTree keeps the sidebar view state in
    // sync (filter/active highlight).
    onNavigate(targetId, scrollToEntryId || targetId);
    renderTree();

    // Scroll after Svelte flushes the reactive render (microtask) so the target
    // entry element exists. A macrotask (setTimeout 0) runs after that flush.
    setTimeoutImpl(() => {
      const content = documentImpl.getElementById("content");
      if (!content) return;
      if (scrollMode === "bottom") {
        content.scrollTop = content.scrollHeight;
      } else if (scrollMode === "target") {
        const scrollTargetId = scrollToEntryId || targetId;
        const targetEl = documentImpl.getElementById(`entry-${scrollTargetId}`);
        if (targetEl) {
          openAncestorDetails(targetEl);
          targetEl.scrollIntoView?.({ block: "center" });
          if (scrollToEntryId) {
            targetEl.classList.add("highlight");
            setTimeoutImpl(() => targetEl.classList.remove("highlight"), 2000);
          }
        }
      }
      // scrollMode === 'none' → leave the scroll position untouched.
    });
  }

  return { navigateTo };
}
