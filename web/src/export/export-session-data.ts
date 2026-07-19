import {
  contentBlockFromUnknown,
  isUnknownRecord,
  sessionEntryFromUnknown,
  type SessionDataShape,
  type SessionEntry,
  type ToolCallInfo,
  type UnknownRecord,
} from "../session/data/session-types.js";

interface ExportSessionDocument {
  getElementById(id: string): { readonly textContent: string | null } | null;
  querySelector(selector: string): { readonly content?: string } | null;
}

interface ExportSessionWindow {
  readonly location?: { readonly search?: string };
}

interface LoadExportSessionDataOptions {
  readonly documentImpl: ExportSessionDocument;
  readonly windowImpl: ExportSessionWindow;
  readonly atobImpl?: (value: string) => string;
}

export interface ExportSessionData extends SessionDataShape {
  readonly header: UnknownRecord;
  readonly entries: SessionEntry[];
  readonly leafId: string;
  readonly urlLeafId: string | null;
  readonly urlTargetId: string | null;
  readonly total: number;
  readonly from: number;
  readonly truncated: boolean;
  readonly byId: Map<string, SessionEntry>;
  readonly toolCallMap: Map<string, ToolCallInfo>;
  readonly labelMap: Map<string, string>;
}

export function buildSessionLookups(entries: ReadonlyArray<SessionEntry> = []): {
  readonly byId: Map<string, SessionEntry>;
  readonly toolCallMap: Map<string, ToolCallInfo>;
  readonly labelMap: Map<string, string>;
} {
  const byId = new Map<string, SessionEntry>();
  const toolCallMap = new Map<string, ToolCallInfo>();
  const labelMap = new Map<string, string>();
  for (const entry of entries) {
    byId.set(entry.id, entry);
    if (entry.type === "message" && entry.message?.role === "assistant") {
      const content = entry.message.content;
      if (Array.isArray(content)) {
        for (const candidate of content) {
          const block = contentBlockFromUnknown(candidate);
          if (block?.type === "toolCall" && block.id) {
            toolCallMap.set(block.id, { name: block.name, arguments: block.arguments });
          }
        }
      }
    }
    if (entry.type === "label" && entry.targetId) {
      if (entry.label) labelMap.set(entry.targetId, entry.label);
      else labelMap.delete(entry.targetId);
    }
  }
  return { byId, toolCallMap, labelMap };
}

function decodeEmbeddedPayload(
  encoded: string,
  atobImpl: (value: string) => string,
): UnknownRecord {
  const binary = atobImpl(encoded);
  const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
  const json = new TextDecoder("utf-8").decode(bytes);
  // The export deliberately has no Effect runtime bridge. This is trusted,
  // server-generated session JSON embedded in a non-executable script node.
  // oxlint-disable-next-line pican/no-json-parse
  const decoded: unknown = JSON.parse(json);
  return isUnknownRecord(decoded) ? decoded : {};
}

export function loadExportSessionData({
  documentImpl,
  windowImpl,
  atobImpl = globalThis.atob,
}: LoadExportSessionDataOptions): ExportSessionData {
  const encoded = documentImpl.getElementById("session-data")?.textContent ?? "";
  const payload = decodeEmbeddedPayload(encoded, atobImpl);
  const entries = Array.isArray(payload.entries)
    ? payload.entries.flatMap((candidate) => {
        const entry = sessionEntryFromUnknown(candidate);
        return entry ? [entry] : [];
      })
    : [];
  const injectedParams = documentImpl.querySelector('meta[name="pican-url-params"]');
  const search = injectedParams?.content ?? windowImpl.location?.search ?? "";
  const params = new URLSearchParams(search.replace(/^\?/, ""));
  const defaultLeafId = typeof payload.leafId === "string" ? payload.leafId : "";
  const total = typeof payload.total === "number" ? payload.total : entries.length;
  const from = typeof payload.from === "number" ? payload.from : 0;
  return {
    ...payload,
    header: isUnknownRecord(payload.header) ? payload.header : {},
    entries,
    defaultLeafId,
    leafId: params.get("leafId") || defaultLeafId,
    urlLeafId: params.get("leafId"),
    urlTargetId: params.get("targetId"),
    total,
    from,
    truncated: payload.truncated === true || from > 0 || entries.length < total,
    ...buildSessionLookups(entries),
  };
}
