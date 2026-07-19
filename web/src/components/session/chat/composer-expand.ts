import { Effect } from "effect";
import { runSync } from "../../../lib/runtime";
import type { StorageLike } from "../../../lib/storage";

export function setupComposerExpansion({
  sessionId = "",
  shell,
  expandButton,
  textarea,
  storage,
  onHeightChange = () => {},
}: {
  readonly sessionId?: string;
  readonly shell?: HTMLElement | null;
  readonly expandButton?: HTMLButtonElement | null;
  readonly textarea?: HTMLTextAreaElement | null;
  readonly storage?: StorageLike | null;
  readonly onHeightChange?: () => void;
} = {}) {
  const storageKey = "pican:chat:composer-expanded:" + (sessionId || "default");

  function apply(expanded: boolean): void {
    if (!shell) return;
    shell.classList.toggle("expanded", !!expanded);
    if (expandButton) {
      const label = expanded ? "Collapse composer" : "Expand composer";
      expandButton.setAttribute("aria-pressed", expanded ? "true" : "false");
      expandButton.setAttribute("aria-label", label);
      expandButton.title = label;
    }
    onHeightChange();
  }

  let initialExpanded = false;
  initialExpanded = runSync(
    Effect.try({
      try: () => storage?.getItem(storageKey) === "1",
      catch: () => false,
    }),
  );
  apply(initialExpanded);

  expandButton?.addEventListener("click", () => {
    const willExpand = !shell?.classList.contains("expanded");
    apply(willExpand);
    runSync(
      Effect.try({
        try: () => storage?.setItem(storageKey, willExpand ? "1" : "0"),
        catch: () => undefined,
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
    if (willExpand && textarea && typeof textarea.focus === "function") textarea.focus();
  });

  return { apply, storageKey };
}
