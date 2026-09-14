import { describe, expect, it } from 'vitest';
import type { ResearchObservation, SportsObservation } from '@marketsync/shared-types';
import { analyzeResearchObservations, parseResearchJsonl, providerBenchmarkMarkdown } from '../src';

const sessionId = 'benchmark-test';
const sports = (
  sourceId: string,
  id: string,
  sourceTimestampMs: number,
  receivedTimestampMs: number,
  options: Partial<SportsObservation> = {},
): ResearchObservation => {
  const observation: SportsObservation = {
    id: `${sourceId}:${id}`,
    sourceId,
    sourceLabel: sourceId,
    authority: 'licensed',
    capabilities: ['scoreboard', 'game_clock', 'play_by_play', 'wall_clock_timestamp'],
    providerEventId: id,
    revision: 0,
    correction: false,
    timestampQuality: 'provider',
    sourceTimestampMs,
    receivedTimestampMs,
    monotonicReceivedMs: receivedTimestampMs,
    state: {
      eventId: 'game',
      sport: 'basketball',
      sourceTimestampMs,
      period: 'Q4',
      clock: '0:10',
      clockDirection: 'down',
      homeScore: 100,
      awayScore: 99,
      status: 'live',
      discreteState: { event: 'shot', description: id },
    },
    rawSchemaVersion: 'test-v1',
    ...options,
  };
  return {
    id: `${sessionId}:${observation.id}:${observation.revision}`,
    sessionId,
    kind: 'sports',
    recordedAtMs: receivedTimestampMs,
    monotonicRecordedMs: receivedTimestampMs,
    observation,
  };
};

describe('provider benchmark analysis', () => {
  it('strictly parses bounded JSONL imports', () => {
    const item = sports('primary', 'p1', 1_000, 1_100);
    expect(parseResearchJsonl(JSON.stringify(item))).toEqual([item]);
    expect(() => parseResearchJsonl(`${JSON.stringify(item)}\n{bad}`)).toThrow('line 2');
    expect(() => parseResearchJsonl(`${JSON.stringify(item)}\n${JSON.stringify(item)}`, 1)).toThrow(
      'exceeds 1',
    );
  });

  it('separates timestamp quality and reports missing plays, corrections, and ordering', () => {
    const input: ResearchObservation[] = [
      sports('primary', 'p1', 1_000, 1_100),
      sports('backup', 'p1', 1_000, 1_500, { timestampQuality: 'receipt_approximation' }),
      sports('primary', 'p2', 2_000, 2_120),
      sports('backup', 'p3', 3_000, 3_300, { correction: true, revision: 1 }),
      sports('backup', 'older', 2_500, 3_400),
    ];
    const report = analyzeResearchObservations(input, 10_000);
    const primary = report.signals.find(
      (signal) => signal.sourceId === 'primary' && signal.signal === 'play_by_play',
    );
    const backup = report.signals.find(
      (signal) => signal.sourceId === 'backup' && signal.signal === 'play_by_play',
    );
    expect(primary?.providerLatency).toMatchObject({ samples: 2, medianMs: 100, p95Ms: 120 });
    expect(backup?.approximateTimestampCount).toBe(1);
    expect(backup?.providerLatency.samples).toBe(2);
    expect(backup?.correctionRate).toBeCloseTo(1 / 3);
    expect(backup?.outOfOrderRate).toBeCloseTo(1 / 3);
    expect(primary?.missingEventRate).toBeGreaterThan(0);
    expect(providerBenchmarkMarkdown(report)).toContain('primary | play_by_play');
  });
});
