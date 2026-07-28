interface ExportClipboardOptions {
  readonly documentImpl?: Document;
  readonly navigatorImpl?: Navigator;
}

function fallbackCopy(text: string, documentImpl: Document): boolean {
  const textarea = documentImpl.createElement("textarea");
  textarea.value = text;
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  documentImpl.body.appendChild(textarea);
  textarea.select();
  const copied = documentImpl.execCommand("copy");
  documentImpl.body.removeChild(textarea);
  return copied;
}

// Static exports cannot import the live Effect runtime bridge. Keep their
// clipboard adapter browser-local and inject it into the shared transcript.
export async function copyExportText(
  text: string,
  { documentImpl = document, navigatorImpl = navigator }: ExportClipboardOptions = {},
): Promise<boolean> {
  const fallback = (): Promise<boolean> =>
    Promise.resolve()
      .then(() => fallbackCopy(text, documentImpl))
      .then(
        (copied) => copied,
        () => false,
      );
  const writeText = navigatorImpl.clipboard?.writeText;
  if (!writeText) return fallback();

  return Promise.resolve()
    .then(() => writeText.call(navigatorImpl.clipboard, text))
    .then(
      () => true,
      () => fallback(),
    );
}
