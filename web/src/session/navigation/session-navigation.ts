// Navigation + scroll only. The message pane (#messages) is rendered reactively
// by the Svelte <SessionContent> component from the shared SessionDataModel, so
// the navigator no longer builds DOM, caches nodes, or wires per-entry buttons.
// It just moves the active leaf/target (which the reactive model reads to
// recompute the path) and scrolls to the requested entry once Svelte has
// flushed. Copy-link/fork buttons are handled by a delegated click listener in
// session-content-runtime.js; message-content copy stays local to SessionEntry.
export function openAncestorDetails(element: HTMLElement | null | undefined): void {
  let current = element?.parentElement;
  while (current) {
    if (current.tagName === "DETAILS") (current as HTMLDetailsElement).open = true;
    current = current.parentElement;
  }
}

function activityFoldForTarget(
  documentImpl: Document,
  targetId: string,
  targetElement: HTMLElement | null,
): HTMLDetailsElement | null {
  const closestFold = targetElement?.closest("details.activity-fold");
  if (closestFold) return closestFold as HTMLDetailsElement;

  for (const fold of documentImpl.querySelectorAll<HTMLDetailsElement>(
    "details.activity-fold[data-activity-target-ids]",
  )) {
    const ids = new URLSearchParams(fold.dataset.activityTargetIds ?? "").getAll("id");
    if (ids.includes(targetId)) return fold;
  }
  return null;
}

function openActivityFold(fold: HTMLDetailsElement): boolean {
  const needsMount = fold.dataset.activityBodyMounted !== "true";
  fold.open = true;
  // Programmatic `open` changes queue a native toggle event inconsistently
  // across engines. Dispatch one now so ActivityFold latches both its body and
  // open state before a later Svelte update can overwrite the DOM property.
  const EventImpl = fold.ownerDocument.defaultView?.Event ?? Event;
  fold.dispatchEvent(new EventImpl("toggle"));
  return needsMount;
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

        const scrollToTarget = (allowMountRetry: boolean): void => {
          const targetEl = documentImpl.getElementById(`entry-${scrollTargetId}`);
          const activityFold = activityFoldForTarget(documentImpl, scrollTargetId, targetEl);
          if (activityFold && openActivityFold(activityFold) && allowMountRetry) {
            // ActivityFold mounts after Svelte's microtask flush. Retry in a
            // macrotask so nested tool-result anchors exist before scrolling.
            setTimeoutImpl(() => scrollToTarget(false));
            return;
          }
          if (!targetEl) return;

          openAncestorDetails(targetEl);
          targetEl.scrollIntoView?.({ block: "center" });
          if (scrollToEntryId) {
            targetEl.classList.add("highlight");
            setTimeoutImpl(() => targetEl.classList.remove("highlight"), 2000);
          }
        };

        scrollToTarget(true);
      }
      // scrollMode === 'none' → leave the scroll position untouched.
    });
  }

  return { navigateTo };
}
