import type { MonotonicMs, WallClockMs } from '@marketsync/shared-types';

export interface Clock {
  wallNowMs(): WallClockMs;
  monotonicNowMs(): MonotonicMs;
}

export const systemClock: Clock = {
  wallNowMs: () => Date.now(),
  monotonicNowMs: () => performance.now(),
};

export class FakeClock implements Clock {
  public constructor(
    private wallMs: WallClockMs = 1_700_000_000_000,
    private monotonicMs: MonotonicMs = 0,
  ) {}

  public wallNowMs(): WallClockMs {
    return this.wallMs;
  }

  public monotonicNowMs(): MonotonicMs {
    return this.monotonicMs;
  }

  public advanceBy(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new RangeError('Clock advance must be non-negative');
    this.wallMs += ms;
    this.monotonicMs += ms;
  }

  public setWallMs(ms: WallClockMs): void {
    this.wallMs = ms;
  }
}
