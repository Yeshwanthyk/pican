// Lazily highlight code blocks that the entry renderer emitted as plain text
// with `data-highlight-pending` (so the initial paint isn't blocked on
// highlight.js). Called after the message pane renders + re-renders. Live-only.

import { Effect } from "effect";
import { DecodeError, NetworkError } from "../lib/errors";
import { runFork } from "../lib/runtime";

interface Highlighter {
  getLanguage(language: string): unknown;
  highlight(code: string, options: { readonly language: string }): { readonly value: string };
  highlightAuto(code: string): { readonly value: string };
}

/** Highlight only pending code nodes inside the newly rendered subtree. */
export function highlightPendingCode(root: ParentNode, highlighter: Highlighter): void {
  for (const element of root.querySelectorAll<HTMLElement>("code[data-highlight-pending]")) {
    try {
      const language = element.dataset.lang;
      const text = element.textContent ?? "";
      element.innerHTML =
        language && highlighter.getLanguage(language)
          ? highlighter.highlight(text, { language }).value
          : highlighter.highlightAuto(text).value;
      element.removeAttribute("data-highlight-pending");
      element.removeAttribute("data-lang");
    } catch {
      // Keep the pending marker so a later render pass can retry this node.
    }
  }
}

export function applyLazyHighlighting(root: ParentNode): void {
  const operation = Effect.tryPromise({
    try: () => import("highlight.js"),
    catch: (cause) => new NetworkError({ cause }),
  }).pipe(
    Effect.flatMap(({ default: highlighter }) =>
      Effect.try({
        try: () => highlightPendingCode(root, highlighter),
        catch: () => new DecodeError({ url: "highlight.js", issue: "highlight failed" }),
      }),
    ),
    Effect.catch(() => Effect.void),
  );
  runFork(operation);
}
