import type { MarketMetadata, MarketTick, SportsState } from '@marketsync/shared-types';
import { z } from 'zod';
import { POLYMARKET_ENDPOINTS } from './endpoints';
import { ProviderError, classifyProviderError } from './errors';
import { browserSafeFetch, type Fetcher } from './fetcher';
import type { ParsedMarketReference } from './parse-market';

const stringOrNumber = z.union([z.string(), z.number()]).transform(String);
const optionalNumber = z
  .union([z.string(), z.number()])
  .nullable()
  .optional()
  .transform((value) => (value === undefined || value === null ? undefined : Number(value)));

const gammaMarketSchema = z.object({
  id: stringOrNumber,
  question: z.string(),
  slug: z.string().nullable().optional(),
  conditionId: z.string().nullable().optional(),
  clobTokenIds: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  outcomes: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  outcomePrices: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional(),
  closed: z.boolean().optional(),
  active: z.boolean().optional(),
  acceptingOrders: z.boolean().optional(),
  bestBid: optionalNumber,
  bestAsk: optionalNumber,
  lastTradePrice: optionalNumber,
  sportsMarketType: z.string().nullable().optional(),
  gameId: stringOrNumber.nullable().optional(),
  eventStartTime: z.string().nullable().optional(),
  gameStartTime: z.string().nullable().optional(),
  groupItemTitle: z.string().nullable().optional(),
});

const gammaEventSchema = z.object({
  id: stringOrNumber,
  slug: z.string(),
  title: z.string(),
  subtitle: z.string().nullable().optional(),
  active: z.boolean().optional(),
  closed: z.boolean().optional(),
  archived: z.boolean().optional(),
  startDate: z.string().nullable().optional(),
  endDate: z.string().nullable().optional(),
  eventStartTime: z.string().nullable().optional(),
  gameId: stringOrNumber.nullable().optional(),
  live: z.boolean().nullable().optional(),
  ended: z.boolean().nullable().optional(),
  score: z.string().nullable().optional(),
  period: z.string().nullable().optional(),
  elapsed: z.string().nullable().optional(),
  status: z.string().nullable().optional(),
  updatedAt: z.string().nullable().optional(),
  homeTeam: z.string().nullable().optional(),
  awayTeam: z.string().nullable().optional(),
  sport: z
    .union([z.string(), z.object({ sport: z.string() })])
    .nullable()
    .optional(),
  volume: optionalNumber,
  liquidity: optionalNumber,
  markets: z.array(gammaMarketSchema).default([]),
  series: z
    .array(
      z.object({
        title: z.string().nullable().optional(),
        ticker: z.string().nullable().optional(),
        slug: z.string().nullable().optional(),
      }),
    )
    .optional(),
  tags: z
    .array(
      z.object({ label: z.string().nullable().optional(), slug: z.string().nullable().optional() }),
    )
    .optional(),
  teams: z
    .array(
      z.object({
        name: z.string(),
        ordering: z.enum(['home', 'away']).nullable().optional(),
      }),
    )
    .optional(),
});

const websocketBookSchema = z.object({
  event_type: z.literal('book'),
  asset_id: z.string(),
  market: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]),
  bids: z.array(z.object({ price: z.string(), size: z.string() })).optional(),
  asks: z.array(z.object({ price: z.string(), size: z.string() })).optional(),
});

const websocketPriceSchema = z.object({
  event_type: z.enum(['last_trade_price', 'best_bid_ask']),
  asset_id: z.string(),
  market: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]),
  price: z.string().optional(),
  best_bid: z.string().optional(),
  best_ask: z.string().optional(),
});

const websocketPriceChangeSchema = z.object({
  event_type: z.literal('price_change'),
  market: z.string().optional(),
  timestamp: z.union([z.string(), z.number()]),
  price_changes: z.array(
    z.object({
      asset_id: z.string(),
      price: z.string().optional(),
      best_bid: z.string().optional(),
      best_ask: z.string().optional(),
    }),
  ),
});

const historySchema = z.object({
  history: z.array(
    z.object({
      t: z.number().nonnegative(),
      p: z.number().min(0).max(1),
    }),
  ),
});

const restBookSchema = z.object({
  market: z.string(),
  asset_id: z.string(),
  timestamp: z.union([z.string(), z.number()]),
  bids: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
  asks: z.array(z.object({ price: z.string(), size: z.string() })).default([]),
});

const sportsPayloadSchema = z.object({
  gameId: stringOrNumber.optional(),
  leagueAbbreviation: z.string().optional(),
  slug: z.string(),
  homeTeam: z.string().optional(),
  awayTeam: z.string().optional(),
  status: z.string().optional(),
  score: z.string().optional(),
  period: z.string().optional(),
  elapsed: z.string().optional(),
  live: z.boolean().optional(),
  ended: z.boolean().optional(),
  last_update: z.string().optional(),
  finished_timestamp: z.string().optional(),
  turn: z.string().optional(),
});

const parseJsonArray = (value: string | readonly string[] | null | undefined): string[] => {
  if (value === undefined || value === null) return [];
  if (typeof value !== 'string') return [...value];
  try {
    const parsed: unknown = JSON.parse(value);
    return z.array(z.string()).parse(parsed);
  } catch {
    return [];
  }
};

const timestampMs = (value: string | number): number => {
  const parsed = Number(value);
  return parsed < 10_000_000_000 ? parsed * 1_000 : parsed;
};

const toMarketMetadata = (
  market: z.infer<typeof gammaMarketSchema>,
  eventId?: string,
): MarketMetadata => {
  const tokenIds = parseJsonArray(market.clobTokenIds);
  const outcomes = parseJsonArray(market.outcomes);
  return {
    provider: 'polymarket',
    providerMarketId: market.conditionId ?? market.id,
    eventId: eventId ?? market.gameId ?? market.id,
    title: market.question,
    outcomes: tokenIds.map((assetId, index) => ({
      id: assetId,
      assetId,
      label: outcomes[index] ?? `Outcome ${index + 1}`,
    })),
    ...(market.slug === undefined || market.slug === null
      ? {}
      : { url: `https://polymarket.com/event/${market.slug}` }),
    status: market.closed === true ? 'closed' : market.active === false ? 'unknown' : 'open',
  };
};

export interface PolymarketEventSummary {
  id: string;
  slug: string;
  title: string;
  subtitle?: string;
  sport: string;
  league?: string;
  startTimestampMs?: number;
  live: boolean;
  volume?: number;
  liquidity?: number;
  markets: readonly MarketMetadata[];
  gameId?: string;
  initialSportsState?: SportsState & { homeTeam?: string; awayTeam?: string };
}

const inferSport = (event: z.infer<typeof gammaEventSchema>): string => {
  const sport = typeof event.sport === 'string' ? event.sport : event.sport?.sport;
  return (
    (/soccer|football|basketball|baseball|hockey|tennis|esports/i.test(sport ?? '')
      ? sport
      : undefined) ??
    event.tags?.find((tag) =>
      ['soccer', 'football', 'basketball', 'baseball', 'hockey', 'tennis', 'esports'].includes(
        tag.slug ?? '',
      ),
    )?.label ??
    sport ??
    event.series?.[0]?.title ??
    'Sports'
  );
};

const toEventSummary = (event: z.infer<typeof gammaEventSchema>): PolymarketEventSummary => {
  const start =
    event.eventStartTime ??
    event.markets.find((market) => market.gameStartTime)?.gameStartTime ??
    event.markets.find((market) => market.eventStartTime)?.eventStartTime;
  const startTimestampMs = start === undefined || start === null ? undefined : Date.parse(start);
  const league = event.series?.[0]?.ticker ?? event.series?.[0]?.title ?? undefined;
  const gameId = event.gameId ?? event.markets.find((market) => market.gameId)?.gameId ?? undefined;
  const inferredLive =
    event.ended !== true &&
    (event.live === true ||
      (startTimestampMs !== undefined &&
        startTimestampMs <= Date.now() &&
        Date.now() - startTimestampMs <= 12 * 60 * 60 * 1_000));
  const scores = event.score?.split('-').map((value) => Number(value.trim()));
  const sportsStateTimestamp =
    event.updatedAt === undefined || event.updatedAt === null
      ? Date.now()
      : Date.parse(event.updatedAt);
  const sportsStatus: SportsState['status'] =
    event.ended === true
      ? 'complete'
      : inferredLive
        ? 'live'
        : /break|pause|suspend/i.test(event.status ?? '')
          ? 'paused'
          : startTimestampMs !== undefined && startTimestampMs > Date.now()
            ? 'scheduled'
            : 'unknown';
  const eventSport = inferSport(event);
  const homeTeam =
    event.homeTeam ?? event.teams?.find((team) => team.ordering === 'home')?.name ?? undefined;
  const awayTeam =
    event.awayTeam ?? event.teams?.find((team) => team.ordering === 'away')?.name ?? undefined;
  const initialSportsState =
    event.score === undefined && event.period === undefined && event.elapsed === undefined
      ? undefined
      : {
          eventId: gameId ?? event.id,
          sport: eventSport,
          sourceTimestampMs: Number.isFinite(sportsStateTimestamp)
            ? sportsStateTimestamp
            : Date.now(),
          status: sportsStatus,
          ...(event.period === undefined || event.period === null ? {} : { period: event.period }),
          ...(event.elapsed === undefined || event.elapsed === null
            ? {}
            : { clock: event.elapsed }),
          ...(/soccer/i.test(eventSport) && event.elapsed !== undefined && event.elapsed !== null
            ? { clockDirection: 'up' as const }
            : {}),
          ...(scores?.[0] === undefined || Number.isNaN(scores[0]) ? {} : { homeScore: scores[0] }),
          ...(scores?.[1] === undefined || Number.isNaN(scores[1]) ? {} : { awayScore: scores[1] }),
          ...(homeTeam === undefined ? {} : { homeTeam }),
          ...(awayTeam === undefined ? {} : { awayTeam }),
        };
  return {
    id: event.id,
    slug: event.slug,
    title: event.title,
    sport: eventSport,
    live: inferredLive,
    markets: event.markets
      .filter((market) => market.closed !== true && market.active !== false)
      .map((market) => toMarketMetadata(market, event.id)),
    ...(event.subtitle === undefined || event.subtitle === null
      ? {}
      : { subtitle: event.subtitle }),
    ...(league === undefined ? {} : { league }),
    ...(startTimestampMs === undefined ? {} : { startTimestampMs }),
    ...(event.volume === undefined ? {} : { volume: event.volume }),
    ...(event.liquidity === undefined ? {} : { liquidity: event.liquidity }),
    ...(gameId === undefined ? {} : { gameId }),
    ...(initialSportsState === undefined ? {} : { initialSportsState }),
  };
};

export class PolymarketReadOnlyAdapter {
  public constructor(private readonly fetcher: Fetcher = browserSafeFetch) {}

  private async request(url: string): Promise<Response> {
    try {
      const response = await this.fetcher(url);
      if (!response.ok) {
        if (response.status === 404)
          throw new ProviderError('not_found', 'Polymarket market was not found.', 404);
        throw new ProviderError(
          'http_error',
          `Polymarket request failed (${response.status}).`,
          response.status,
        );
      }
      return response;
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  public async discoverSportsEvents(
    options: {
      limit?: number;
      offset?: number;
    } = {},
  ): Promise<readonly PolymarketEventSummary[]> {
    const limit = Math.min(100, Math.max(1, options.limit ?? 40));
    const offset = Math.max(0, options.offset ?? 0);
    const response = await this.request(
      `${POLYMARKET_ENDPOINTS.gamma}/events?active=true&closed=false&tag_slug=sports&limit=${limit}&offset=${offset}`,
    );
    return z
      .array(gammaEventSchema)
      .parse(await response.json())
      .map(toEventSummary)
      .filter(
        (event) =>
          event.markets.length > 0 &&
          (event.startTimestampMs !== undefined || event.gameId !== undefined || event.live),
      );
  }

  public async resolveEvent(slug: string): Promise<PolymarketEventSummary> {
    const response = await this.request(
      `${POLYMARKET_ENDPOINTS.gamma}/events/slug/${encodeURIComponent(slug)}`,
    );
    return toEventSummary(gammaEventSchema.parse(await response.json()));
  }

  public async resolve(identifier: string): Promise<MarketMetadata> {
    const response = await this.request(
      `${POLYMARKET_ENDPOINTS.gamma}/markets/slug/${encodeURIComponent(identifier)}`,
    );
    return toMarketMetadata(gammaMarketSchema.parse(await response.json()));
  }

  public async resolveReference(
    reference: ParsedMarketReference,
  ): Promise<
    { kind: 'event'; event: PolymarketEventSummary } | { kind: 'market'; market: MarketMetadata }
  > {
    if (reference.provider !== 'polymarket')
      throw new ProviderError('invalid_reference', 'This is not a Polymarket reference.');
    if (reference.kind === 'event')
      return { kind: 'event', event: await this.resolveEvent(reference.identifier) };
    try {
      return { kind: 'market', market: await this.resolve(reference.identifier) };
    } catch (marketError) {
      if (classifyProviderError(marketError).code !== 'not_found') throw marketError;
      return { kind: 'event', event: await this.resolveEvent(reference.identifier) };
    }
  }

  public async loadHistory(assetId: string, interval = '6h', fidelity = 1): Promise<unknown> {
    const response = await this.request(
      `${POLYMARKET_ENDPOINTS.clob}/prices-history?market=${encodeURIComponent(assetId)}&interval=${encodeURIComponent(interval)}&fidelity=${fidelity}`,
    );
    return response.json();
  }

  public async loadHistoryTicks(
    metadata: MarketMetadata,
    assetId: string,
    outcomeId = assetId,
  ): Promise<readonly MarketTick[]> {
    const payload = historySchema.parse(await this.loadHistory(assetId, '6h', 1));
    return payload.history.slice(-2_000).map((point, index) => {
      const sourceTimestampMs = timestampMs(point.t);
      return {
        id: `poly-history-${assetId}-${sourceTimestampMs}-${index}`,
        provider: 'polymarket',
        providerMarketId: metadata.providerMarketId,
        outcomeId,
        sourceTimestampMs,
        receivedTimestampMs: Date.now(),
        monotonicReceivedMs: performance.now(),
        kind: 'trade',
        price: point.p,
        rawSchemaVersion: 'polymarket-history-v1',
      } satisfies MarketTick;
    });
  }

  public async loadBookTick(
    assetId: string,
    receivedTimestampMs = Date.now(),
    monotonicReceivedMs = performance.now(),
  ): Promise<MarketTick> {
    const response = await this.request(
      `${POLYMARKET_ENDPOINTS.clob}/book?token_id=${encodeURIComponent(assetId)}`,
    );
    const book = restBookSchema.parse(await response.json());
    const bestBid = book.bids.reduce<number | undefined>(
      (best, bid) => (best === undefined ? Number(bid.price) : Math.max(best, Number(bid.price))),
      undefined,
    );
    const bestAsk = book.asks.reduce<number | undefined>(
      (best, ask) => (best === undefined ? Number(ask.price) : Math.min(best, Number(ask.price))),
      undefined,
    );
    return {
      id: `poly-rest-book-${book.asset_id}-${String(book.timestamp)}`,
      provider: 'polymarket',
      providerMarketId: book.market,
      outcomeId: book.asset_id,
      sourceTimestampMs: timestampMs(book.timestamp),
      receivedTimestampMs,
      monotonicReceivedMs,
      kind: 'book_snapshot',
      ...(bestBid === undefined || bestAsk === undefined ? {} : { price: (bestBid + bestAsk) / 2 }),
      ...(bestBid === undefined ? {} : { bestBid }),
      ...(bestAsk === undefined ? {} : { bestAsk }),
      rawSchemaVersion: 'polymarket-book-rest-v1',
    };
  }

  public subscription(assetIds: readonly string[]): string {
    return JSON.stringify({ assets_ids: assetIds, type: 'market', custom_feature_enabled: true });
  }

  public normalizeWebSocketPayload(
    payload: unknown,
    receivedTimestampMs: number,
    monotonicReceivedMs: number,
  ): MarketTick[] {
    const messages = Array.isArray(payload) ? payload : [payload];
    return messages.flatMap<MarketTick>((message, messageIndex): MarketTick[] => {
      const change = websocketPriceChangeSchema.safeParse(message);
      if (change.success)
        return change.data.price_changes.map((item, index) => {
          const bestBid = item.best_bid === undefined ? undefined : Number(item.best_bid);
          const bestAsk = item.best_ask === undefined ? undefined : Number(item.best_ask);
          return {
            id: `poly-${item.asset_id}-${String(change.data.timestamp)}-${messageIndex}-${index}`,
            provider: 'polymarket' as const,
            providerMarketId: change.data.market ?? 'unknown',
            outcomeId: item.asset_id,
            sourceTimestampMs: timestampMs(change.data.timestamp),
            receivedTimestampMs,
            monotonicReceivedMs,
            kind: 'best_bid_ask' as const,
            ...(bestBid === undefined || bestAsk === undefined
              ? {}
              : { price: (bestBid + bestAsk) / 2 }),
            ...(bestBid === undefined ? {} : { bestBid }),
            ...(bestAsk === undefined ? {} : { bestAsk }),
            rawSchemaVersion: 'polymarket-market-v2',
          };
        });
      const book = websocketBookSchema.safeParse(message);
      if (book.success) {
        const bids = book.data.bids ?? [];
        const asks = book.data.asks ?? [];
        const bestBid = bids.reduce<number | undefined>(
          (best, bid) =>
            best === undefined ? Number(bid.price) : Math.max(best, Number(bid.price)),
          undefined,
        );
        const bestAsk = asks.reduce<number | undefined>(
          (best, ask) =>
            best === undefined ? Number(ask.price) : Math.min(best, Number(ask.price)),
          undefined,
        );
        return [
          {
            id: `poly-${book.data.asset_id}-${String(book.data.timestamp)}-${messageIndex}`,
            provider: 'polymarket' as const,
            providerMarketId: book.data.market ?? 'unknown',
            outcomeId: book.data.asset_id,
            sourceTimestampMs: timestampMs(book.data.timestamp),
            receivedTimestampMs,
            monotonicReceivedMs,
            kind: 'book_snapshot' as const,
            ...(bestBid === undefined || bestAsk === undefined
              ? {}
              : { price: (bestBid + bestAsk) / 2 }),
            ...(bestBid === undefined ? {} : { bestBid }),
            ...(bestAsk === undefined ? {} : { bestAsk }),
            rawSchemaVersion: 'polymarket-market-v2',
          },
        ];
      }
      const price = websocketPriceSchema.parse(message);
      return [
        {
          id: `poly-${price.asset_id}-${String(price.timestamp)}-${messageIndex}`,
          provider: 'polymarket' as const,
          providerMarketId: price.market ?? 'unknown',
          outcomeId: price.asset_id,
          sourceTimestampMs: timestampMs(price.timestamp),
          receivedTimestampMs,
          monotonicReceivedMs,
          kind:
            price.event_type === 'last_trade_price'
              ? ('trade' as const)
              : ('best_bid_ask' as const),
          ...(price.price === undefined ? {} : { price: Number(price.price) }),
          ...(price.best_bid === undefined ? {} : { bestBid: Number(price.best_bid) }),
          ...(price.best_ask === undefined ? {} : { bestAsk: Number(price.best_ask) }),
          rawSchemaVersion: 'polymarket-market-v2',
        },
      ];
    });
  }

  public normalizeSportsPayload(
    payload: unknown,
    receivedTimestampMs: number,
  ): SportsState & {
    slug: string;
    homeTeam?: string;
    awayTeam?: string;
  } {
    const result = sportsPayloadSchema.parse(payload);
    const scores = result.score?.split('-').map((value) => Number(value.trim()));
    const updateTimestampMs =
      result.last_update === undefined ? receivedTimestampMs : Date.parse(result.last_update);
    const status: SportsState['status'] =
      result.ended === true
        ? 'complete'
        : result.live === true
          ? 'live'
          : /break|half|pause|suspend/i.test(result.status ?? '')
            ? 'paused'
            : /scheduled|not_started/i.test(result.status ?? '')
              ? 'scheduled'
              : 'unknown';
    const continuousClock = /soccer/i.test(result.leagueAbbreviation ?? '');
    return {
      eventId: result.gameId ?? result.slug,
      sport: result.leagueAbbreviation ?? 'sports',
      sourceTimestampMs: Number.isFinite(updateTimestampMs)
        ? updateTimestampMs
        : receivedTimestampMs,
      status,
      slug: result.slug,
      ...(result.period === undefined ? {} : { period: result.period }),
      ...(result.elapsed === undefined ? {} : { clock: result.elapsed }),
      ...(result.elapsed === undefined || !continuousClock
        ? {}
        : { clockDirection: 'up' as const }),
      ...(scores?.[0] === undefined || Number.isNaN(scores[0]) ? {} : { homeScore: scores[0] }),
      ...(scores?.[1] === undefined || Number.isNaN(scores[1]) ? {} : { awayScore: scores[1] }),
      ...(result.homeTeam === undefined ? {} : { homeTeam: result.homeTeam }),
      ...(result.awayTeam === undefined ? {} : { awayTeam: result.awayTeam }),
      ...(result.turn === undefined ? {} : { discreteState: { possession: result.turn } }),
    };
  }
}

export interface ReconnectPolicy {
  attempt: number;
  baseMs?: number;
  capMs?: number;
  random?: () => number;
}

export const reconnectDelayMs = ({
  attempt,
  baseMs = 500,
  capMs = 30_000,
  random = Math.random,
}: ReconnectPolicy): number => {
  const exponential = Math.min(capMs, baseMs * 2 ** Math.max(0, attempt));
  return Math.round(exponential * (0.75 + random() * 0.5));
};
