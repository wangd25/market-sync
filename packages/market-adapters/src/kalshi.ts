import type { MarketMetadata } from '@marketsync/shared-types';
import { z } from 'zod';
import { KALSHI_ENDPOINTS } from './endpoints';
import { browserSafeFetch, type Fetcher } from './fetcher';

const kalshiMarketSchema = z.object({
  ticker: z.string(),
  event_ticker: z.string().optional(),
  title: z.string(),
  status: z.string(),
  yes_sub_title: z.string().optional(),
  no_sub_title: z.string().optional(),
});

const marketResponseSchema = z.object({ market: kalshiMarketSchema });
const searchResponseSchema = z.object({
  markets: z.array(kalshiMarketSchema),
  cursor: z.string().optional(),
});
const orderbookResponseSchema = z.object({
  orderbook_fp: z.object({
    yes_dollars: z.array(z.tuple([z.string(), z.string()])),
    no_dollars: z.array(z.tuple([z.string(), z.string()])),
  }),
});

export class KalshiPublicRestAdapter {
  public constructor(
    private readonly fetcher: Fetcher = browserSafeFetch,
    private readonly baseUrl = KALSHI_ENDPOINTS.productionRest,
  ) {}

  public async search(query: string): Promise<readonly MarketMetadata[]> {
    const response = await this.fetcher(
      `${this.baseUrl}/markets?limit=25&search=${encodeURIComponent(query)}`,
    );
    if (!response.ok) throw new Error(`Kalshi market search failed (${response.status}).`);
    return searchResponseSchema
      .parse(await response.json())
      .markets.map((market) => this.toMetadata(market));
  }

  public async resolve(ticker: string): Promise<MarketMetadata> {
    const response = await this.fetcher(`${this.baseUrl}/markets/${encodeURIComponent(ticker)}`);
    if (!response.ok) throw new Error(`Kalshi market request failed (${response.status}).`);
    return this.toMetadata(marketResponseSchema.parse(await response.json()).market);
  }

  public async orderbook(ticker: string): Promise<z.infer<typeof orderbookResponseSchema>> {
    const response = await this.fetcher(
      `${this.baseUrl}/markets/${encodeURIComponent(ticker)}/orderbook`,
    );
    if (!response.ok) throw new Error(`Kalshi order-book request failed (${response.status}).`);
    return orderbookResponseSchema.parse(await response.json());
  }

  public async candlesticks(
    seriesTicker: string,
    ticker: string,
    startTs: number,
    endTs: number,
  ): Promise<unknown> {
    const url = `${this.baseUrl}/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(ticker)}/candlesticks?start_ts=${startTs}&end_ts=${endTs}&period_interval=1`;
    const response = await this.fetcher(url);
    if (!response.ok) throw new Error(`Kalshi candlestick request failed (${response.status}).`);
    return response.json();
  }

  private toMetadata(market: z.infer<typeof kalshiMarketSchema>): MarketMetadata {
    return {
      provider: 'kalshi',
      providerMarketId: market.ticker,
      eventId: market.event_ticker ?? market.ticker,
      title: market.title,
      outcomes: [
        { id: 'yes', label: market.yes_sub_title ?? 'Yes' },
        { id: 'no', label: market.no_sub_title ?? 'No' },
      ],
      url: `https://kalshi.com/markets/${market.ticker.toLowerCase()}`,
      status:
        market.status === 'open' || market.status === 'active'
          ? 'open'
          : market.status === 'closed'
            ? 'closed'
            : 'unknown',
    };
  }
}
