import { Effect, Match } from "effect";
import { effects } from "../shared/api.js";
import type { RequestOptions } from "../lib/http";
import { runPromise, runSync } from "../lib/runtime";
import { OkResponseSchema } from "../lib/schema";
import type { Schedule } from "../lib/schema";

// Frequency presets the editor offers. 'custom' surfaces a raw cron field;
// 'manual' stores no cron (Run-now only). All others are sugar that compile to a
// standard 5-field cron expression via buildCron().
export const FREQUENCIES = ["manual", "hourly", "daily", "weekdays", "weekly", "custom"] as const;
export type Frequency = (typeof FREQUENCIES)[number];

export interface CronFields {
  readonly frequency?: Frequency;
  readonly minute?: number | string;
  readonly hour?: number | string;
  readonly weekday?: number | string;
}

export interface ParsedCron {
  readonly frequency: Frequency;
  readonly minute: number;
  readonly hour: number;
  readonly weekday: number;
}

type Translate = (key: string, params?: Readonly<Record<string, unknown>>) => string;

function pad2(n: number): string {
  return String(n).padStart(2, "0");
}

// buildCron compiles a preset + time fields into a standard cron expression.
// minute 0-59, hour 0-23, weekday 0-6 (0=Sunday). Returns '' for manual/custom
// (custom carries its own raw expression).
export function buildCron({
  frequency,
  minute = 0,
  hour = 9,
  weekday = 1,
}: CronFields = {}): string {
  const m = clampInt(minute, 0, 59, 0);
  const h = clampInt(hour, 0, 23, 9);
  const d = clampInt(weekday, 0, 6, 1);
  return Match.value(frequency).pipe(
    Match.when("hourly", () => `${m} * * * *`),
    Match.when("daily", () => `${m} ${h} * * *`),
    Match.when("weekdays", () => `${m} ${h} * * 1-5`),
    Match.when("weekly", () => `${m} ${h} * * ${d}`),
    Match.when("manual", () => ""),
    Match.when("custom", () => ""),
    Match.when(undefined, () => ""),
    Match.exhaustive,
  );
}

function clampInt(value: number | string, min: number, max: number, fallback: number): number {
  const n = Number.parseInt(String(value), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

// parseCron does the inverse of buildCron for editing: it recognizes the shapes
// buildCron emits and reports the matching preset + fields. Anything else is
// reported as 'custom' so the raw expression stays editable and lossless.
export function parseCron(expr: string | null | undefined): ParsedCron {
  const trimmed = (expr || "").trim();
  if (!trimmed) return { frequency: "manual", minute: 0, hour: 9, weekday: 1 };
  const parts = trimmed.split(/\s+/);
  if (parts.length !== 5) return { frequency: "custom", minute: 0, hour: 9, weekday: 1 };
  const min = parts[0] ?? "";
  const hr = parts[1] ?? "";
  const dom = parts[2] ?? "";
  const mon = parts[3] ?? "";
  const dow = parts[4] ?? "";
  const minute = numOrNull(min);
  const hour = numOrNull(hr);
  if (minute === null || dom !== "*" || mon !== "*") {
    return { frequency: "custom", minute: 0, hour: 9, weekday: 1 };
  }
  if (hr === "*" && dow === "*") {
    return { frequency: "hourly", minute, hour: 9, weekday: 1 };
  }
  if (hour === null) return { frequency: "custom", minute: 0, hour: 9, weekday: 1 };
  if (dow === "*") return { frequency: "daily", minute, hour, weekday: 1 };
  if (dow === "1-5") return { frequency: "weekdays", minute, hour, weekday: 1 };
  const weekday = numOrNull(dow);
  if (weekday !== null && weekday >= 0 && weekday <= 6) {
    return { frequency: "weekly", minute, hour, weekday };
  }
  return { frequency: "custom", minute: 0, hour: 9, weekday: 1 };
}

function numOrNull(s: string): number | null {
  if (!/^\d+$/.test(s)) return null;
  return Number.parseInt(s, 10);
}

// describeFrequency renders a short human label for a schedule's cadence. tr is
// the t() string lookup; passing it keeps this module free of a copy dependency.
export function describeFrequency(schedule: Pick<Schedule, "cronExpr">, tr?: Translate): string {
  const t: Translate = tr ?? ((key) => key);
  const expr = (schedule.cronExpr || "").trim();
  if (!expr) return t("schedules.freqManual");
  const { frequency, minute, hour, weekday } = parseCron(expr);
  const time = `${pad2(hour)}:${pad2(minute)}`;
  return Match.value(frequency).pipe(
    Match.when("hourly", () => t("schedules.freqHourlyAt", { minute: pad2(minute) })),
    Match.when("daily", () => t("schedules.freqDailyAt", { time })),
    Match.when("weekdays", () => t("schedules.freqWeekdaysAt", { time })),
    Match.when("weekly", () =>
      t("schedules.freqWeeklyAt", { day: t("schedules.weekday" + weekday), time }),
    ),
    Match.when("manual", () => expr),
    Match.when("custom", () => expr),
    Match.exhaustive,
  );
}

export function defaultFetchSchedules() {
  return runPromise(effects.schedules.list);
}
export function defaultFetchScheduleRuns(id: string) {
  return runPromise(effects.schedules.runs(id));
}
export function defaultCreateSchedule(payload: unknown) {
  return runPromise(effects.schedules.create(payload));
}
export function defaultUpdateSchedule(id: string, payload: unknown) {
  return runPromise(effects.schedules.update(id, payload));
}
export function defaultRunSchedule(id: string) {
  return runPromise(effects.schedules.run(id));
}
export function defaultDeleteSchedule(id: string, options: RequestOptions = {}) {
  return runPromise(
    effects.del(`/api/schedule?id=${encodeURIComponent(id)}`, OkResponseSchema, options),
  );
}
export function defaultFetchModels() {
  return runPromise(effects.models);
}
export function defaultFetchRecent() {
  return runPromise(effects.sessions.recentLocations);
}

// guessTimezone returns the browser's IANA timezone, falling back to ''.
export function guessTimezone(): string {
  return runSync(
    Effect.try({
      try: () => Intl.DateTimeFormat().resolvedOptions().timeZone || "",
      catch: (cause) => cause,
    }).pipe(Effect.catch(() => Effect.succeed(""))),
  );
}
