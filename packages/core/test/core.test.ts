import { describe, expect, it } from 'vitest';
import type { MarketTick, SyncAnchor } from '@marketsync/shared-types';
import {
  FakeClock,
  SyncEngine,
  TickBuffer,
  ViewerTimeline,
  findNextScoreChange,
  findNextBaseballRun,
  matchBaseballObservation,
  projectDelayedMarket,
  projectDelayedSportsState,
  projectDelayedSportsEvents,
  pruneHistory,
} from '../src';

const tick = (
  id: string,
  sourceTimestampMs: number,
  price = 0.5,
  extra: Partial<MarketTick> = {},
): MarketTick => ({
  id,
  provider: 'fixture',
  providerMarketId: 'market',
  outcomeId: 'yes',
  sourceTimestampMs,
  receivedTimestampMs: sourceTimestampMs + 10,
  monotonicReceivedMs: sourceTimestampMs,
  kind: 'trade',
  price,
  rawSchemaVersion: 'test-v1',
  ...extra,
});

describe('delayed sports projection', () => {
  it('never exposes a sports update ahead of viewer time and safely interpolates soccer', () => {
    const states = [
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 100_000,
        period: '2H',
        clock: '67:10',
        clockDirection: 'up' as const,
        homeScore: 1,
        awayScore: 0,
        status: 'live' as const,
      },
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 120_000,
        period: '2H',
        clock: '67:30',
        clockDirection: 'up' as const,
        homeScore: 2,
        awayScore: 0,
        status: 'live' as const,
      },
    ];
    const projection = projectDelayedSportsState(states, 105_000);
    expect(projection.state?.homeScore).toBe(1);
    expect(projection.displayClock).toBe('67:15');
    expect(projection.estimated).toBe(true);
  });

  it('shows minute-only soccer clocks to the second and merges sparse play states safely', () => {
    const states = [
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 100_000,
        period: '2H',
        clock: '77',
        clockDirection: 'up' as const,
        homeScore: 3,
        awayScore: 4,
        status: 'live' as const,
      },
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 105_000,
        period: '2H',
        clock: '77:05',
        clockDirection: 'up' as const,
        status: 'live' as const,
        discreteState: { event: 'foul', description: 'Free kick to France.' },
      },
    ];
    const projection = projectDelayedSportsState(states, 108_000);
    expect(projection.displayClock).toBe('77:08');
    expect(projection.state).toMatchObject({ homeScore: 3, awayScore: 4 });
    expect(projectDelayedSportsEvents(states, 108_000)[0]).toMatchObject({
      kind: 'play',
      title: 'Free kick to France.',
    });
  });

  it('builds game updates without exposing plays ahead of viewer time', () => {
    const states = [
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 100_000,
        period: '2H',
        clock: '67:10',
        homeScore: 1,
        awayScore: 0,
        status: 'live' as const,
      },
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 120_000,
        period: '2H',
        clock: '67:30',
        homeScore: 2,
        awayScore: 0,
        status: 'live' as const,
        discreteState: { event: 'goal' },
      },
    ];

    expect(projectDelayedSportsEvents(states, 119_999)).toHaveLength(1);
    const afterGoal = projectDelayedSportsEvents(states, 120_000, {
      homeLabel: 'Harbor City',
    });
    expect(afterGoal[0]).toMatchObject({
      kind: 'score',
      title: 'Goal',
      detail: 'Harbor City · 2 — 0',
      sourceTimestampMs: 120_000,
    });
  });

  it('keeps consecutive plays with the same provider event type when their play IDs differ', () => {
    const states = [
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 100_000,
        period: '2H',
        clock: '70:00',
        status: 'live' as const,
      },
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 101_000,
        period: '2H',
        clock: '70:01',
        status: 'live' as const,
        discreteState: { event: 'pass', playId: 'p1', description: 'Pass completed.' },
      },
      {
        eventId: 'match',
        sport: 'soccer',
        sourceTimestampMs: 102_000,
        period: '2H',
        clock: '70:02',
        status: 'live' as const,
        discreteState: { event: 'pass', playId: 'p2', description: 'Cross into the box.' },
      },
    ];

    const events = projectDelayedSportsEvents(states, 103_000);
    expect(events.filter((event) => event.kind === 'play').map((event) => event.title)).toEqual([
      'Cross into the box.',
      'Pass completed.',
    ]);
  });

  it('merges sparse play-by-play states before detecting confirmed score changes', () => {
    const states = [
      {
        eventId: 'game',
        sport: 'basketball',
        sourceTimestampMs: 100_000,
        period: 'Q4',
        clock: '0:20',
        homeScore: 98,
        awayScore: 98,
        status: 'live' as const,
      },
      {
        eventId: 'game',
        sport: 'basketball',
        sourceTimestampMs: 101_000,
        period: 'Q4',
        clock: '0:19',
        status: 'live' as const,
        discreteState: { event: 'turnover', playId: 'p1', description: 'Turnover.' },
      },
      {
        eventId: 'game',
        sport: 'basketball',
        sourceTimestampMs: 102_000,
        period: 'Q4',
        clock: '0:17',
        homeScore: 101,
        awayScore: 98,
        status: 'live' as const,
        discreteState: { event: 'three-point-shot', playId: 'p2', description: 'Three made.' },
      },
    ];

    expect(findNextScoreChange(states, 100_000, 'home')?.sourceTimestampMs).toBe(102_000);
    expect(findNextScoreChange(states, 100_000, 'away')).toBeNull();
    expect(projectDelayedSportsEvents(states, 102_000)[0]).toMatchObject({
      kind: 'score',
      title: 'Three made.',
      homeScore: 101,
      awayScore: 98,
    });
  });
});

describe('baseball event calibration', () => {
  const baseballStates = [
    {
      eventId: 'game',
      sport: 'baseball',
      sourceTimestampMs: 100_000,
      period: 'Top 7',
      homeScore: 2,
      awayScore: 2,
      status: 'live' as const,
      discreteState: { inning: 7, half: 'top', outs: 1, count: '1-1', sequence: 10 },
    },
    {
      eventId: 'game',
      sport: 'baseball',
      sourceTimestampMs: 110_000,
      period: 'Top 7',
      homeScore: 3,
      awayScore: 2,
      status: 'live' as const,
      discreteState: { inning: 7, half: 'top', outs: 1, count: '0-0', sequence: 11 },
    },
    {
      eventId: 'game',
      sport: 'baseball',
      sourceTimestampMs: 120_000,
      period: 'Top 7',
      homeScore: 3,
      awayScore: 2,
      status: 'live' as const,
      discreteState: { inning: 7, half: 'top', outs: 2, count: '0-0', sequence: 12 },
    },
  ];

  it('matches a unique score-changing play and computes the broadcast delay', () => {
    const result = matchBaseballObservation(
      baseballStates,
      {
        inning: 7,
        half: 'top',
        homeScore: 3,
        awayScore: 2,
        outs: 1,
        count: '0-0',
        moment: 'run',
      },
      135_000,
    );
    expect(result.kind).toBe('matched');
    if (result.kind === 'matched') expect(result.estimatedDelayMs).toBe(25_000);
  });

  it('finds the first team-specific run after alignment is armed', () => {
    expect(findNextBaseballRun(baseballStates, 100_000, 'home')?.sourceTimestampMs).toBe(110_000);
    expect(findNextBaseballRun(baseballStates, 100_000, 'away')).toBeNull();
  });
});

describe('piecewise viewer timeline', () => {
  it('applies a fixed delay and delay adjustment', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock, { initialDelayMs: 20_000 });
    expect(timeline.virtualNowMs()).toBe(80_000);
    clock.advanceBy(5_000);
    expect(timeline.virtualNowMs()).toBe(85_000);
    timeline.setEstimatedDelay(30_000);
    expect(timeline.virtualNowMs()).toBe(75_000);
  });

  it('pauses and resumes without jumping', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock, { initialDelayMs: 10_000 });
    clock.advanceBy(1_000);
    timeline.pause();
    const pausedAt = timeline.virtualNowMs();
    clock.advanceBy(15_000);
    expect(timeline.virtualNowMs()).toBe(pausedAt);
    timeline.resume();
    clock.advanceBy(500);
    expect(timeline.virtualNowMs()).toBe(pausedAt + 500);
  });

  it('freezes during buffering and reduces confidence', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock);
    timeline.pause('buffering');
    timeline.reduceConfidence(0.1, 'buffering');
    clock.advanceBy(2_000);
    expect(timeline.snapshot().confidence).toBeCloseTo(0.82);
    expect(timeline.virtualNowMs()).toBe(80_000);
  });

  it('supports backward and forward seeks', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock, { initialDelayMs: 20_000 });
    timeline.seekBy(-5_000);
    expect(timeline.virtualNowMs()).toBe(75_000);
    timeline.seekBy(8_000);
    expect(timeline.virtualNowMs()).toBe(83_000);
  });

  it('changes playback rate while preserving continuity', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock, { initialDelayMs: 20_000 });
    timeline.setPlaybackRate(2);
    clock.advanceBy(1_500);
    expect(timeline.virtualNowMs()).toBe(83_000);
  });

  it('tracks effective delay through pauses and never seeks beyond wall-clock live', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock, { initialDelayMs: 10_000 });
    timeline.pause();
    clock.advanceBy(5_000);
    expect(timeline.snapshot().estimatedDelayMs).toBe(15_000);
    timeline.resume();
    timeline.seekBy(30_000);
    expect(timeline.virtualNowMs()).toBe(clock.wallNowMs());
    expect(timeline.snapshot().estimatedDelayMs).toBe(0);
  });

  it('rejects negative, impossible, and invalid playback values', () => {
    const timeline = new ViewerTimeline(new FakeClock());
    expect(() => timeline.setEstimatedDelay(-1)).toThrow(RangeError);
    expect(() => timeline.setEstimatedDelay(99_000_000)).toThrow(RangeError);
    expect(() => timeline.setPlaybackRate(0)).toThrow(RangeError);
  });

  it('reduces confidence for contradictory anchors and enters uncertain mode', () => {
    const clock = new FakeClock(100_000);
    const timeline = new ViewerTimeline(clock, { initialDelayMs: 20_000, initialConfidence: 0.6 });
    const anchor: SyncAnchor = {
      id: 'contradiction',
      type: 'guided_clock_tap',
      realTimestampMs: 100_000,
      viewerTimestampMs: 10_000,
      estimatedDelayMs: 90_000,
      confidence: 0.9,
      metadata: {},
    };
    timeline.addAnchor(anchor);
    expect(timeline.snapshot().confidence).toBeLessThan(0.35);
    expect(timeline.snapshot().mode).toBe('uncertain');
  });
});

describe('ordered bounded tick buffer', () => {
  it('orders out-of-order ticks and deduplicates repeated IDs', () => {
    const buffer = new TickBuffer();
    buffer.insert(tick('later', 20));
    expect(buffer.insert(tick('earlier', 10)).outOfOrder).toBe(true);
    expect(buffer.insert(tick('later', 20)).duplicate).toBe(true);
    expect(buffer.all().map((item) => item.id)).toEqual(['earlier', 'later']);
  });

  it('prunes by retention and maximum item count', () => {
    const buffer = new TickBuffer({ retentionMs: 20, maxItems: 2 });
    buffer.insert(tick('a', 10, 0.1, { receivedTimestampMs: 10 }));
    buffer.insert(tick('b', 20, 0.2, { receivedTimestampMs: 20 }));
    buffer.insert(tick('c', 40, 0.3, { receivedTimestampMs: 40 }));
    expect(buffer.all().map((item) => item.id)).toEqual(['b', 'c']);
  });

  it('prunes persisted-style history deterministically', () => {
    const records = [
      { id: 'old', receivedTimestampMs: 10 },
      { id: 'a', receivedTimestampMs: 90 },
      { id: 'b', receivedTimestampMs: 95 },
      { id: 'c', receivedTimestampMs: 100 },
    ];
    expect(pruneHistory(records, 100, 20, 2).map((item) => item.id)).toEqual(['b', 'c']);
  });
});

describe('no-spoiler projection', () => {
  it('cannot leak a future tick through any projected UI field', () => {
    const past = tick('past', 100, 0.42, {
      bestBid: 0.41,
      bestAsk: 0.43,
      volume: 100,
      status: 'open',
    });
    const future = tick('future', 200, 0.99, {
      bestBid: 0.98,
      bestAsk: 1,
      volume: 999_999,
      status: 'halted',
    });
    const result = projectDelayedMarket([past, future], 150, {
      confidence: 1,
      strictAntiSpoiler: true,
    });
    expect(result.currentPrice).toBe(0.42);
    expect(result.bestBid).toBe(0.41);
    expect(result.bestAsk).toBe(0.43);
    expect(result.volume).toBe(100);
    expect(result.status).toBe('open');
    expect(result.priceDirection).toBe('flat');
    expect(result.chartPoints).toHaveLength(1);
    expect(result.notifications).toEqual([]);
    expect(result.relatedMarkets).toEqual([]);
    expect(result.providerComparison).toEqual([]);
    expect(result.consensusPrice).toBeNull();
    expect(result.queuedFutureTickCount).toBe(1);
  });

  it('strict mode freezes the complete prior safe projection below threshold', () => {
    const safe = projectDelayedMarket([tick('a', 100, 0.4)], 100, {
      confidence: 1,
      strictAntiSpoiler: true,
    });
    const frozen = projectDelayedMarket([tick('a', 100, 0.4), tick('b', 200, 0.9)], 200, {
      confidence: 0.2,
      strictAntiSpoiler: true,
      previousSafeProjection: safe,
    });
    expect(frozen.frozen).toBe(true);
    expect(frozen.currentPrice).toBe(0.4);
    expect(frozen.chartPoints).toHaveLength(1);
  });

  it('projects both outcomes through the same viewer cutoff', () => {
    const result = projectDelayedMarket(
      [
        tick('yes-past', 100, 0.61, { outcomeId: 'yes' }),
        tick('no-past', 100, 0.39, { outcomeId: 'no' }),
        tick('yes-future', 200, 0.9, { outcomeId: 'yes' }),
        tick('no-future', 200, 0.1, { outcomeId: 'no' }),
      ],
      150,
      { confidence: 1, strictAntiSpoiler: true },
    );
    expect(result.outcomes).toHaveLength(2);
    expect(result.outcomes.find((outcome) => outcome.outcomeId === 'yes')?.currentPrice).toBe(0.61);
    expect(result.outcomes.find((outcome) => outcome.outcomeId === 'no')?.currentPrice).toBe(0.39);
    expect(result.queuedFutureTickCount).toBe(2);
  });

  it('classifies a rapid one-point move as a momentum surge without reading future ticks', () => {
    const result = projectDelayedMarket(
      [
        tick('baseline', 100_000, 0.5),
        tick('fast-move', 100_800, 0.512),
        tick('future', 101_000, 0.7),
      ],
      100_900,
      { confidence: 1, strictAntiSpoiler: true },
    );
    expect(result.outcomes[0]?.momentum).toMatchObject({
      direction: 'up',
      intensity: 'surge',
      windowMs: 800,
      lastChangedAtMs: 100_800,
    });
    expect(result.outcomes[0]?.momentum.fastChange).toBeCloseTo(0.012);
    expect(result.currentPrice).toBe(0.512);
  });
});

describe('engine integration', () => {
  it('reveals a tick exactly after the configured 20-second delay', () => {
    const clock = new FakeClock(100_000);
    const engine = new SyncEngine(clock, { initialDelayMs: 20_000 });
    engine.ingest(tick('reaction', 100_000, 0.8));
    expect(engine.projection().currentPrice).toBeNull();
    clock.advanceBy(19_999);
    expect(engine.projection().currentPrice).toBeNull();
    clock.advanceBy(1);
    expect(engine.projection().currentPrice).toBe(0.8);
  });

  it('tracks reconnect health and reduces confidence', () => {
    const engine = new SyncEngine(new FakeClock());
    const before = engine.timeline.snapshot().confidence;
    engine.reconnect();
    expect(engine.health().connected).toBe(false);
    expect(engine.health().reconnectCount).toBe(1);
    expect(engine.timeline.snapshot().confidence).toBeLessThan(before);
    engine.markConnected();
    expect(engine.health().connected).toBe(true);
  });
});
