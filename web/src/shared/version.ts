import { Effect } from "effect";
import type { ApiError } from "../lib/errors";
import { NetworkError } from "../lib/errors";
import * as Http from "../lib/http";
import type { FetchLike } from "../lib/http";
import { runPromise } from "../lib/runtime";
import { VersionInfoSchema } from "../lib/schema";
import type { VersionInfo } from "../lib/schema";
import { escapeHtml } from "./escape.js";
import { t } from "./strings.js";

interface VersionController {
  openModal?(): void;
  applyStatus?(): void;
}

let active: VersionController | null = null;

export function registerVersionController(
  controller: VersionController | null | undefined,
): () => void {
  active = controller || null;
  return () => {
    if (active === controller) active = null;
  };
}

export function openVersionModal() {
  active?.openModal?.();
}

export function applyVersionStatus() {
  active?.applyStatus?.();
}

export function renderChangelog(markdown: unknown): string {
  if (!markdown)
    return `<p class="version-changelog-empty">${escapeHtml(t("version.noReleaseNotes"))}</p>`;
  const lines = String(markdown).replace(/\r\n/g, "\n").split("\n");
  const out: string[] = [];
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const raw of lines) {
    const line = raw.trimEnd();
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (heading) {
      closeList();
      out.push(`<h4>${inline(heading[1] ?? "")}</h4>`);
    } else if (bullet) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inline(bullet[1] ?? "")}</li>`);
    } else if (line === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();
  return out.join("");
}

function inline(text: string): string {
  let s = escapeHtml(text);
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (_match, label: string, url: string) => {
    return `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  return s;
}

export function stripV(v: unknown): string {
  return String(v || "").replace(/^v/, "");
}

export function cleanVersion(v: unknown): string {
  const s = stripV(v);
  return s ? "v" + s : "";
}

export function shortVersion(v: unknown): string {
  const base = stripV(v)
    .replace(/-\d+-g[0-9a-f]{7,}.*$/, "")
    .replace(/-dirty$/, "");
  return base ? "v" + base : "";
}

export function versionLabel(
  info: Partial<Pick<VersionInfo, "current" | "latest" | "hasUpdate">> | null | undefined,
): string {
  if (!info || !info.current) return "…";
  if (info.hasUpdate && info.latest)
    return `${shortVersion(info.current)} → ${shortVersion(info.latest)}`;
  return shortVersion(info.current);
}

interface FetchVersionOptions {
  readonly fetchImpl?: VersionFetchLike;
  readonly force?: boolean;
}

interface VersionFetchResponse {
  readonly ok: boolean;
  readonly status: number;
  text?(): Promise<string>;
  json?(): Promise<unknown>;
}

type VersionFetchLike = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<VersionFetchResponse>;

const LegacyError = globalThis.Error;

const legacyFailure = <A>(effect: Effect.Effect<A, ApiError>): Effect.Effect<A, unknown> =>
  effect.pipe(
    Effect.catchTags({
      NetworkError: ({ cause }) => Effect.fail(cause),
      HttpError: ({ status }) => Effect.fail(new LegacyError(`HTTP ${status}`)),
      DecodeError: () => Effect.fail(new LegacyError("invalid json response")),
      AbortError: () => Effect.fail(new LegacyError("request cancelled")),
      TimeoutError: ({ millis }) =>
        Effect.fail(new LegacyError(`request timed out after ${millis}ms`)),
    }),
  );

const normalizeVersionResponse = (
  response: VersionFetchResponse,
): Effect.Effect<Response, NetworkError> => {
  if (response.text) {
    return Effect.tryPromise({
      try: () => response.text?.() ?? Promise.resolve(""),
      catch: (cause) => new NetworkError({ cause }),
    }).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () => new Response(body, { status: response.status }),
          catch: (cause) => new NetworkError({ cause }),
        }),
      ),
    );
  }
  if (!response.json) {
    return Effect.fail(new NetworkError({ cause: "Response body reader unavailable" }));
  }
  return Effect.tryPromise({
    try: () => response.json?.() ?? Promise.resolve(undefined),
    catch: (cause) => new NetworkError({ cause }),
  }).pipe(
    Effect.flatMap((body) =>
      Effect.try({
        try: () => new Response(JSON.stringify(body), { status: response.status }),
        catch: (cause) => new NetworkError({ cause }),
      }),
    ),
  );
};

export function fetchVersionInfo({
  fetchImpl = globalThis.fetch,
  force = false,
}: FetchVersionOptions = {}): Promise<VersionInfo> {
  const url = force ? "/api/check-update" : "/api/version";
  const legacyFetch: FetchLike = (input) =>
    runPromise(
      Effect.tryPromise({
        try: () =>
          fetchImpl(input, {
            method: force ? "POST" : "GET",
            headers: { Accept: "application/json" },
            cache: "no-store",
          }),
        catch: (cause) => new NetworkError({ cause }),
      }).pipe(Effect.flatMap(normalizeVersionResponse)),
    );
  const request = force
    ? Http.post(url, undefined, VersionInfoSchema, { fetchImpl: legacyFetch })
    : Http.get(url, VersionInfoSchema, { fetchImpl: legacyFetch });
  return runPromise(legacyFailure(request));
}
