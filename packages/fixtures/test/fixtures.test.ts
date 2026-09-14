import { describe, expect, it } from 'vitest';
import { FIXTURE_BASE_TIMESTAMP_MS, fixtures } from '../src';

describe('long-running deterministic fixture replays', () => {
  it('keeps soccer odds and the visible clock moving through a normal session', () => {
    expect(fixtures.soccer.ticks.length).toBeGreaterThan(400);
    expect(fixtures.soccer.sportsStates.length).toBeGreaterThan(800);
    const start = fixtures.soccer.sportsStates[0];
    const tenMinutes = fixtures.soccer.sportsStates.find(
      (state) => state.sourceTimestampMs === FIXTURE_BASE_TIMESTAMP_MS + 600_000,
    );
    expect(start?.clock).toBe('66:19');
    expect(tenMinutes?.clock).toBe('76:19');
    expect(fixtures.soccer.ticks.at(-1)?.price).not.toBe(fixtures.soccer.ticks[0]?.price);
  });
});
