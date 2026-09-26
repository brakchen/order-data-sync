export type PageLoadSample = {
  executeDurationMs: number;
  pageFetchDurationMs: number;
  responseReadDurationMs: number;
};

export type AdaptivePageLoadGuardOptions = {
  /** A page request at or above this duration is considered slow. */
  slowThresholdMs?: number;
  /** Number of consecutive slow samples required before adding a delay. */
  slowConsecutiveThreshold?: number;
  /** Number of consecutive fast samples required before removing a delay step. */
  fastConsecutiveThreshold?: number;
  /** Delay adjustment per slow/fast streak. */
  stepMs?: number;
  /** Upper bound for the adaptive delay. */
  maxDelayMs?: number;
};

const DEFAULTS = {
  slowThresholdMs: 4_000,
  slowConsecutiveThreshold: 2,
  fastConsecutiveThreshold: 4,
  stepMs: 250,
  maxDelayMs: 3_000,
} as const;

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 1 ? value : fallback;
}

function nonNegativeFinite(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/**
 * Small state machine used by the background sync admission path.
 *
 * It is deliberately observation-only: healthy pages return zero delay, and
 * a delay changes only after a sustained streak. This avoids turning one
 * slow TikTok response into a permanent throughput regression.
 */
export function createAdaptivePageLoadGuard(
  options: AdaptivePageLoadGuardOptions = {},
): {
  currentDelayMs: () => number;
  observe: (sample: PageLoadSample) => void;
} {
  const slowThresholdMs = nonNegativeFinite(options.slowThresholdMs, DEFAULTS.slowThresholdMs);
  const slowConsecutiveThreshold = positiveInteger(options.slowConsecutiveThreshold, DEFAULTS.slowConsecutiveThreshold);
  const fastConsecutiveThreshold = positiveInteger(options.fastConsecutiveThreshold, DEFAULTS.fastConsecutiveThreshold);
  const stepMs = nonNegativeFinite(options.stepMs, DEFAULTS.stepMs);
  const maxDelayMs = Math.max(stepMs, nonNegativeFinite(options.maxDelayMs, DEFAULTS.maxDelayMs));
  let delayMs = 0;
  let slowStreak = 0;
  let fastStreak = 0;

  return {
    currentDelayMs: () => delayMs,
    observe: (sample) => {
      const slow = Math.max(
        sample.executeDurationMs,
        sample.pageFetchDurationMs,
        sample.responseReadDurationMs,
      ) >= slowThresholdMs;
      if (slow) {
        slowStreak += 1;
        fastStreak = 0;
        if (slowStreak >= slowConsecutiveThreshold) {
          delayMs = Math.min(maxDelayMs, delayMs + stepMs);
          slowStreak = 0;
        }
        return;
      }

      fastStreak += 1;
      slowStreak = 0;
      if (fastStreak >= fastConsecutiveThreshold) {
        delayMs = Math.max(0, delayMs - stepMs);
        fastStreak = 0;
      }
    },
  };
}
