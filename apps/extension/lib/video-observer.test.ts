import { describe, expect, it } from 'vitest';
import { programDateTimeDelayMs } from './video-observer';

describe('program-date-time video synchronization', () => {
  it('derives end-to-end delay from media wall-clock time', () => {
    expect(
      programDateTimeDelayMs(
        {
          currentTime: 7.4,
          getStartDate: () => new Date('2026-07-19T20:14:20.000Z'),
        },
        Date.parse('2026-07-19T20:14:35.000Z'),
      ),
    ).toBe(7_600);
  });

  it('rejects invalid, future, and implausibly old media anchors', () => {
    const now = Date.parse('2026-07-19T20:14:35.000Z');
    expect(
      programDateTimeDelayMs(
        { currentTime: 20, getStartDate: () => new Date('2026-07-19T20:14:30.000Z') },
        now,
      ),
    ).toBeNull();
    expect(
      programDateTimeDelayMs(
        { currentTime: 0, getStartDate: () => new Date(now - 7 * 60 * 60 * 1_000) },
        now,
      ),
    ).toBeNull();
  });
});
