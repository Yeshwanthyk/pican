export const PERF_RESULT_KIND = "pican-performance-result";
export const PERF_RESULT_SCHEMA_VERSION = 2 as const;
export const PERF_PROFILE_VERSION = 1 as const;

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

export type CapabilityStatus =
  | "supported"
  | "unsupported"
  | "unavailable"
  | "not-requested";

export interface Capability {
  readonly status: CapabilityStatus;
  readonly reason: string | null;
}

export interface PerfProfile {
  readonly id: "unthrottled-local" | "mobile4g";
  readonly version: typeof PERF_PROFILE_VERSION;
  readonly parameters: {
    readonly latencyMs: number | null;
    readonly downloadBytesPerSecond: number | null;
    readonly uploadBytesPerSecond: number | null;
    readonly cpuSlowdownFactor: number | null;
  };
}

export interface PerfEnvironment {
  readonly os: {
    readonly platform: string;
    readonly release: string;
    readonly arch: string;
  };
  readonly nodeVersion: string;
  readonly playwrightVersion: string | null;
  readonly browser: {
    readonly name: string;
    readonly version: string | null;
  };
  readonly viewport: {
    readonly width: number;
    readonly height: number;
    readonly deviceScaleFactor: number;
  };
  readonly headless: boolean;
  readonly profile: PerfProfile;
  readonly capabilities: {
    readonly cdp: Capability;
    readonly networkThrottling: Capability;
    readonly cpuThrottling: Capability;
    readonly resourceTiming: Capability;
    readonly longTasks: Capability;
    readonly layoutShift: Capability;
    readonly largestContentfulPaint: Capability;
    readonly performanceMemory: Capability;
    readonly chromiumMemory: Capability;
  };
}

export interface PerfResult {
  readonly kind: typeof PERF_RESULT_KIND;
  readonly schemaVersion: typeof PERF_RESULT_SCHEMA_VERSION;
  readonly capturedAt: string;
  readonly git: {
    readonly sha: string;
    readonly dirty: boolean;
  };
  readonly run: {
    readonly runId: string;
    readonly sampleId: string;
    readonly repetition: number;
    readonly temperature: "cold" | "warm";
  };
  readonly project: string;
  readonly scenario: string;
  readonly environment: PerfEnvironment;
  readonly measurements: { readonly [key: string]: JsonValue };
}

export class PerfResultValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PerfResultValidationError";
  }
}

function fail(path: string, message: string): never {
  throw new PerfResultValidationError(`${path}: ${message}`);
}

function objectAt(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "expected an object");
  }
  return value as Record<string, unknown>;
}

function stringAt(value: unknown, path: string, allowEmpty = false): string {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    fail(path, "expected a non-empty string");
  }
  return value;
}

function nullableStringAt(value: unknown, path: string): string | null {
  if (value === null) return null;
  return stringAt(value, path);
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "expected a boolean");
  return value;
}

function finiteNumberAt(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(path, "expected a finite number");
  }
  return value;
}

function nonNegativeNumberAt(value: unknown, path: string): number {
  const number = finiteNumberAt(value, path);
  if (number < 0) fail(path, "expected a non-negative number");
  return number;
}

function positiveNumberAt(value: unknown, path: string): number {
  const number = finiteNumberAt(value, path);
  if (number <= 0) fail(path, "expected a positive number");
  return number;
}

function positiveIntegerAt(value: unknown, path: string): number {
  const number = positiveNumberAt(value, path);
  if (!Number.isInteger(number)) fail(path, "expected a positive integer");
  return number;
}

function nullableNonNegativeNumberAt(
  value: unknown,
  path: string,
): number | null {
  if (value === null) return null;
  return nonNegativeNumberAt(value, path);
}

function literalAt<T extends string | number>(
  value: unknown,
  expected: T,
  path: string,
): T {
  if (value !== expected) fail(path, `expected ${JSON.stringify(expected)}`);
  return expected;
}

function enumAt<const T extends readonly string[]>(
  value: unknown,
  options: T,
  path: string,
): T[number] {
  if (typeof value !== "string" || !options.includes(value)) {
    fail(path, `expected one of ${options.join(", ")}`);
  }
  return value as T[number];
}

function capabilityAt(value: unknown, path: string): Capability {
  const capability = objectAt(value, path);
  return {
    status: enumAt(
      capability.status,
      ["supported", "unsupported", "unavailable", "not-requested"] as const,
      `${path}.status`,
    ),
    reason: nullableStringAt(capability.reason, `${path}.reason`),
  };
}

function jsonValueAt(value: unknown, path: string): JsonValue {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") return finiteNumberAt(value, path);
  if (Array.isArray(value)) {
    return value.map((item, index) => jsonValueAt(item, `${path}[${index}]`));
  }
  const object = objectAt(value, path);
  return Object.fromEntries(
    Object.entries(object).map(([key, item]) => [
      key,
      jsonValueAt(item, `${path}.${key}`),
    ]),
  );
}

function profileAt(value: unknown, path: string): PerfProfile {
  const profile = objectAt(value, path);
  const parameters = objectAt(profile.parameters, `${path}.parameters`);
  return {
    id: enumAt(
      profile.id,
      ["unthrottled-local", "mobile4g"] as const,
      `${path}.id`,
    ),
    version: literalAt(
      profile.version,
      PERF_PROFILE_VERSION,
      `${path}.version`,
    ),
    parameters: {
      latencyMs: nullableNonNegativeNumberAt(
        parameters.latencyMs,
        `${path}.parameters.latencyMs`,
      ),
      downloadBytesPerSecond: nullableNonNegativeNumberAt(
        parameters.downloadBytesPerSecond,
        `${path}.parameters.downloadBytesPerSecond`,
      ),
      uploadBytesPerSecond: nullableNonNegativeNumberAt(
        parameters.uploadBytesPerSecond,
        `${path}.parameters.uploadBytesPerSecond`,
      ),
      cpuSlowdownFactor: nullableNonNegativeNumberAt(
        parameters.cpuSlowdownFactor,
        `${path}.parameters.cpuSlowdownFactor`,
      ),
    },
  };
}

function environmentAt(value: unknown, path: string): PerfEnvironment {
  const environment = objectAt(value, path);
  const os = objectAt(environment.os, `${path}.os`);
  const browser = objectAt(environment.browser, `${path}.browser`);
  const viewport = objectAt(environment.viewport, `${path}.viewport`);
  const capabilities = objectAt(
    environment.capabilities,
    `${path}.capabilities`,
  );
  return {
    os: {
      platform: stringAt(os.platform, `${path}.os.platform`),
      release: stringAt(os.release, `${path}.os.release`),
      arch: stringAt(os.arch, `${path}.os.arch`),
    },
    nodeVersion: stringAt(environment.nodeVersion, `${path}.nodeVersion`),
    playwrightVersion: nullableStringAt(
      environment.playwrightVersion,
      `${path}.playwrightVersion`,
    ),
    browser: {
      name: stringAt(browser.name, `${path}.browser.name`),
      version: nullableStringAt(browser.version, `${path}.browser.version`),
    },
    viewport: {
      width: positiveIntegerAt(viewport.width, `${path}.viewport.width`),
      height: positiveIntegerAt(viewport.height, `${path}.viewport.height`),
      deviceScaleFactor: positiveNumberAt(
        viewport.deviceScaleFactor,
        `${path}.viewport.deviceScaleFactor`,
      ),
    },
    headless: booleanAt(environment.headless, `${path}.headless`),
    profile: profileAt(environment.profile, `${path}.profile`),
    capabilities: {
      cdp: capabilityAt(capabilities.cdp, `${path}.capabilities.cdp`),
      networkThrottling: capabilityAt(
        capabilities.networkThrottling,
        `${path}.capabilities.networkThrottling`,
      ),
      cpuThrottling: capabilityAt(
        capabilities.cpuThrottling,
        `${path}.capabilities.cpuThrottling`,
      ),
      resourceTiming: capabilityAt(
        capabilities.resourceTiming,
        `${path}.capabilities.resourceTiming`,
      ),
      longTasks: capabilityAt(
        capabilities.longTasks,
        `${path}.capabilities.longTasks`,
      ),
      layoutShift: capabilityAt(
        capabilities.layoutShift,
        `${path}.capabilities.layoutShift`,
      ),
      largestContentfulPaint: capabilityAt(
        capabilities.largestContentfulPaint,
        `${path}.capabilities.largestContentfulPaint`,
      ),
      performanceMemory: capabilityAt(
        capabilities.performanceMemory,
        `${path}.capabilities.performanceMemory`,
      ),
      chromiumMemory: capabilityAt(
        capabilities.chromiumMemory,
        `${path}.capabilities.chromiumMemory`,
      ),
    },
  };
}

export function parsePerfResult(value: unknown): PerfResult {
  const result = objectAt(value, "result");
  literalAt(result.kind, PERF_RESULT_KIND, "result.kind");
  literalAt(
    result.schemaVersion,
    PERF_RESULT_SCHEMA_VERSION,
    "result.schemaVersion",
  );
  const capturedAt = stringAt(result.capturedAt, "result.capturedAt");
  if (!Number.isFinite(Date.parse(capturedAt))) {
    fail("result.capturedAt", "expected an ISO-compatible timestamp");
  }
  const git = objectAt(result.git, "result.git");
  const run = objectAt(result.run, "result.run");
  const measurements = objectAt(result.measurements, "result.measurements");

  return {
    kind: PERF_RESULT_KIND,
    schemaVersion: PERF_RESULT_SCHEMA_VERSION,
    capturedAt,
    git: {
      sha: stringAt(git.sha, "result.git.sha"),
      dirty: booleanAt(git.dirty, "result.git.dirty"),
    },
    run: {
      runId: stringAt(run.runId, "result.run.runId"),
      sampleId: stringAt(run.sampleId, "result.run.sampleId"),
      repetition: positiveIntegerAt(run.repetition, "result.run.repetition"),
      temperature: enumAt(
        run.temperature,
        ["cold", "warm"] as const,
        "result.run.temperature",
      ),
    },
    project: stringAt(result.project, "result.project"),
    scenario: stringAt(result.scenario, "result.scenario"),
    environment: environmentAt(result.environment, "result.environment"),
    measurements: Object.fromEntries(
      Object.entries(measurements).map(([key, item]) => [
        key,
        jsonValueAt(item, `result.measurements.${key}`),
      ]),
    ),
  };
}

export function parsePerfResultJson(json: string): PerfResult {
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    throw new PerfResultValidationError(
      `result: invalid JSON (${error instanceof Error ? error.message : String(error)})`,
    );
  }
  return parsePerfResult(value);
}
