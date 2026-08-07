import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  parsePerfResultJson,
  type JsonValue,
  type PerfEnvironment,
  type PerfResult,
} from "./result-schema.ts";
import { summarizeSamples, type SampleStatistics } from "./statistics.ts";

export class IncompatiblePerformanceEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IncompatiblePerformanceEnvironmentError";
  }
}

export interface MetricComparison {
  readonly scenario: string;
  readonly metric: string;
  readonly baseline: SampleStatistics;
  readonly candidate: SampleStatistics;
  /** Null when a zero baseline makes a ratio undefined. */
  readonly medianChangeRatio: number | null;
  readonly regressed: boolean;
}

export interface PerformanceComparison {
  readonly status: "provisional" | "passed" | "failed";
  readonly baselineAccepted: boolean;
  readonly maxMedianRegressionRatio: number;
  readonly comparisons: readonly MetricComparison[];
  readonly message: string;
}

export interface CompareOptions {
  readonly baselineAccepted?: boolean;
  readonly maxMedianRegressionRatio?: number;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function compatibilityIdentity(result: PerfResult): {
  readonly project: string;
  readonly temperature: "cold" | "warm";
  readonly environment: PerfEnvironment;
} {
  return {
    project: result.project,
    temperature: result.run.temperature,
    environment: result.environment,
  };
}

function assertUniformEnvironment(
  results: readonly PerfResult[],
  label: string,
): string {
  if (results.length === 0) throw new Error(`${label} contains no results`);
  const expected = stableJson(compatibilityIdentity(results[0]));
  for (const result of results.slice(1)) {
    const actual = stableJson(compatibilityIdentity(result));
    if (actual !== expected) {
      throw new IncompatiblePerformanceEnvironmentError(
        `${label} mixes incompatible environments (${results[0].run.sampleId} and ${result.run.sampleId})`,
      );
    }
  }
  return expected;
}

export function assertCompatibleEnvironments(
  baseline: readonly PerfResult[],
  candidate: readonly PerfResult[],
): void {
  const baselineIdentity = assertUniformEnvironment(baseline, "baseline");
  const candidateIdentity = assertUniformEnvironment(candidate, "candidate");
  if (baselineIdentity !== candidateIdentity) {
    throw new IncompatiblePerformanceEnvironmentError(
      "baseline and candidate environment identities differ; timing comparison refused",
    );
  }
}

function taskMetrics(result: PerfResult): Readonly<Record<string, number>> {
  const task = result.measurements.task;
  if (typeof task !== "object" || task === null || Array.isArray(task)) {
    throw new Error(
      `${result.run.sampleId} has no object at measurements.task`,
    );
  }
  return Object.fromEntries(
    Object.entries(task)
      .filter((entry): entry is [string, number] => {
        const [name, value]: [string, JsonValue] = entry;
        return (
          name.endsWith("Ms") &&
          typeof value === "number" &&
          Number.isFinite(value)
        );
      })
      .sort(([left], [right]) => left.localeCompare(right)),
  );
}

function groupByScenario(
  results: readonly PerfResult[],
): ReadonlyMap<string, readonly PerfResult[]> {
  const groups = new Map<string, PerfResult[]>();
  for (const result of results) {
    const group = groups.get(result.scenario) ?? [];
    group.push(result);
    groups.set(result.scenario, group);
  }
  return groups;
}

function sameStrings(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((value, index) => value === right[index])
  );
}

function changeRatio(baseline: number, candidate: number): number | null {
  if (baseline === 0) return candidate === 0 ? 0 : null;
  return (candidate - baseline) / baseline;
}

export function comparePerformanceResults(
  baseline: readonly PerfResult[],
  candidate: readonly PerfResult[],
  options: CompareOptions = {},
): PerformanceComparison {
  assertCompatibleEnvironments(baseline, candidate);
  const threshold = options.maxMedianRegressionRatio ?? 0.1;
  if (!Number.isFinite(threshold) || threshold < 0) {
    throw new Error("maxMedianRegressionRatio must be a non-negative number");
  }

  const baselineGroups = groupByScenario(baseline);
  const candidateGroups = groupByScenario(candidate);
  const baselineScenarios = [...baselineGroups.keys()].sort();
  const candidateScenarios = [...candidateGroups.keys()].sort();
  if (!sameStrings(baselineScenarios, candidateScenarios)) {
    throw new Error(
      `scenario sets differ (baseline: ${baselineScenarios.join(", ")}; candidate: ${candidateScenarios.join(", ")})`,
    );
  }

  const comparisons: MetricComparison[] = [];
  for (const scenario of baselineScenarios) {
    const baselineGroup = baselineGroups.get(scenario)!;
    const candidateGroup = candidateGroups.get(scenario)!;
    const baselineMetricNames = Object.keys(taskMetrics(baselineGroup[0]));
    const candidateMetricNames = Object.keys(taskMetrics(candidateGroup[0]));
    if (baselineMetricNames.length === 0) {
      throw new Error(
        `scenario ${scenario} has no numeric task metrics ending in Ms`,
      );
    }
    if (!sameStrings(baselineMetricNames, candidateMetricNames)) {
      throw new Error(`task metric sets differ for scenario ${scenario}`);
    }

    for (const metric of baselineMetricNames) {
      const baselineSamples = baselineGroup.map((result) => {
        const value = taskMetrics(result)[metric];
        if (value === undefined) {
          throw new Error(
            `${result.run.sampleId} is missing task metric ${metric}`,
          );
        }
        return value;
      });
      const candidateSamples = candidateGroup.map((result) => {
        const value = taskMetrics(result)[metric];
        if (value === undefined) {
          throw new Error(
            `${result.run.sampleId} is missing task metric ${metric}`,
          );
        }
        return value;
      });
      const baselineStatistics = summarizeSamples(baselineSamples);
      const candidateStatistics = summarizeSamples(candidateSamples);
      const medianChangeRatio = changeRatio(
        baselineStatistics.median,
        candidateStatistics.median,
      );
      comparisons.push({
        scenario,
        metric,
        baseline: baselineStatistics,
        candidate: candidateStatistics,
        medianChangeRatio,
        regressed:
          medianChangeRatio === null
            ? candidateStatistics.median > 0
            : medianChangeRatio > threshold,
      });
    }
  }

  const baselineAccepted = options.baselineAccepted ?? false;
  const hasRegression = comparisons.some((comparison) => comparison.regressed);
  if (!baselineAccepted) {
    return {
      status: "provisional",
      baselineAccepted,
      maxMedianRegressionRatio: threshold,
      comparisons,
      message:
        "Timing differences are informational because the baseline was not explicitly accepted.",
    };
  }
  return {
    status: hasRegression ? "failed" : "passed",
    baselineAccepted,
    maxMedianRegressionRatio: threshold,
    comparisons,
    message: hasRegression
      ? "An accepted-baseline timing threshold was exceeded."
      : "All accepted-baseline timing thresholds passed.",
  };
}

function resultFilesAt(path: string): string[] {
  const absolute = resolve(path);
  if (!existsSync(absolute))
    throw new Error(`result path does not exist: ${path}`);
  if (!statSync(absolute).isDirectory()) return [absolute];
  return readdirSync(absolute, { withFileTypes: true }).flatMap((entry) => {
    const child = resolve(absolute, entry.name);
    if (entry.isDirectory()) return resultFilesAt(child);
    return entry.isFile() && entry.name.endsWith(".json") ? [child] : [];
  });
}

export function loadPerfResults(paths: readonly string[]): PerfResult[] {
  if (paths.length === 0)
    throw new Error("at least one result path is required");
  const files = paths.flatMap(resultFilesAt).sort();
  if (files.length === 0) throw new Error("no JSON result files were found");
  return files.map((file) => parsePerfResultJson(readFileSync(file, "utf8")));
}

function flagValues(args: readonly string[], flag: string): string[] {
  const values: string[] = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === flag) {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) {
        throw new Error(`${flag} requires a path`);
      }
      values.push(value);
      index += 1;
    }
  }
  return values;
}

function hasFlag(args: readonly string[], flag: string): boolean {
  return args.includes(flag);
}

function numericFlag(
  args: readonly string[],
  flag: string,
): number | undefined {
  const values = flagValues(args, flag);
  if (values.length === 0) return undefined;
  if (values.length > 1) throw new Error(`${flag} may only be specified once`);
  const parsed = Number(values[0]);
  if (!Number.isFinite(parsed)) throw new Error(`${flag} must be numeric`);
  return parsed;
}

export function runComparatorCli(args: readonly string[]): number {
  const baselinePaths = flagValues(args, "--baseline");
  const candidatePaths = flagValues(args, "--candidate");
  if (baselinePaths.length === 0 || candidatePaths.length === 0) {
    throw new Error(
      "usage: compare.ts --baseline <file-or-dir> --candidate <file-or-dir> [--baseline-accepted] [--max-median-regression <ratio>]",
    );
  }
  const comparison = comparePerformanceResults(
    loadPerfResults(baselinePaths),
    loadPerfResults(candidatePaths),
    {
      baselineAccepted:
        hasFlag(args, "--baseline-accepted") ||
        process.env.PICAN_PERF_BASELINE_ACCEPTED === "1",
      maxMedianRegressionRatio: numericFlag(args, "--max-median-regression"),
    },
  );
  console.log(JSON.stringify(comparison, null, 2));
  return comparison.status === "failed" ? 1 : 0;
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  try {
    process.exitCode = runComparatorCli(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
  }
}
