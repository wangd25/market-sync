import { describe, expect, it, vi } from 'vitest';
import {
  EspnPublicSportsAdapter,
  KalshiPublicRestAdapter,
  PolymarketLiveSession,
  PolymarketReadOnlyAdapter,
  parseMarketReference,
  reconnectDelayMs,
  scoreProviderQuality,
  weightedComposite,
} from '../src';
import type { WebSocketLike } from '../src';

class FakeWebSocket implements WebSocketLike {
  public readyState = 0;
  public onopen: ((event: Event) => void) | null = null;
  public onmessage: ((event: MessageEvent) => void) | null = null;
  public onerror: ((event: Event) => void) | null = null;
  public onclose: ((event: CloseEvent) => void) | null = null;
  public readonly sent: string[] = [];
  public send(data: string) {
    this.sent.push(data);
  }
  public close() {
    this.readyState = 3;
  }
  public open() {
    this.readyState = 1;
    this.onopen?.(new Event('open'));
  }
  public message(data: unknown) {
    this.onmessage?.(
      new MessageEvent('message', { data: typeof data === 'string' ? data : JSON.stringify(data) }),
    );
  }
}

describe('market reference parsing', () => {
  it('detects official provider URLs and rejects unrelated hosts', () => {
    expect(parseMarketReference('https://polymarket.com/event/world-cup-final')).toEqual({
      provider: 'polymarket',
      identifier: 'world-cup-final',
      kind: 'event',
    });
    expect(parseMarketReference('KXTEST-MARKET')).toEqual({
      provider: 'kalshi',
      identifier: 'KXTEST-MARKET',
      kind: 'market',
    });
    expect(() => parseMarketReference('https://example.com/market')).toThrow('Only official');
  });

  it('strips fragments from the reproduced MLB event URL', () => {
    expect(
      parseMarketReference('https://polymarket.com/event/mlb-pit-cle-2026-07-17#Iyh123E'),
    ).toEqual({
      provider: 'polymarket',
      identifier: 'mlb-pit-cle-2026-07-17',
      kind: 'event',
    });
  });
});

describe('Polymarket adapter recorded payloads', () => {
  it('validates and normalizes recorded public market messages', () => {
    const adapter = new PolymarketReadOnlyAdapter();
    const ticks = adapter.normalizeWebSocketPayload(
      {
        event_type: 'best_bid_ask',
        asset_id: 'asset',
        market: 'condition',
        timestamp: '1700000000000',
        best_bid: '0.61',
        best_ask: '0.63',
      },
      1_700_000_000_100,
      100,
    );
    expect(ticks[0]).toMatchObject({
      provider: 'polymarket',
      kind: 'best_bid_ask',
      bestBid: 0.61,
      bestAsk: 0.63,
    });
    expect(() =>
      adapter.normalizeWebSocketPayload({ event_type: 'best_bid_ask', asset_id: 4 }, 1, 1),
    ).toThrow();
  });

  it('normalizes bounded public history into timestamped market ticks', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(
        new Response(JSON.stringify({ history: [{ t: 1_700_000_000, p: 0.52 }] }), { status: 200 }),
      );
    const adapter = new PolymarketReadOnlyAdapter(fetcher);
    const ticks = await adapter.loadHistoryTicks(
      {
        provider: 'polymarket',
        providerMarketId: 'condition',
        eventId: 'event',
        title: 'History market',
        outcomes: [{ id: 'asset', assetId: 'asset', label: 'Yes' }],
        status: 'open',
      },
      'asset',
    );
    expect(ticks[0]).toMatchObject({
      sourceTimestampMs: 1_700_000_000_000,
      price: 0.52,
      providerMarketId: 'condition',
    });
  });

  it('refreshes a current public order book snapshot for the selected outcome', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          market: 'condition',
          asset_id: 'yes',
          timestamp: '1700000000123',
          bids: [
            { price: '0.61', size: '12' },
            { price: '0.62', size: '4' },
          ],
          asks: [
            { price: '0.65', size: '7' },
            { price: '0.64', size: '9' },
          ],
        }),
        { status: 200 },
      ),
    );
    const tick = await new PolymarketReadOnlyAdapter(fetcher).loadBookTick(
      'yes',
      1_700_000_000_200,
      50,
    );
    expect(tick).toMatchObject({
      providerMarketId: 'condition',
      outcomeId: 'yes',
      sourceTimestampMs: 1_700_000_000_123,
      bestBid: 0.62,
      bestAsk: 0.64,
      price: 0.63,
    });
  });

  it('runs market heartbeat, normalization, health, and cleanup deterministically', () => {
    vi.useFakeTimers();
    let now = 1_700_000_000_100;
    const sockets: FakeWebSocket[] = [];
    const received: unknown[] = [];
    const health: unknown[] = [];
    const session = new PolymarketLiveSession({
      assetIds: ['asset'],
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatMs: 1_000,
      now: () => now,
      monotonicNow: () => 100,
      callbacks: {
        onTicks: (ticks) => received.push(...ticks),
        onHealth: (value) => health.push(value),
      },
    });
    try {
      session.start();
      sockets[0]?.open();
      expect(sockets[0]?.sent[0]).toContain('"assets_ids":["asset"]');
      sockets[0]?.message({
        event_type: 'best_bid_ask',
        asset_id: 'asset',
        market: 'condition',
        timestamp: '1700000000000',
        best_bid: '0.51',
        best_ask: '0.53',
      });
      expect(received).toHaveLength(1);
      now += 9_000;
      vi.advanceTimersByTime(1_000);
      expect(sockets[0]?.sent).toContain('PING');
      sockets[0]?.message('PONG');
      expect(session.health()).toMatchObject({
        connected: true,
        lastDataAtMs: 1_700_000_000_100,
        dataGapMs: 9_000,
        heartbeatGapMs: 0,
      });
      expect(health.length).toBeGreaterThan(0);
    } finally {
      session.stop();
      vi.useRealTimers();
    }
    expect(sockets[0]?.readyState).toBe(3);
  });

  it('closes a market socket that misses the heartbeat deadline', () => {
    vi.useFakeTimers();
    let now = 1_700_000_000_000;
    const sockets: FakeWebSocket[] = [];
    const session = new PolymarketLiveSession({
      assetIds: ['asset'],
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      heartbeatMs: 1_000,
      staleAfterMs: 5_000,
      now: () => now,
      callbacks: { onTicks() {}, onHealth() {} },
    });
    try {
      session.start();
      sockets[0]?.open();
      now += 5_001;
      vi.advanceTimersByTime(1_000);
      expect(sockets[0]?.readyState).toBe(3);
    } finally {
      session.stop();
      vi.useRealTimers();
    }
  });

  it('responds to sports heartbeats and forwards only the selected delayed event state', () => {
    const sockets: FakeWebSocket[] = [];
    const states: unknown[] = [];
    const observations: unknown[] = [];
    const session = new PolymarketLiveSession({
      assetIds: ['asset'],
      eventSlug: 'mlb-pit-cle-2026-07-17',
      sportsPollMs: 0,
      now: () => 1_700_000_000_000,
      monotonicNow: () => 123,
      webSocketFactory: () => {
        const socket = new FakeWebSocket();
        sockets.push(socket);
        return socket;
      },
      callbacks: {
        onTicks() {},
        onHealth() {},
        onSportsState: (state) => states.push(state),
        onSportsObservation: (observation) => observations.push(observation),
      },
    });
    session.start();
    const sportsSocket = sockets[1];
    sportsSocket?.open();
    sportsSocket?.message('ping');
    expect(sportsSocket?.sent).toContain('pong');
    sportsSocket?.message({
      gameId: 17,
      leagueAbbreviation: 'mlb',
      slug: 'mlb-pit-cle-2026-07-17',
      status: 'InProgress',
      score: '3-2',
      period: 'Top 7',
      live: true,
      ended: false,
    });
    expect(states).toHaveLength(1);
    expect(observations).toHaveLength(1);
    expect(observations[0]).toMatchObject({
      sourceId: 'polymarket-sports',
      sourceLabel: 'Polymarket sports',
      authority: 'market_corroboration',
      timestampQuality: 'receipt_approximation',
      receivedTimestampMs: 1_700_000_000_000,
      monotonicReceivedMs: 123,
      state: {
        eventId: '17',
        period: 'Top 7',
        homeScore: 3,
        awayScore: 2,
      },
    });
    expect(observations[0]).not.toHaveProperty('state.slug');
    session.stop();
  });

  it('polls a validated scoreboard snapshot when the sports socket has not emitted one', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'nba-game',
          slug: 'nba-orl-bos-2026-07-18',
          title: 'Orlando Magic vs Boston Celtics',
          live: true,
          score: '81-79',
          period: 'Q3',
          elapsed: '4:12',
          updatedAt: '2026-07-18T20:00:00.000Z',
          markets: [],
        }),
        { status: 200 },
      ),
    );
    const states: unknown[] = [];
    const statuses: unknown[] = [];
    const session = new PolymarketLiveSession({
      assetIds: ['asset'],
      eventSlug: 'nba-orl-bos-2026-07-18',
      adapter: new PolymarketReadOnlyAdapter(fetcher),
      webSocketFactory: () => new FakeWebSocket(),
      sportsPollMs: 8_000,
      callbacks: {
        onTicks() {},
        onHealth() {},
        onSportsState: (state) => states.push(state),
        onSportsStatus: (status) => statuses.push(status),
      },
    });
    try {
      session.start();
      await vi.waitFor(() => expect(states).toHaveLength(1));
      expect(states[0]).toMatchObject({
        slug: 'nba-orl-bos-2026-07-18',
        period: 'Q3',
        homeScore: 81,
        awayScore: 79,
      });
      expect(statuses).toContain('polling');
    } finally {
      session.stop();
    }
  });

  it('creates credential-free public subscriptions and capped reconnect delays', () => {
    const adapter = new PolymarketReadOnlyAdapter();
    expect(JSON.parse(adapter.subscription(['asset']))).toEqual({
      assets_ids: ['asset'],
      type: 'market',
      custom_feature_enabled: true,
    });
    expect(reconnectDelayMs({ attempt: 20, random: () => 0.5 })).toBe(30_000);
  });

  it('resolves the reproduced MLB URL as an event with selectable contracts', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: 'game-17',
          slug: 'mlb-pit-cle-2026-07-17',
          title: 'Pittsburgh Pirates vs Cleveland Guardians',
          active: true,
          closed: false,
          eventStartTime: '2026-07-17T23:10:00Z',
          gameId: 'mlb-game-17',
          markets: [
            {
              id: 'moneyline',
              question: 'Pirates to win',
              slug: 'mlb-pit-cle-2026-07-17-pit',
              conditionId: 'condition-pit',
              clobTokenIds: '["pit-yes","pit-no"]',
              outcomes: '["Yes","No"]',
              active: true,
              closed: false,
            },
            {
              id: 'total',
              question: 'Game total over 8.5',
              slug: 'mlb-pit-cle-2026-07-17-total',
              conditionId: 'condition-total',
              clobTokenIds: '["over","under"]',
              outcomes: '["Over","Under"]',
              active: true,
              closed: false,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const adapter = new PolymarketReadOnlyAdapter(fetcher);
    const resolved = await adapter.resolveReference(
      parseMarketReference('https://polymarket.com/event/mlb-pit-cle-2026-07-17#Iyh123E'),
    );
    expect(resolved.kind).toBe('event');
    if (resolved.kind === 'event') expect(resolved.event.markets).toHaveLength(2);
    const request = fetcher.mock.calls[0]?.[0];
    const requestUrl =
      typeof request === 'string' ? request : request instanceof URL ? request.href : request?.url;
    expect(requestUrl).toContain('/events/slug/mlb-pit-cle-2026-07-17');
  });

  it('accepts the live France event shape and uses ordered teams and the explicit sport', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          id: '708596',
          slug: 'fifwc-fra-eng-2026-07-18',
          title: 'France vs. England',
          active: true,
          closed: false,
          sport: { id: 174, sport: 'fifwc' },
          gameId: 90087009,
          live: true,
          score: '3-4',
          period: '2H',
          elapsed: '77',
          updatedAt: '2026-07-18T22:40:19.201Z',
          teams: [
            { name: 'France', ordering: 'home' },
            { name: 'England', ordering: 'away' },
          ],
          tags: [
            { label: 'Sports', slug: 'sports' },
            { label: 'Soccer', slug: 'soccer' },
          ],
          markets: [
            {
              id: '2941971',
              question: 'Will France win?',
              slug: 'fifwc-fra-eng-2026-07-18-fra',
              conditionId: 'condition-france',
              clobTokenIds: '["fra-yes","fra-no"]',
              outcomes: '["Yes","No"]',
              outcomePrices: null,
              active: true,
              closed: false,
            },
          ],
        }),
        { status: 200 },
      ),
    );
    const event = await new PolymarketReadOnlyAdapter(fetcher).resolveEvent(
      'fifwc-fra-eng-2026-07-18',
    );
    expect(event).toMatchObject({
      sport: 'Soccer',
      initialSportsState: {
        homeTeam: 'France',
        awayTeam: 'England',
        clock: '77',
        clockDirection: 'up',
      },
    });
  });

  it('invokes the platform fetch with a browser-safe receiver', async () => {
    const originalFetch = globalThis.fetch;
    const receiverSensitiveFetch = vi.fn(function (this: unknown) {
      if (this !== globalThis) throw new TypeError("Failed to execute 'fetch': Illegal invocation");
      return Promise.resolve(
        new Response(
          JSON.stringify({
            id: 'market',
            question: 'Browser-safe market',
            slug: 'browser-safe-market',
            clobTokenIds: '["yes","no"]',
            outcomes: '["Yes","No"]',
          }),
          { status: 200 },
        ),
      );
    }) as unknown as typeof fetch;
    vi.stubGlobal('fetch', receiverSensitiveFetch);
    try {
      await expect(
        new PolymarketReadOnlyAdapter().resolve('browser-safe-market'),
      ).resolves.toMatchObject({
        title: 'Browser-safe market',
      });
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });
});

describe('ESPN public play-by-play adapter', () => {
  it('matches the game by date and teams, validates commentary, and deduplicates plays', async () => {
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            events: [
              {
                id: '760516',
                name: 'England at France',
                date: '2026-07-18T21:00:00Z',
                competitions: [
                  {
                    competitors: [
                      { homeAway: 'home', score: '3', team: { displayName: 'France' } },
                      { homeAway: 'away', score: '4', team: { displayName: 'England' } },
                    ],
                    status: {
                      clock: 4802,
                      displayClock: "80'",
                      period: 2,
                      type: { state: 'in', description: 'Second Half' },
                    },
                  },
                ],
              },
            ],
          }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            header: {
              competitions: [
                {
                  competitors: [
                    { homeAway: 'home', score: '3', team: { displayName: 'France' } },
                    { homeAway: 'away', score: '4', team: { displayName: 'England' } },
                  ],
                  status: {
                    clock: 4802,
                    displayClock: "80'",
                    period: 2,
                    type: { state: 'in', description: 'Second Half' },
                  },
                },
              ],
            },
            commentary: [
              {
                sequence: 97,
                text: 'Attempt saved.',
                play: {
                  id: '49868431',
                  text: 'Attempt saved by Mike Maignan.',
                  type: { text: 'Shot On Target', type: 'shot-on-target' },
                  period: { number: 2 },
                  clock: { value: 4792, displayValue: "80'" },
                  wallclock: '2026-07-18T22:42:56Z',
                  team: { displayName: 'England' },
                  homeScore: '3',
                  awayScore: '4',
                },
              },
              {
                sequence: 98,
                play: {
                  id: '49868431',
                  text: 'Duplicate description for the same play.',
                  wallclock: '2026-07-18T22:42:56Z',
                },
              },
              {
                sequence: 99,
                play: {
                  id: 'alternate-id-for-same-play',
                  text: 'Attempt saved by Mike Maignan.',
                  type: { text: 'Shot On Target', type: 'shot-on-target' },
                  period: { number: 2 },
                  clock: { value: 4792, displayValue: "80'" },
                  wallclock: '2026-07-18T22:42:57Z',
                  team: { displayName: 'England' },
                },
              },
            ],
          }),
          { status: 200 },
        ),
      );
    const receivedTimestampMs = Date.parse('2026-07-18T22:43:06Z');
    const feed = await new EspnPublicSportsAdapter(fetcher).loadLiveFeed(
      {
        sport: 'soccer',
        league: 'soccer-fifwc',
        startTimestampMs: Date.parse('2026-07-18T21:00:00Z'),
        homeTeam: 'France',
        awayTeam: 'England',
      },
      receivedTimestampMs,
    );
    expect(feed?.scoreboard).toMatchObject({
      sourceTimestampMs: receivedTimestampMs,
      status: 'live',
      period: '2H',
      clock: '80:02',
      clockDirection: 'up',
      homeScore: 3,
      awayScore: 4,
    });
    const states = feed?.plays ?? [];
    expect(states).toHaveLength(1);
    expect(states[0]).toMatchObject({
      eventId: '760516',
      sourceTimestampMs: Date.parse('2026-07-18T22:42:56Z'),
      period: '2H',
      clock: '79:52',
      clockDirection: 'up',
      homeScore: 3,
      awayScore: 4,
      discreteState: {
        event: 'shot-on-target',
        description: 'Attempt saved by Mike Maignan.',
        playId: '49868431',
      },
    });
  });
});

describe('Kalshi public REST recorded payloads', () => {
  it('validates a public market response without secrets', async () => {
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          market: {
            ticker: 'KXTEST-YES',
            event_ticker: 'KXTEST',
            title: 'Test market',
            status: 'open',
          },
        }),
        { status: 200 },
      ),
    );
    const adapter = new KalshiPublicRestAdapter(fetcher);
    await expect(adapter.resolve('KXTEST-YES')).resolves.toMatchObject({
      provider: 'kalshi',
      status: 'open',
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });
});

describe('provider quality and equivalence', () => {
  const health = {
    connected: true,
    reconnectCount: 0,
    outOfOrderCount: 0,
    invalidMessageCount: 0,
    source: 'live' as const,
  };
  it('produces a transparent bounded quality score', () => {
    const result = scoreProviderQuality({
      contractMatchConfidence: 0.9,
      ruleEquivalenceConfidence: 0.9,
      lastUpdateAgeMs: 1_000,
      spread: 0.02,
      availableDepth: 5_000,
      tradesPerMinute: 10,
      health,
      valueType: 'executable',
    });
    expect(result.score).toBeGreaterThan(70);
    expect(result.reasons).toContain('live source');
  });

  it('blocks consensus below the contract-equivalence threshold', () => {
    expect(
      weightedComposite([
        { price: 0.5, qualityScore: 80, ruleEquivalenceConfidence: 0.9 },
        { price: 0.7, qualityScore: 90, ruleEquivalenceConfidence: 0.8 },
      ]),
    ).toBeNull();
    expect(
      weightedComposite([
        { price: 0.5, qualityScore: 50, ruleEquivalenceConfidence: 0.9 },
        { price: 0.7, qualityScore: 50, ruleEquivalenceConfidence: 0.9 },
      ]),
    ).toBeCloseTo(0.6);
  });
});
