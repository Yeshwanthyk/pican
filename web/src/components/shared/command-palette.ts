import { Effect } from "effect";
import type { FetchLike } from "../../lib/http";
import * as Http from "../../lib/http";
import { SessionListSchema } from "../../lib/schema";
import { runPromise, runSync } from "../../lib/runtime";
import { getSessionRuntime } from "../../session/session-runtime-context";
import type { SessionPaletteApi } from "../../shared/command-palette-runtime";

declare global {
  interface Window {
    __piOpenSessionPalette?: () => unknown;
    __piSessionPalette?: SessionPaletteApi;
  }
}

export interface PaletteSession {
  readonly id: string;
  readonly title: string;
  readonly meta: string;
  readonly href: string;
  readonly searchText: string;
  readonly [key: string]: unknown;
}

export type PaletteSessionInput = Readonly<Record<string, unknown>>;

const stringField = (session: PaletteSessionInput, ...keys: ReadonlyArray<string>): string => {
  for (const key of keys) {
    const value = session[key];
    if (typeof value === "string" && value) return value;
  }
  return "";
};
const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export function normalizePaletteSession(session: PaletteSessionInput): PaletteSession {
  const id = stringField(session, "id", "ID");
  const title = stringField(session, "title", "Name", "name", "ID", "id") || "Session";
  const project = stringField(session, "Project", "project");
  const model = stringField(session, "Model", "model");
  const provider = stringField(session, "ModelProvider", "modelProvider");
  const runtime = stringField(session, "Runtime", "runtime") || "pi";
  const nativeId = stringField(session, "NativeID", "nativeId");
  const meta =
    stringField(session, "meta") || [provider, model].filter(Boolean).join("/") || project;
  const href = stringField(session, "href") || (id ? `/session?id=${encodeURIComponent(id)}` : "");
  const explicitSearch = stringField(session, "searchText");
  return {
    ...session,
    id,
    title,
    meta,
    href,
    searchText: (
      explicitSearch ||
      [title, id, meta, project, model, provider, runtime, nativeId].filter(Boolean).join(" ")
    ).toLowerCase(),
  };
}

export function sessionsFromCards(
  documentImpl: Document = document,
): ReadonlyArray<PaletteSession> {
  return Array.from(
    documentImpl.querySelectorAll<HTMLElement>(".session-card[data-session-id]"),
  ).map((card) => {
    const title =
      card.querySelector(".session-title")?.textContent?.trim() ||
      card.dataset.sessionId ||
      "Session";
    const meta =
      card.querySelector("[data-session-model]")?.textContent?.trim() ||
      card.querySelector(".session-time")?.textContent?.trim() ||
      "";
    return normalizePaletteSession({
      id: card.dataset.sessionId || "",
      title,
      meta,
      href: card.getAttribute("href") || "",
      searchText: card.dataset.search || [title, meta, card.dataset.sessionId || ""].join(" "),
    });
  });
}

export function defaultSessionPaletteCwd(): string {
  return runSync(
    Effect.try({
      try: () => {
        const model = getSessionRuntime().model;
        const header = isRecord(model) && isRecord(model.header) ? model.header : {};
        return typeof header.cwd === "string" ? header.cwd : "";
      },
      catch: () => "session runtime unavailable",
    }).pipe(Effect.catch(() => Effect.succeed(""))),
  );
}

export function fetchPaletteSessions({
  fetchImpl = globalThis.fetch,
  getCwd = defaultSessionPaletteCwd,
  query = "",
  limit = 50,
}: {
  readonly fetchImpl?: FetchLike;
  readonly getCwd?: () => string;
  readonly query?: string;
  readonly limit?: number;
} = {}): Promise<ReadonlyArray<PaletteSessionInput>> {
  const params = new URLSearchParams();
  const cwd = getCwd();
  if (cwd) params.set("project", cwd);
  if (query) params.set("q", query);
  if (Number.isFinite(limit) && limit > 0) params.set("limit", String(limit));
  const suffix = params.toString();
  return runPromise(
    Http.get(`/api/sessions${suffix ? `?${suffix}` : ""}`, SessionListSchema, { fetchImpl }).pipe(
      Effect.map(({ sessions }) =>
        [...sessions].sort((a, b) =>
          String(b.LastActivity || b.lastActivity || "").localeCompare(
            String(a.LastActivity || a.lastActivity || ""),
          ),
        ),
      ),
    ),
  );
}

export function filterPaletteSessions(
  sessions: ReadonlyArray<PaletteSession>,
  query: string,
): ReadonlyArray<PaletteSession> {
  if (!query) return sessions;
  const normalized = query.toLowerCase();
  return sessions.filter((session) => session.searchText.includes(normalized));
}
