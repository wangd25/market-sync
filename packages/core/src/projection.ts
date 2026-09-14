import type { MarketTick, Provider, WallClockMs } from '@marketsync/shared-types';

export interface DelayedChartPoint {
  timestampMs: WallClockMs;
  probability: number;
}

export interface DelayedOutcomeProjection {
  outcomeId: string;
  currentPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  priceDirection: 'up' | 'down' | 'flat';
  momentum: DelayedOutcomeMomentum;
  chartPoints: readonly DelayedChartPoint[];
}

export interface DelayedOutcomeMomentum {
  direction: 'up' | 'down' | 'flat';
  intensity: 'quiet' | 'moving' | 'surge';
  change: number;
  fastChange: number;
  windowMs: number;
  lastChangedAtMs: WallClockMs | null;
}

export interface DelayedMarketProjection {
  viewerTimestampMs: WallClockMs;
  provider: Provider | null;
  currentPrice: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  spread: number | null;
  volume: number | null;
  status: 'open' | 'halted' | 'closed' | 'unknown';
  priceDirection: 'up' | 'down' | 'flat';
  chartPoints: readonly DelayedChartPoint[];
  outcomes: readonly DelayedOutcomeProjection[];
  notifications: readonly string[];
  relatedMarkets: readonly never[];
  providerComparison: readonly never[];
  consensusPrice: null;
  visibleTickCount: number;
  queuedFutureTickCount: number;
  frozen: boolean;
}

export interface ProjectionOptions {
  confidence: number;
  strictAntiSpoiler: boolean;
  strictConfidenceThreshold?: number;
  previousSafeProjection?: DelayedMarketProjection;
}

const emptyProjection = (
  viewerTimestampMs: WallClockMs,
  queued: number,
  frozen: boolean,
): DelayedMarketProjection => ({
  viewerTimestampMs,
  provider: null,
  currentPrice: null,
  bestBid: null,
  bestAsk: null,
  spread: null,
  volume: null,
  status: 'unknown',
  priceDirection: 'flat',
  chartPoints: [],
  outcomes: [],
  notifications: [],
  relatedMarkets: [],
  providerComparison: [],
  consensusPrice: null,
  visibleTickCount: 0,
  queuedFutureTickCount: queued,
  frozen,
});

const calculateMomentum = (points: readonly DelayedChartPoint[]): DelayedOutcomeMomentum => {
  const latest = points.at(-1);
  if (latest === undefined || points.length < 2)
    return {
      direction: 'flat',
      intensity: 'quiet',
      change: 0,
      fastChange: 0,
      windowMs: 0,
      lastChangedAtMs: latest?.timestampMs ?? null,
    };

  const previous = points.at(-2) ?? latest;
  const trendCutoffMs = latest.timestampMs - 5_000;
  const fastCutoffMs = latest.timestampMs - 1_500;
  const trendReference =
    points.findLast((point) => point.timestampMs <= trendCutoffMs) ?? points[0] ?? previous;
  const fastReference =
    points.find(
      (point) => point.timestampMs >= fastCutoffMs && point.timestampMs < latest.timestampMs,
    ) ?? previous;
  const change = latest.probability - trendReference.probability;
  const fastChange = latest.probability - fastReference.probability;
  const fastWindowMs = Math.max(1, latest.timestampMs - fastReference.timestampMs);
  const recentStart = Math.max(1, points.length - 12);
  const recentStepChanges = points
    .slice(recentStart, -1)
    .map((point, index) =>
      Math.abs(
        point.probability - (points[recentStart + index - 1]?.probability ?? point.probability),
      ),
    )
    .toSorted((left, right) => left - right);
  const typicalStepChange = recentStepChanges[Math.floor(recentStepChanges.length / 2)] ?? 0;
  const adaptiveSurgeThreshold = Math.max(0.01, Math.min(0.03, typicalStepChange * 3));
  const surge =
    (Math.abs(fastChange) >= adaptiveSurgeThreshold && fastWindowMs <= 1_500) ||
    (Math.abs(fastChange) >= 0.02 && fastWindowMs <= 3_000);
  const directionalChange = surge ? fastChange : change;
  const lastChangedAtMs =
    points.findLast((point, index) => {
      if (index === 0) return false;
      return (
        Math.abs(point.probability - (points[index - 1]?.probability ?? point.probability)) >=
        0.0005
      );
    })?.timestampMs ?? null;
  return {
    direction:
      Math.abs(directionalChange) < 0.0005 ? 'flat' : directionalChange > 0 ? 'up' : 'down',
    intensity: surge ? 'surge' : Math.abs(change) >= 0.004 ? 'moving' : 'quiet',
    change: directionalChange,
    fastChange,
    windowMs: surge ? fastWindowMs : Math.max(1, latest.timestampMs - trendReference.timestampMs),
    lastChangedAtMs,
  };
};

/**
 * The only supported market-to-UI projection. Every displayed field is computed from the same
 * timestamp-filtered tick set so price labels, colors, volume, status, and notifications cannot
 * become side channels for undisplayed future information.
 */
export const projectDelayedMarket = (
  rawTicks: readonly MarketTick[],
  viewerTimestampMs: WallClockMs,
  options: ProjectionOptions,
): DelayedMarketProjection => {
  const futureCount = rawTicks.filter((tick) => tick.sourceTimestampMs > viewerTimestampMs).length;
  const threshold = options.strictConfidenceThreshold ?? 0.55;
  if (options.strictAntiSpoiler && options.confidence < threshold) {
    const previous = options.previousSafeProjection;
    return previous === undefined
      ? emptyProjection(viewerTimestampMs, futureCount, true)
      : { ...previous, queuedFutureTickCount: futureCount, frozen: true };
  }

  const visible = rawTicks.filter((tick) => tick.sourceTimestampMs <= viewerTimestampMs);
  if (visible.length === 0) return emptyProjection(viewerTimestampMs, futureCount, false);

  const outcomeState = new Map<
    string,
    {
      price: number | null;
      previousPrice: number | null;
      bestBid: number | null;
      bestAsk: number | null;
      chartPoints: DelayedChartPoint[];
    }
  >();
  let volume: number | null = null;
  let status: DelayedMarketProjection['status'] = 'unknown';
  for (const tick of visible) {
    const state = outcomeState.get(tick.outcomeId) ?? {
      price: null,
      previousPrice: null,
      bestBid: null,
      bestAsk: null,
      chartPoints: [],
    };
    if (tick.price !== undefined) {
      state.previousPrice = state.price;
      state.price = tick.price;
      state.chartPoints.push({ timestampMs: tick.sourceTimestampMs, probability: tick.price });
    }
    if (tick.bestBid !== undefined) state.bestBid = tick.bestBid;
    if (tick.bestAsk !== undefined) state.bestAsk = tick.bestAsk;
    outcomeState.set(tick.outcomeId, state);
    if (tick.volume !== undefined) volume = tick.volume;
    if (tick.status !== undefined) status = tick.status;
  }
  const outcomes: DelayedOutcomeProjection[] = [...outcomeState.entries()].map(
    ([outcomeId, state]) => ({
      outcomeId,
      currentPrice: state.price,
      bestBid: state.bestBid,
      bestAsk: state.bestAsk,
      spread:
        state.bestBid === null || state.bestAsk === null
          ? null
          : Math.max(0, state.bestAsk - state.bestBid),
      priceDirection:
        state.price === null || state.previousPrice === null || state.price === state.previousPrice
          ? 'flat'
          : state.price > state.previousPrice
            ? 'up'
            : 'down',
      momentum: calculateMomentum(state.chartPoints),
      chartPoints: state.chartPoints,
    }),
  );
  const primary = outcomes[0];
  const last = visible.at(-1);
  return {
    viewerTimestampMs,
    provider: last?.provider ?? null,
    currentPrice: primary?.currentPrice ?? null,
    bestBid: primary?.bestBid ?? null,
    bestAsk: primary?.bestAsk ?? null,
    spread: primary?.spread ?? null,
    volume,
    status,
    priceDirection: primary?.priceDirection ?? 'flat',
    chartPoints: primary?.chartPoints ?? [],
    outcomes,
    notifications: [],
    relatedMarkets: [],
    providerComparison: [],
    consensusPrice: null,
    visibleTickCount: visible.length,
    queuedFutureTickCount: futureCount,
    frozen: false,
  };
};
