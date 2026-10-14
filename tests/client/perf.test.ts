import { beforeEach, describe, expect, it } from 'vitest';
import { averageMs, clearPerf, perfSamples, record, startTiming, timed } from '../../src/lib/perf.js';

describe('interaction timing', () => {
  beforeEach(() => clearPerf());

  it('records a step and how long it took', () => {
    const done = startTiming('review.save');
    const ms = done();
    expect(ms).toBeGreaterThanOrEqual(0);
    expect(perfSamples()).toHaveLength(1);
    expect(perfSamples()[0]).toMatchObject({ step: 'review.save' });
  });

  it('times synchronous work and returns its result', () => {
    const result = timed('practice.verdict', () => 42);
    expect(result).toBe(42);
    expect(averageMs('practice.verdict')).not.toBeNull();
  });

  it('keeps each step separate', () => {
    record('review.advance', 1);
    record('review.save', 5);
    expect(averageMs('review.advance')).toBe(1);
    expect(averageMs('review.save')).toBe(5);
    expect(averageMs('practice.save')).toBeNull();
  });

  it('keeps only the most recent samples, so a long session cannot grow without bound', () => {
    for (let index = 0; index < 250; index += 1) record('review.save', index);
    expect(perfSamples().length).toBeLessThanOrEqual(200);
    expect(perfSamples().at(-1)).toMatchObject({ ms: 249 });
  });

  it('records nothing that is not a fixed step name and a duration', () => {
    const done = startTiming('review.advance');
    done();
    expect(Object.keys(perfSamples()[0] ?? {}).sort()).toEqual(['ms', 'step']);
  });
});
