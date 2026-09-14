import { describe, expect, it } from 'vitest';
import { createPendingVideoAnchor, planConfirmedVideoAnchor } from '../src/sync-control';

describe('confirmed synchronization candidates', () => {
  it('retains a candidate without changing timing and creates an explicit application plan', () => {
    const candidate = createPendingVideoAnchor(14_000, 0.95, 100_000);
    expect(candidate).toMatchObject({ delayMs: 14_000, confidence: 0.95 });
    expect(planConfirmedVideoAnchor(candidate, 101_000, 20_000)).toEqual({
      viewerTimestampMs: 87_000,
      rawDelayMs: 14_000,
      confidence: 0.95,
      previousDelayMs: 20_000,
      method: 'program-date-time',
    });
  });

  it('rejects impossible candidate values', () => {
    expect(() => createPendingVideoAnchor(-1, 0.9, 0)).toThrow('six-hour');
    expect(() => createPendingVideoAnchor(1_000, 2, 0)).toThrow('between 0 and 1');
  });
});
