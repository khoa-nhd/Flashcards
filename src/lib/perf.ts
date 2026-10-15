/**
 * Dev-only interaction timing.
 *
 * The point is to measure what a reviewer actually waits for: the gap between
 * their input (a key press, a click, a typed answer) and the moment the
 * interface has answered it, and — separately — the round trip that used to be
 * in the way. Review and Practice both answer at once now, so the two numbers
 * can be compared with the old "wait for the server" behaviour.
 *
 * Only a fixed step name and a duration are ever kept, in memory and at most
 * 200 of them: never a word, an answer, an account or an id, and nothing is
 * sent anywhere. The recorder is exposed on `window.__flashcardsPerf` only
 * when the app is served from this computer. Browser code never reads the
 * environment (see tests/frontend-secrets.test.ts), so that is decided by the
 * address rather than by the build.
 */

export type PerfStep =
  /** Input to the next card being up, on the main thread. */
  | 'review.advance'
  /** The round trip that confirms one review answer. */
  | 'review.save'
  /** Input to the verdict being shown, judged locally. */
  | 'practice.verdict'
  /** The round trip that records one practice answer. */
  | 'practice.save';

export interface PerfSample {
  step: PerfStep;
  /** How long the step took, in milliseconds. */
  ms: number;
}

/** Older samples fall off the end; a long session must not grow without bound. */
const MAX_SAMPLES = 200;

const samples: PerfSample[] = [];

/** Records one timing. */
export function record(step: PerfStep, ms: number): void {
  if (samples.length >= MAX_SAMPLES) samples.shift();
  samples.push({ step, ms });
}

/**
 * Starts a timer. Call the returned function once the work it measures is
 * done; it records the elapsed time and returns it.
 */
export function startTiming(step: PerfStep): () => number {
  const startedAt = performance.now();
  return () => {
    const ms = performance.now() - startedAt;
    record(step, ms);
    return ms;
  };
}

/** Times a synchronous piece of work and returns its result. */
export function timed<T>(step: PerfStep, work: () => T): T {
  const done = startTiming(step);
  const result = work();
  done();
  return result;
}

/** The samples recorded so far, oldest first. */
export function perfSamples(): readonly PerfSample[] {
  return samples;
}

/** The average duration of a step, or null when it has not been measured. */
export function averageMs(step: PerfStep): number | null {
  const matching = samples.filter((sample) => sample.step === step);
  if (matching.length === 0) return null;
  return matching.reduce((total, sample) => total + sample.ms, 0) / matching.length;
}

/** Forgets every sample. */
export function clearPerf(): void {
  samples.length = 0;
}

declare global {
  interface Window {
    __flashcardsPerf?: {
      samples: typeof perfSamples;
      average: typeof averageMs;
      clear: typeof clearPerf;
    };
  }
}

// Handy for measuring by hand while developing; not offered on a deployed site.
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
if (typeof window !== 'undefined' && LOCAL_HOSTS.has(window.location.hostname)) {
  window.__flashcardsPerf = { samples: perfSamples, average: averageMs, clear: clearPerf };
}
