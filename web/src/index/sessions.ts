import { effects } from "../shared/api.js";
import type { FetchLike } from "../lib/http";
import { runPromise } from "../lib/runtime";
import {
  NewSessionResponseSchema,
  RuntimesResponseSchema,
  SessionListSchema,
  MutationResponseSchema,
} from "../lib/schema";
import type { RecentLocations, RuntimesResponse, Session, SessionList } from "../lib/schema";
import { t } from "../shared/strings.js";
import {
  normalizeRuntimeCapabilities,
  type CompleteRuntimeCapabilities,
} from "../lib/runtime-capabilities";

export interface NormalizedSession {
  id: string;
  sessionUUID: string;
  runtime: string;
  nativeId: string;
  project: string;
  lastActivity: string;
  name: string;
  messageCount: number;
  tokenTotal: number;
  costTotal: number;
  model: string;
  modelProvider: string;
  chatAvailable: boolean;
  chatDisabledReason: string;
  pinned: boolean;
  pinOrder: number;
  btw: boolean;
  currentActivity: string;
  activityStartedAt: string;
  waitingQuestion: string;
  waitingSince: string;
  waitingOptions: string[];
  archived: boolean;
}

export interface NormalizedRuntime {
  readonly id: string;
  readonly label: string;
  readonly available: boolean;
  readonly reason: string;
  readonly projectionMode: string;
  readonly capabilities: CompleteRuntimeCapabilities;
}

export interface NormalizedRuntimesResponse {
  readonly defaultRuntime: string;
  readonly runtimes: ReadonlyArray<NormalizedRuntime>;
  readonly selectedRuntime: string;
}

interface FetchOptions {
  readonly fetchImpl?: FetchLike;
}

interface SessionActivity {
  readonly lastActivity?: string | null;
  readonly LastActivity?: string | null;
}

interface SessionModel {
  readonly model?: string | null;
  readonly modelProvider?: string | null;
}

interface SessionSearch extends SessionModel {
  readonly name?: string | null;
  readonly project?: string | null;
  readonly sessionUUID?: string | null;
  readonly runtime?: string | null;
  readonly nativeId?: string | null;
}

interface SessionMetrics {
  readonly tokenTotal?: number | null;
  readonly costTotal?: number | null;
}

export const sessionsCountLabel = (n: number): string =>
  n === 1 ? t("index.sessionCountOne") : t("index.sessionsCount", { count: n });

export function normalizeSession(raw: Partial<Session> = {}): NormalizedSession {
  return {
    id: raw.id || raw.ID || "",
    sessionUUID: raw.sessionUUID || raw.SessionUUID || "",
    runtime: String(raw.runtime || raw.Runtime || "pi").toLowerCase(),
    nativeId: raw.nativeId || raw.NativeID || "",
    project: raw.project || raw.Project || "",
    lastActivity: raw.lastActivity || raw.LastActivity || "",
    name: raw.name || raw.Name || raw.id || raw.ID || "",
    messageCount: raw.messageCount ?? raw.MessageCount ?? 0,
    tokenTotal: raw.tokenTotal ?? raw.TokenTotal ?? 0,
    costTotal: raw.costTotal ?? raw.CostTotal ?? 0,
    model: raw.model || raw.Model || "",
    modelProvider: raw.modelProvider || raw.ModelProvider || "",
    chatAvailable: raw.chatAvailable ?? raw.ChatAvailable ?? true,
    chatDisabledReason: raw.chatDisabledReason || raw.ChatDisabledReason || "",
    pinned: raw.pinned ?? raw.Pinned ?? false,
    pinOrder: raw.pinOrder ?? raw.PinOrder ?? 0,
    btw: raw.btw ?? raw.Btw ?? false,
    currentActivity: raw.currentActivity || raw.CurrentActivity || "",
    activityStartedAt: raw.activityStartedAt || raw.ActivityStartedAt || "",
    waitingQuestion: raw.waitingQuestion || raw.WaitingQuestion || "",
    waitingSince: raw.waitingSince || raw.WaitingSince || "",
    waitingOptions: [...(raw.waitingOptions || raw.WaitingOptions || [])],
    archived: raw.archived ?? raw.Archived ?? false,
  };
}

export interface HomeSessionSplit<T> {
  readonly live: T[];
  readonly waiting: T[];
  readonly pinned: T[];
  readonly rest: T[];
}

export function stabilizeHomeSessionOrder<T extends { readonly id: string }>(
  previous: ReadonlyArray<T>,
  incoming: ReadonlyArray<T>,
): T[] {
  if (previous.length === 0) return [...incoming];

  const incomingByID = new Map(incoming.map((session) => [session.id, session]));
  const previousIDs = new Set(previous.map((session) => session.id));
  const fresh = incoming.filter((session) => !previousIDs.has(session.id));
  const retained = previous.flatMap((session) => {
    const replacement = incomingByID.get(session.id);
    return replacement ? [replacement] : [];
  });
  return [...fresh, ...retained];
}

export function splitHomeSessions<
  T extends SessionActivity & {
    readonly id: string;
    readonly pinned?: boolean;
    readonly waitingQuestion?: string;
  },
>(sessions: ReadonlyArray<T>, runningIds: ReadonlySet<string>): HomeSessionSplit<T> {
  const live: T[] = [];
  const waiting: T[] = [];
  const lower: T[] = [];
  for (const session of sessions) {
    if (session.pinned) lower.push(session);
    else if (session.waitingQuestion) waiting.push(session);
    else if (runningIds.has(session.id)) live.push(session);
    else lower.push(session);
  }
  const { pinned, rest } = splitPinnedSessions(lower);
  return { live, waiting, pinned, rest };
}

// splitPinnedSessions separates pinned sessions from the rest, sorting the
// pinned group by activity (newest first) so it reads like its own mini
// timeline above the regular groups.
export function splitPinnedSessions<
  T extends SessionActivity & { readonly pinned?: boolean; readonly pinOrder?: number },
>(sessions: ReadonlyArray<T> = []): { pinned: T[]; rest: T[] } {
  const pinned: T[] = [];
  const rest: T[] = [];
  for (const session of sessions) {
    if (session?.pinned) pinned.push(session);
    else rest.push(session);
  }
  pinned.sort(
    (a, b) => (a.pinOrder || Number.MAX_SAFE_INTEGER) - (b.pinOrder || Number.MAX_SAFE_INTEGER),
  );
  return { pinned, rest };
}

// shouldRefetchOnReload damps the reload storm: the server broadcasts a
// global "reload:<id>" for every append to ANY streaming session, but the
// sessions list only needs to reflect a known session's activity time
// occasionally, not on every single append. Refetch unconditionally when id
// is unknown/empty (a brand-new session should appear promptly); otherwise
// only after throttleMs has elapsed since the last known-id-triggered
// refetch.
export function shouldRefetchOnReload({
  id,
  knownIds,
  lastRefreshAt,
  now,
  throttleMs,
}: {
  readonly id?: string;
  readonly knownIds: ReadonlySet<string>;
  readonly lastRefreshAt: number;
  readonly now: number;
  readonly throttleMs: number;
}): boolean {
  if (!id || !knownIds.has(id)) return true;
  return now - lastRefreshAt >= throttleMs;
}

export function activityMs(session: SessionActivity | null | undefined): number {
  const ms = Date.parse(session?.lastActivity || session?.LastActivity || "");
  return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
}

export function formatRelativeTime(timestamp: string | number | Date, now = Date.now()): string {
  const date = new Date(timestamp);
  if (Number.isNaN(date.getTime())) return "";
  const seconds = Math.max(0, Math.floor((now - date.getTime()) / 1000));
  const units: ReadonlyArray<readonly [string, number]> = [
    ["year", 31536000],
    ["month", 2592000],
    ["week", 604800],
    ["day", 86400],
    ["hour", 3600],
    ["minute", 60],
  ];
  for (const [name, size] of units) {
    const count = Math.floor(seconds / size);
    if (count >= 1) return `${count} ${name}${count === 1 ? "" : "s"} ago`;
  }
  return "just now";
}

export function sessionModelLabel(session: SessionModel = {}): string {
  if (!session.model) return "";
  return session.modelProvider ? `${session.modelProvider}/${session.model}` : session.model;
}

export function sessionSearchText(session: SessionSearch = {}): string {
  return `${session.name || ""} ${session.project || ""} ${sessionModelLabel(session)} ${session.sessionUUID || ""} ${session.runtime || "pi"} ${session.nativeId || ""}`.trim();
}

const runtimeLabel = (id: string, label: string | undefined): string => {
  const key = `runtime.${id}`;
  const translated = t(key);
  return translated === key ? String(label || id).trim() || id : translated;
};

export function normalizeRuntimesResponse(raw: RuntimesResponse = {}): NormalizedRuntimesResponse {
  const runtimes = (Array.isArray(raw.runtimes) ? raw.runtimes : [])
    .map((entry) => {
      const id = String(entry?.id || "")
        .trim()
        .toLowerCase();
      return {
        id,
        label: runtimeLabel(id, entry?.label),
        available: entry?.available !== false,
        reason: String(entry?.reason || "").trim(),
        projectionMode: String(entry?.projectionMode || "").trim(),
        capabilities: normalizeRuntimeCapabilities(entry?.capabilities, id),
      };
    })
    .filter((entry) => entry.id);
  const normalizedRuntimes = runtimes.length
    ? runtimes
    : [
        {
          id: "pi",
          label: t("runtime.pi"),
          available: true,
          reason: "",
          projectionMode: "",
          capabilities: normalizeRuntimeCapabilities(undefined, "pi"),
        },
      ];
  const requestedDefault = String(raw.defaultRuntime || "pi")
    .trim()
    .toLowerCase();
  const defaultEntry = normalizedRuntimes.find(
    (entry) => entry.id === requestedDefault && entry.available && entry.capabilities.create,
  );
  const selectedRuntime =
    defaultEntry?.id ||
    normalizedRuntimes.find((entry) => entry.available && entry.capabilities.create)?.id ||
    "";
  return {
    defaultRuntime: requestedDefault || "pi",
    runtimes: normalizedRuntimes,
    selectedRuntime,
  };
}

// formatTokenAbbrev renders a token count with a k/M suffix (one decimal,
// trimmed when it's a whole number), e.g. 12300 -> "12.3k", 1500000 -> "1.5M".
function formatTokenAbbrev(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  return String(Math.round(n));
}

export function formatElapsed(timestamp: string, now = Date.now()): string {
  const startedAt = Date.parse(timestamp);
  if (!Number.isFinite(startedAt)) return "";
  const seconds = Math.max(0, Math.floor((now - startedAt) / 1000));
  if (seconds < 60) return t("index.durationSeconds", { count: seconds });
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return t("index.durationMinutes", { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t("index.durationHours", { count: hours });
  return t("index.durationDays", { count: Math.floor(hours / 24) });
}

// formatSessionMetrics renders the card's subtle "12.3k tok · $0.42" metadata
// line from already-fetched summary fields. Either half is omitted when zero;
// the whole line is '' when both are.
export function formatSessionMetrics(session: SessionMetrics = {}): string {
  const tokens = Number(session.tokenTotal) || 0;
  const cost = Number(session.costTotal) || 0;
  const parts: string[] = [];
  if (tokens > 0) parts.push(`${formatTokenAbbrev(tokens)} tok`);
  if (cost > 0) parts.push(`$${cost.toFixed(2)}`);
  return parts.join(" · ");
}

export interface RunningStatus {
  readonly modelName?: string;
  readonly model?: string;
  readonly modelProvider?: string;
}

export function formatRunningModel(status: RunningStatus | null | undefined): string {
  if (!status || typeof status !== "object") return "";
  const model =
    typeof status.modelName === "string" && status.modelName
      ? status.modelName
      : typeof status.model === "string"
        ? status.model
        : "";
  const provider = typeof status.modelProvider === "string" ? status.modelProvider : "";
  if (model && provider) return `${provider}/${model}`;
  return model || provider;
}

export interface ProjectSessionGroup<T> {
  readonly project: string;
  readonly sessions: T[];
  latest: number;
  readonly index: number;
}

export interface TrackedProjectGroup<T> {
  readonly project: string;
  readonly sessions: T[];
  readonly total: number;
  readonly latest: number;
}

export function groupTrackedProjectSessions<
  T extends SessionActivity & { readonly project?: string },
>(
  sessions: ReadonlyArray<T>,
  projects: ReadonlyArray<{
    readonly path: string;
    readonly tracked?: boolean;
    readonly sessionCount?: number;
  }>,
): Array<TrackedProjectGroup<T>> {
  const sessionsByProject = new Map<string, T[]>();
  for (const session of sessions) {
    const project = session.project || "";
    const group = sessionsByProject.get(project) || [];
    group.push(session);
    sessionsByProject.set(project, group);
  }

  return projects
    .filter((project) => project.tracked)
    .map((project) => {
      const projectSessions = [...(sessionsByProject.get(project.path) || [])].slice(0, 6);
      return {
        project: project.path,
        sessions: projectSessions,
        total: project.sessionCount || 0,
        latest: projectSessions.reduce(
          (latest, session) => Math.max(latest, activityMs(session)),
          Number.NEGATIVE_INFINITY,
        ),
      };
    });
}

export function projectDisplayName(path: string): string {
  const normalized = path.replace(/\/+$/, "");
  return normalized.slice(normalized.lastIndexOf("/") + 1) || path;
}

export function groupSessionsByProject<T extends SessionActivity & { readonly project?: string }>(
  sessions: ReadonlyArray<T> = [],
): Array<ProjectSessionGroup<T>> {
  const groups: Array<ProjectSessionGroup<T>> = [];
  const byProject = new Map<string, ProjectSessionGroup<T>>();
  for (const session of sessions) {
    const project = session.project || "";
    let group = byProject.get(project);
    if (!group) {
      group = { project, sessions: [], latest: Number.NEGATIVE_INFINITY, index: groups.length };
      byProject.set(project, group);
      groups.push(group);
    }
    group.sessions.push(session);
    group.latest = Math.max(group.latest, activityMs(session));
  }
  groups.forEach((group) => group.sessions.sort((a, b) => activityMs(b) - activityMs(a)));
  groups.sort((a, b) => b.latest - a.latest || a.index - b.index);
  return groups;
}

export const dateBucketOrder = [
  "today",
  "yesterday",
  "previous7days",
  "previous30days",
  "older",
] as const;

export type DateBucket = (typeof dateBucketOrder)[number];

export function dateBucketFor(ms: number, now = Date.now()): DateBucket {
  if (!Number.isFinite(ms)) return "older";
  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  const day = 86400000;
  const today = startOfToday.getTime();
  if (ms >= today) return "today";
  if (ms >= today - day) return "yesterday";
  if (ms >= today - 7 * day) return "previous7days";
  if (ms >= today - 30 * day) return "previous30days";
  return "older";
}

export interface DateSessionGroup<T> {
  readonly bucket: DateBucket;
  readonly sessions: T[];
}

export function groupSessionsByDate<T extends SessionActivity>(
  sessions: ReadonlyArray<T> = [],
  now = Date.now(),
): Array<DateSessionGroup<T>> {
  const sorted = [...sessions].sort((a, b) => activityMs(b) - activityMs(a));
  const byBucket = new Map<DateBucket, DateSessionGroup<T>>();
  for (const session of sorted) {
    const bucket = dateBucketFor(activityMs(session), now);
    let group = byBucket.get(bucket);
    if (!group) {
      group = { bucket, sessions: [] };
      byBucket.set(bucket, group);
    }
    group.sessions.push(session);
  }
  return dateBucketOrder
    .filter((bucket) => byBucket.has(bucket))
    .flatMap((bucket) => {
      const group = byBucket.get(bucket);
      return group ? [group] : [];
    });
}

export type SessionView = "home" | "all" | "archived";

export interface SessionQuery {
  readonly limit?: number;
  readonly offset?: number;
  readonly query?: string;
  readonly view?: SessionView;
  readonly project?: string;
}

export function sessionsURL(values: SessionQuery = {}): string {
  const params = new URLSearchParams();
  if (values.limit !== undefined) params.set("limit", String(values.limit));
  if (values.offset !== undefined) params.set("offset", String(values.offset));
  if (values.query) params.set("q", values.query);
  if (values.project) params.set("project", values.project);
  else if (values.view) params.set("view", values.view);
  const encoded = params.toString();
  return encoded ? `/api/sessions?${encoded}` : "/api/sessions";
}

export function defaultFetchSessions(values: SessionQuery = {}): Promise<SessionList> {
  return runPromise(effects.get(sessionsURL(values), SessionListSchema));
}
export function defaultFetchRecent(): Promise<RecentLocations> {
  return runPromise(effects.sessions.recentLocations);
}
export function normalizeRecentLocations(response: RecentLocations): string[] {
  return response.locations.map((location) =>
    typeof location === "string" ? location : location.path,
  );
}
export function defaultFetchRuntimes({ fetchImpl = globalThis.fetch }: FetchOptions = {}) {
  const legacyFetch: FetchLike = (input) =>
    fetchImpl(input, { headers: { Accept: "application/json" } });
  return runPromise(
    effects.get("/api/runtimes", RuntimesResponseSchema, { fetchImpl: legacyFetch }),
  );
}
export function defaultCreateSession(
  path: string,
  runtime = "pi",
  { fetchImpl = globalThis.fetch }: FetchOptions = {},
) {
  const legacyFetch: FetchLike = (input, init) =>
    fetchImpl(input, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: init?.body,
    });
  return runPromise(
    effects.post("/api/new-session", { path, runtime: runtime || "pi" }, NewSessionResponseSchema, {
      fetchImpl: legacyFetch,
    }),
  );
}
export function defaultFetchProjects() {
  return runPromise(effects.sessions.projects);
}
export function defaultUpdateProject(path: string, action: string) {
  return runPromise(effects.sessions.updateProject(path, action));
}
export function defaultUpdatePin(sessionId: string, pinned: boolean) {
  return runPromise(effects.sessions.updatePin(sessionId, pinned));
}
export function defaultUpdateArchive(sessionId: string, archived: boolean) {
  return runPromise(effects.post("/api/archives", { sessionId, archived }, MutationResponseSchema));
}
