import { Effect } from "effect";
import { StorageError } from "../lib/errors";
import { runPromise } from "../lib/runtime";

interface ClipboardOptions {
  readonly documentImpl?: Document;
  readonly navigatorImpl?: Navigator;
}

const clipboardFailure = (cause: unknown) =>
  new StorageError({ key: "clipboard", op: "write", cause });

const fallbackCopy = (text: string, documentImpl: Document): Effect.Effect<boolean, StorageError> =>
  Effect.try({
    try: () => {
      const textarea = documentImpl.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      documentImpl.body.appendChild(textarea);
      textarea.select();
      const copied = documentImpl.execCommand("copy");
      documentImpl.body.removeChild(textarea);
      return copied;
    },
    catch: clipboardFailure,
  });

// Write text to the clipboard, falling back to a hidden textarea + execCommand
// for insecure (HTTP) contexts where navigator.clipboard is unavailable.
// Returns true when the copy succeeded. DOM seams are injectable for tests.
export function copyToClipboard(
  text: string,
  { documentImpl = document, navigatorImpl = navigator }: ClipboardOptions = {},
): Promise<boolean> {
  const writeText = navigatorImpl.clipboard?.writeText;
  const primary = writeText
    ? Effect.tryPromise({
        try: () => writeText.call(navigatorImpl.clipboard, text),
        catch: clipboardFailure,
      })
    : Effect.fail(clipboardFailure("Clipboard API unavailable"));
  return runPromise(
    primary.pipe(
      Effect.as(true),
      Effect.catch(() => fallbackCopy(text, documentImpl)),
      Effect.catch(() => Effect.succeed(false)),
    ),
  );
}
