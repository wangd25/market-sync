import type { MarketMetadata, MarketTick, SportsState } from '@marketsync/shared-types';

export type FixtureSport = 'soccer' | 'basketball' | 'tennis' | 'baseball';

export interface SimulationFixture {
  id: FixtureSport;
  metadata: MarketMetadata;
  sportsStates: readonly SportsState[];
  ticks: readonly MarketTick[];
  eventTimestampMs: number;
}

export const FIXTURE_BASE_TIMESTAMP_MS = 1_700_000_000_000;

const buildTicks = (sport: FixtureSport, eventOffsetMs: number): MarketTick[] =>
  Array.from({ length: 451 }, (_, index) => {
    const offsetMs = index * 2_000;
    const eventLift = offsetMs >= eventOffsetMs ? 0.11 : 0;
    const price = Math.max(
      0.05,
      Math.min(0.95, 0.42 + index * 0.00035 + Math.sin(index / 7) * 0.025 + eventLift),
    );
    const sourceTimestampMs = FIXTURE_BASE_TIMESTAMP_MS + offsetMs;
    return {
      id: `${sport}-tick-${index}`,
      provider: 'fixture',
      providerMarketId: `${sport}-market`,
      outcomeId: 'home',
      sourceTimestampMs,
      receivedTimestampMs: sourceTimestampMs + (index === 8 ? 1_500 : 100),
      monotonicReceivedMs: index * 5_000 + 100,
      kind: index % 3 === 0 ? 'trade' : 'best_bid_ask',
      price,
      bestBid: Math.max(0, price - 0.01),
      bestAsk: Math.min(1, price + 0.01),
      volume: 1_000 + index * 125,
      sequence: index,
      status: 'open',
      rawSchemaVersion: 'fixture-v1',
      ...(Math.abs(offsetMs - eventOffsetMs) < 2_000 ? { kind: 'trade' as const } : {}),
    };
  });

const metadata = (sport: FixtureSport, title: string): MarketMetadata => ({
  provider: 'fixture',
  providerMarketId: `${sport}-market`,
  eventId: `${sport}-event`,
  title,
  outcomes: [
    { id: 'home', label: title.includes('wins') ? title : 'Home' },
    { id: 'away', label: 'Opponent' },
  ],
  status: 'open',
});

const state = (
  sport: FixtureSport,
  offsetMs: number,
  fields: Omit<SportsState, 'eventId' | 'sport' | 'sourceTimestampMs'>,
): SportsState => ({
  eventId: `${sport}-event`,
  sport,
  sourceTimestampMs: FIXTURE_BASE_TIMESTAMP_MS + offsetMs,
  ...fields,
});

const formatClock = (seconds: number): string =>
  `${Math.floor(Math.max(0, seconds) / 60)}:${String(Math.max(0, seconds) % 60).padStart(2, '0')}`;

const buildSoccerStates = (): SportsState[] =>
  Array.from({ length: 901 }, (_, second) =>
    state('soccer', second * 1_000, {
      period: '2nd half',
      clock: formatClock(66 * 60 + 19 + second),
      clockDirection: 'up',
      homeScore: second >= 55 ? 2 : 1,
      awayScore: 0,
      status: 'live',
      ...(second === 55 ? { discreteState: { event: 'goal', sequence: 1 } } : {}),
    }),
  );

const buildBasketballStates = (): SportsState[] =>
  Array.from({ length: 131 }, (_, second) =>
    state('basketball', second * 1_000, {
      period: second > 125 ? 'Final' : 'Q4',
      clock: formatClock(130 - second),
      clockDirection: 'down',
      homeScore: second >= 50 ? 94 : 92,
      awayScore: 91,
      status: second > 125 ? 'complete' : 'live',
      discreteState: {
        possession: second % 20 < 10 ? 'away' : 'home',
        sequence: 40 + second,
        ...(second === 50
          ? {
              event: 'dunk',
              description: 'Hugo Gonzalez slams an emphatic dunk',
            }
          : {}),
      },
    }),
  );

const buildTennisStates = (): SportsState[] =>
  Array.from({ length: 181 }, (_, index) =>
    state('tennis', index * 5_000, {
      period: 'Set 3',
      homeScore: index >= 24 ? 2 : 1,
      awayScore: 1,
      status: index >= 24 ? 'complete' : 'live',
      discreteState: {
        set: 3,
        game: 8 + Math.floor(index / 4),
        point: ['0-0', '15-0', '30-0', '40-0'][index % 4] ?? '0-0',
        sequence: 87 + index,
      },
    }),
  );

const buildBaseballStates = (): SportsState[] =>
  Array.from({ length: 181 }, (_, index) =>
    state('baseball', index * 5_000, {
      period: index >= 72 ? 'Bot 8' : 'Top 8',
      homeScore: 3,
      awayScore: index >= 8 ? 4 : 3,
      status: 'live',
      discreteState: {
        inning: 8,
        half: index >= 72 ? 'bottom' : 'top',
        outs: Math.floor(index / 3) % 3,
        count: ['0-0', '1-0', '1-1', '1-2'][index % 4] ?? '0-0',
        ...(index === 8 ? { event: 'home_run' } : {}),
        sequence: 122 + index,
      },
    }),
  );

export const fixtures: Record<FixtureSport, SimulationFixture> = {
  soccer: {
    id: 'soccer',
    metadata: metadata('soccer', 'Harbor City wins'),
    eventTimestampMs: FIXTURE_BASE_TIMESTAMP_MS + 55_000,
    ticks: buildTicks('soccer', 55_000),
    sportsStates: buildSoccerStates(),
  },
  basketball: {
    id: 'basketball',
    metadata: metadata('basketball', 'Metro Owls win'),
    eventTimestampMs: FIXTURE_BASE_TIMESTAMP_MS + 50_000,
    ticks: buildTicks('basketball', 50_000),
    sportsStates: buildBasketballStates(),
  },
  tennis: {
    id: 'tennis',
    metadata: metadata('tennis', 'Rivera wins'),
    eventTimestampMs: FIXTURE_BASE_TIMESTAMP_MS + 45_000,
    ticks: buildTicks('tennis', 45_000),
    sportsStates: buildTennisStates(),
  },
  baseball: {
    id: 'baseball',
    metadata: metadata('baseball', 'Harbor Hawks win'),
    eventTimestampMs: FIXTURE_BASE_TIMESTAMP_MS + 40_000,
    ticks: buildTicks('baseball', 40_000),
    sportsStates: buildBaseballStates(),
  },
};

export const fixtureList = Object.values(fixtures);

export interface FixtureStreamOptions {
  outOfOrder?: boolean;
  duplicate?: boolean;
}

export const fixtureStream = (
  fixture: SimulationFixture,
  options: FixtureStreamOptions = {},
): readonly MarketTick[] => {
  const ticks = [...fixture.ticks];
  if (options.outOfOrder && ticks.length > 4) {
    const displaced = ticks.splice(3, 1)[0];
    if (displaced !== undefined) ticks.splice(6, 0, displaced);
  }
  if (options.duplicate && ticks[2] !== undefined) ticks.splice(5, 0, ticks[2]);
  return ticks;
};
