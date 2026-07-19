import type { SessionEntry, UnknownRecord } from "../session/data/session-types.js";

export function downloadExportSessionJson({
  entries,
  header,
  documentImpl,
  URLImpl,
  BlobImpl,
}: {
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly header: UnknownRecord;
  readonly documentImpl: Document;
  readonly URLImpl: typeof URL;
  readonly BlobImpl: typeof Blob;
}): void {
  const lines = [JSON.stringify({ type: "header", ...header })];
  for (const entry of entries) lines.push(JSON.stringify(entry));
  const blob = new BlobImpl([lines.join("\n")], { type: "application/x-ndjson" });
  const url = URLImpl.createObjectURL(blob);
  const anchor = documentImpl.createElement("a");
  anchor.href = url;
  anchor.download = `${typeof header.id === "string" ? header.id : "session"}.jsonl`;
  documentImpl.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URLImpl.revokeObjectURL(url);
}
