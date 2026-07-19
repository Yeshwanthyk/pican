// Per-message DOM/clipboard actions for the message pane (download JSONL, build
// a share URL, copy to clipboard). Extracted from session-entry-renderer.js
// during its decomposition into Svelte components. These are utilities, not view
// rendering — the live content runtime + export wire them to the delegated
// copy/download controls.

import { setIconElement, Check } from "../../shared/icons.js";
import { copyToClipboard as writeClipboard } from "../../shared/clipboard.js";
import type { SessionEntry, UnknownRecord } from "../data/session-types.js";

interface DownloadDocument {
  readonly body: Pick<HTMLElement, "appendChild" | "removeChild">;
  createElement(tagName: "a"): HTMLAnchorElement;
}

interface UrlFactory {
  createObjectURL(blob: Blob): string;
  revokeObjectURL(url: string): void;
}

// Download the session as JSONL: header line + entry lines.
export function downloadSessionJson({
  entries = [],
  header = null,
  documentImpl = document,
  URLImpl = URL,
  BlobImpl = Blob,
}: {
  readonly entries?: ReadonlyArray<SessionEntry>;
  readonly header?: UnknownRecord | null;
  readonly documentImpl?: DownloadDocument;
  readonly URLImpl?: UrlFactory;
  readonly BlobImpl?: typeof Blob;
} = {}): void {
  const lines: string[] = [];
  if (header) lines.push(JSON.stringify({ type: "header", ...header }));
  for (const entry of entries) lines.push(JSON.stringify(entry));
  const blob = new BlobImpl([lines.join("\n")], { type: "application/x-ndjson" });
  const url = URLImpl.createObjectURL(blob);
  const a = documentImpl.createElement("a");
  a.href = url;
  a.download = `${header?.id || "session"}.jsonl`;
  documentImpl.body.appendChild(a);
  a.click();
  documentImpl.body.removeChild(a);
  URLImpl.revokeObjectURL(url);
}

// Build a shareable URL for a message: base?gistId&leafId=<leaf>&targetId=<entry>.
export function buildShareUrl(
  entryId: string,
  {
    documentImpl = document,
    windowImpl = window,
    getCurrentLeafId = () => "",
    URLImpl = URL,
  }: {
    readonly documentImpl?: Pick<Document, "querySelector">;
    readonly windowImpl?: Pick<Window, "location">;
    readonly getCurrentLeafId?: () => string;
    readonly URLImpl?: typeof URL;
  } = {},
): string {
  const baseUrlMeta = documentImpl.querySelector('meta[name="pican-share-base-url"]');
  const baseUrl =
    baseUrlMeta instanceof HTMLMetaElement
      ? baseUrlMeta.content
      : windowImpl.location.href.split("?")[0];

  const url = new URLImpl(windowImpl.location.href);
  // The gist id is the first query param without a value (e.g. ?abc123).
  const gistId = Array.from(url.searchParams.keys()).find((k) => !url.searchParams.get(k));

  const params = new URLSearchParams();
  const sessionId = url.searchParams.get("id");
  if (sessionId) params.set("id", sessionId);
  params.set("leafId", getCurrentLeafId());
  params.set("targetId", entryId);

  if (baseUrlMeta instanceof HTMLMetaElement) return `${baseUrl}&${params.toString()}`;
  url.search = gistId ? `?${gistId}&${params.toString()}` : `?${params.toString()}`;
  return url.toString();
}

// Copy text to the clipboard (with an execCommand fallback for HTTP) and flash
// the button with a check icon.
export async function copyToClipboard(
  text: string,
  button: HTMLElement | null,
  {
    documentImpl = document,
    navigatorImpl = navigator,
  }: { readonly documentImpl?: Document; readonly navigatorImpl?: Navigator } = {},
): Promise<void> {
  const success = await writeClipboard(text, { documentImpl, navigatorImpl });

  if (success && button) {
    const originalChildren = Array.from(button.childNodes).map((node) => node.cloneNode(true));
    setIconElement(button, Check, { size: 13, documentImpl });
    button.classList.add("copied");
    setTimeout(() => {
      button.replaceChildren(...originalChildren.map((node) => node.cloneNode(true)));
      button.classList.remove("copied");
    }, 1500);
  }
}
