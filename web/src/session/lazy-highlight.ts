// Lazily highlight code blocks that the entry renderer emitted as plain text
// with `data-highlight-pending` (so the initial paint isn't blocked on
// highlight.js). Called after the message pane renders + re-renders. Live-only.

import { Effect } from "effect";
import { DecodeError, NetworkError } from "../lib/errors";
import { runFork } from "../lib/runtime";

export function applyLazyHighlighting(documentImpl: Document): void {
  const operation = Effect.tryPromise({
    try: () => import("highlight.js"),
    catch: (cause) => new NetworkError({ cause }),
  }).pipe(
    Effect.flatMap(({ default: hljs }) =>
      Effect.forEach(
        documentImpl.querySelectorAll<HTMLElement>("code[data-highlight-pending]"),
        (el) =>
          Effect.try({
            try: () => {
              const lang = el.dataset.lang;
              const text = el.textContent ?? "";
              el.innerHTML =
                lang && hljs.getLanguage(lang)
                  ? hljs.highlight(text, { language: lang }).value
                  : hljs.highlightAuto(text).value;
              el.removeAttribute("data-highlight-pending");
              el.removeAttribute("data-lang");
            },
            catch: () => new DecodeError({ url: "highlight.js", issue: "highlight failed" }),
          }).pipe(Effect.catch(() => Effect.void)),
        { discard: true },
      ),
    ),
    Effect.catch(() => Effect.void),
  );
  runFork(operation);
}
