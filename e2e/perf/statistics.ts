export interface SampleStatistics {
  readonly count: number;
  readonly median: number;
  readonly p95: number;
  readonly max: number;
}

function sortedFiniteSamples(samples: readonly number[]): number[] {
  if (samples.length === 0) {
    throw new Error("at least one sample is required");
  }
  if (samples.some((sample) => !Number.isFinite(sample))) {
    throw new Error("samples must contain only finite numbers");
  }
  return [...samples].sort((left, right) => left - right);
}

/** Nearest-rank percentile: p95 is sorted[ceil(0.95 * n) - 1]. */
export function percentile(
  samples: readonly number[],
  percentileValue: number,
): number {
  if (
    !Number.isFinite(percentileValue) ||
    percentileValue <= 0 ||
    percentileValue > 1
  ) {
    throw new Error("percentile must be greater than 0 and at most 1");
  }
  const sorted = sortedFiniteSamples(samples);
  const index = Math.ceil(percentileValue * sorted.length) - 1;
  return sorted[index];
}

export function median(samples: readonly number[]): number {
  const sorted = sortedFiniteSamples(samples);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

export function summarizeSamples(samples: readonly number[]): SampleStatistics {
  const sorted = sortedFiniteSamples(samples);
  return {
    count: sorted.length,
    median: median(sorted),
    p95: percentile(sorted, 0.95),
    max: sorted[sorted.length - 1],
  };
}
