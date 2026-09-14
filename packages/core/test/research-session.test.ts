import { describe, expect, it } from 'vitest';
import type { MarketTick, ResearchObservation, SportsObservation } from '@marketsync/shared-types';
import { ResearchSessionRecorder } from '../src';

const sessionId = 'research-test';

const marketTick = (id: string, sourceTimestampMs: number, latencyMs: number): MarketTick => ({
  id,
  provider: 'fixture',
  providerMarketId: 'market',
  outcomeId: 'yes',
  sourceTimestampMs,
  receivedTimestampMs: sourceTimestampMs + latencyMs,
  monotonicReceivedMs: sourceTimestampMs,
  kind: 'trade',
  price: 0.55,
  rawSchemaVersion: 'test-v1',
});

const sportsObservation = (
  id: string,
  sourceTimestampMs: number,
  latencyMs: number,
  timestampQuality: SportsObservation['timestampQuality'] = 'provider',
): SportsObservation => ({
  id,
  sourceId: 'licensed-feed',
  sourceLabel: 'Licensed feed',
  authority: 'licensed',
  capabilities: ['scoreboard', 'play_by_play', 'wall_clock_timestamp'],
  providerEventId: id,
  revision: 0,
  correction: false,
  timestampQuality,
  sourceTimestampMs,
  receivedTimestampMs: sourceTimestampMs + latencyMs,
  monotonicReceivedMs: sourceTimestampMs,
  state: {
    eventId: 'game',
    sport: 'basketball',
    sourceTimestampMs,
    period: 'Q4',
    clock: '0:12',
    homeScore: 101,
    awayScore: 99,
    status: 'live',
    discreteState: {
      event: 'three-point-shot',
      description: 'Three-pointer made.',
      playId: id,
      providerInternalToken: 'must-not-export',
    },
  },
  rawSchemaVersion: 'test-v1',
});

const research = (
  id: string,
  recordedAtMs: number,
  observation: MarketTick | SportsObservation,
): ResearchObservation =>
  'providerMarketId' in observation
    ? {
        id,
        sessionId,
        kind: 'market',
        recordedAtMs,
        monotonicRecordedMs: recordedAtMs,
        tick: observation,
      }
    : {
        id,
        sessionId,
        kind: 'sports',
        recordedAtMs,
        monotonicRecordedMs: recordedAtMs,
        observation,
      };

describe('research session recorder', () => {
  it('is bounded, rejects duplicates, and validates external observations at runtime', () => {
    const recorder = new ResearchSessionRecorder({ sessionId, maxItems: 2 });
    expect(recorder.record(research('one', 1_100, marketTick('m1', 1_000, 100)))).toBe(true);
    expect(recorder.record(research('one', 1_100, marketTick('m1', 1_000, 100)))).toBe(false);
    recorder.record(research('two', 2_100, marketTick('m2', 2_000, 100)));
    recorder.record(research('three', 3_100, marketTick('m3', 3_000, 100)));
    expect(recorder.all().map((item) => item.id)).toEqual(['two', 'three']);
    expect(() =>
      recorder.record({
        ...research('invalid', 4_000, marketTick('m4', 4_000, 0)),
        secret: 'x',
      } as never),
    ).toThrow();
  });

  it('keeps latency domains separate and hides future observations from viewer summaries', () => {
    const recorder = new ResearchSessionRecorder({ sessionId });
    recorder.record(research('market-1', 1_200, marketTick('m1', 1_000, 200)));
    recorder.record(research('sports-1', 2_300, sportsObservation('s1', 2_000, 300)));
    recorder.record(
      research(
        'sports-approx',
        3_700,
        sportsObservation('s2', 3_000, 700, 'receipt_approximation'),
      ),
    );
    recorder.record({
      id: 'anchor-1',
      sessionId,
      kind: 'anchor',
      recordedAtMs: 4_000,
      monotonicRecordedMs: 4_000,
      anchorType: 'event_tap',
      viewerTimestampMs: 3_500,
      estimatedDelayMs: 20_000,
      confidence: 0.9,
      method: 'next-score',
    });
    recorder.record({
      id: 'anchor-2',
      sessionId,
      kind: 'anchor',
      recordedAtMs: 5_000,
      monotonicRecordedMs: 5_000,
      anchorType: 'event_tap',
      viewerTimestampMs: 4_500,
      estimatedDelayMs: 22_000,
      confidence: 0.9,
      method: 'next-score',
    });

    const visible = recorder.summary(3_500);
    expect(visible.observationCount).toBe(4);
    expect(visible.marketTransportLatency.medianMs).toBe(200);
    expect(visible.sportsProviderLatency.medianMs).toBe(300);
    expect(visible.approximateSportsLatencySamples).toBe(1);
    expect(visible.viewerBroadcastDelay.medianMs).toBe(20_000);
    expect(visible.currentDriftMs).toBe(0);

    const full = recorder.summary();
    expect(full.viewerBroadcastDelay.medianMs).toBe(20_000);
    expect(full.currentDriftMs).toBe(2_000);
  });

  it('exports only normalized allowlisted sports fields', () => {
    const recorder = new ResearchSessionRecorder({ sessionId });
    recorder.record(research('sports-1', 2_300, sportsObservation('s1', 2_000, 300)));
    const output = recorder.exportJsonl();
    expect(output).toContain('Three-pointer made.');
    expect(output).not.toContain('providerInternalToken');
    expect(output).not.toContain('must-not-export');
    expect(JSON.parse(output)).not.toHaveProperty('observation.rawPayload');
  });
});
