import type {
  MarketTick,
  ProviderHealth,
  SportsFeedDescriptor,
  SportsObservation,
  SportsState,
  SportsTimestampQuality,
} from '@marketsync/shared-types';
import { POLYMARKET_ENDPOINTS } from './endpoints';
import { EspnPublicSportsAdapter, type EspnEventReference } from './espn';
import { PolymarketReadOnlyAdapter, reconnectDelayMs } from './polymarket';

export interface WebSocketLike {
  readonly readyState: number;
  onopen: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onclose: ((event: CloseEvent) => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

export type WebSocketFactory = (url: string) => WebSocketLike;

export interface PolymarketLiveSessionCallbacks {
  onTicks(ticks: readonly MarketTick[]): void;
  onSportsState?(
    state: SportsState & { slug?: string; homeTeam?: string; awayTeam?: string },
  ): void;
  onSportsObservation?(observation: SportsObservation): void;
  onSportsStatus?(status: SportsFeedStatus): void;
  onHealth(health: ProviderHealth): void;
  onError?(error: Error): void;
}

export type SportsFeedStatus = 'connecting' | 'play-by-play' | 'live' | 'polling' | 'limited';

export interface PolymarketLiveSessionOptions {
  assetIds: readonly string[];
  eventSlug?: string;
  sportsEvent?: EspnEventReference;
  adapter?: PolymarketReadOnlyAdapter;
  espnAdapter?: EspnPublicSportsAdapter;
  webSocketFactory?: WebSocketFactory;
  callbacks: PolymarketLiveSessionCallbacks;
  heartbeatMs?: number;
  staleAfterMs?: number;
  sportsPollMs?: number;
  playByPlayPollMs?: number;
  now?: () => number;
  monotonicNow?: () => number;
  random?: () => number;
}

const nativeWebSocketFactory: WebSocketFactory = (url) => new WebSocket(url);
const WS_OPEN = 1;

export const ESPN_SPORTS_DESCRIPTOR: SportsFeedDescriptor = {
  id: 'espn-gamecast',
  label: 'ESPN Gamecast',
  authority: 'public_unverified',
  capabilities: new Set([
    'scoreboard',
    'game_clock',
    'play_by_play',
    'player_attribution',
    'wall_clock_timestamp',
    'ordered_sequence',
    'replay_recovery',
  ]),
  expectedUpdateIntervalMs: 2_000,
  commercialAccess: 'public',
};

export const POLYMARKET_SPORTS_DESCRIPTOR: SportsFeedDescriptor = {
  id: 'polymarket-sports',
  label: 'Polymarket sports',
  authority: 'market_corroboration',
  capabilities: new Set(['scoreboard', 'game_clock', 'possession', 'push_delivery']),
  expectedUpdateIntervalMs: 5_000,
  commercialAccess: 'public',
};

const normalizedSportsState = (
  state: SportsState & { slug?: string; homeTeam?: string; awayTeam?: string },
): SportsState => ({
  eventId: state.eventId,
  sport: state.sport,
  sourceTimestampMs: state.sourceTimestampMs,
  status: state.status,
  ...(state.period === undefined ? {} : { period: state.period }),
  ...(state.clock === undefined ? {} : { clock: state.clock }),
  ...(state.clockDirection === undefined ? {} : { clockDirection: state.clockDirection }),
  ...(state.homeScore === undefined ? {} : { homeScore: state.homeScore }),
  ...(state.awayScore === undefined ? {} : { awayScore: state.awayScore }),
  ...(state.discreteState === undefined ? {} : { discreteState: state.discreteState }),
  ...(state.homeTeam === undefined ? {} : { homeTeam: state.homeTeam }),
  ...(state.awayTeam === undefined ? {} : { awayTeam: state.awayTeam }),
});

export class PolymarketLiveSession {
  private readonly adapter: PolymarketReadOnlyAdapter;
  private readonly webSocketFactory: WebSocketFactory;
  private readonly espnAdapter: EspnPublicSportsAdapter;
  private readonly heartbeatMs: number;
  private readonly staleAfterMs: number;
  private readonly sportsPollMs: number;
  private readonly playByPlayPollMs: number;
  private readonly now: () => number;
  private readonly monotonicNow: () => number;
  private readonly random: () => number;
  private marketSocket: WebSocketLike | null = null;
  private sportsSocket: WebSocketLike | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sportsReconnectTimer: ReturnType<typeof setTimeout> | undefined;
  private sportsPollTimer: ReturnType<typeof setInterval> | undefined;
  private playByPlayPollTimer: ReturnType<typeof setInterval> | undefined;
  private stopped = true;
  private reconnectCount = 0;
  private invalidMessageCount = 0;
  private outOfOrderCount = 0;
  private lastTransportAtMs: number | undefined;
  private lastDataAtMs: number | undefined;
  private lastSportsTransportAtMs: number | undefined;
  private receivedSportsSocketData = false;
  private sportsPollInFlight = false;
  private playByPlayPollInFlight = false;
  private hasPlayByPlay = false;
  private readonly seenPlayIds = new Set<string>();
  private readonly seenPlayFingerprints = new Set<string>();

  public constructor(private readonly options: PolymarketLiveSessionOptions) {
    this.adapter = options.adapter ?? new PolymarketReadOnlyAdapter();
    this.espnAdapter = options.espnAdapter ?? new EspnPublicSportsAdapter();
    this.webSocketFactory = options.webSocketFactory ?? nativeWebSocketFactory;
    this.heartbeatMs = options.heartbeatMs ?? 10_000;
    this.staleAfterMs = options.staleAfterMs ?? 20_000;
    this.sportsPollMs = options.sportsPollMs ?? 8_000;
    // The structured feed is the confirmation path for market movement. A
    // two-second cadence materially reduces visible play latency while the
    // in-flight guard prevents overlapping requests on slow connections.
    this.playByPlayPollMs = options.playByPlayPollMs ?? 2_000;
    this.now = options.now ?? Date.now;
    this.monotonicNow = options.monotonicNow ?? (() => performance.now());
    this.random = options.random ?? Math.random;
  }

  public start(): void {
    if (!this.stopped) return;
    this.stopped = false;
    this.connect();
  }

  public stop(): void {
    this.stopped = true;
    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    if (this.reconnectTimer !== undefined) clearTimeout(this.reconnectTimer);
    if (this.sportsReconnectTimer !== undefined) clearTimeout(this.sportsReconnectTimer);
    if (this.sportsPollTimer !== undefined) clearInterval(this.sportsPollTimer);
    if (this.playByPlayPollTimer !== undefined) clearInterval(this.playByPlayPollTimer);
    this.heartbeatTimer = undefined;
    this.reconnectTimer = undefined;
    this.sportsReconnectTimer = undefined;
    this.sportsPollTimer = undefined;
    this.playByPlayPollTimer = undefined;
    this.marketSocket?.close(1000, 'market changed');
    this.sportsSocket?.close(1000, 'market changed');
    this.marketSocket = null;
    this.sportsSocket = null;
  }

  public health(): ProviderHealth {
    const heartbeatGapMs =
      this.lastTransportAtMs === undefined ? undefined : this.now() - this.lastTransportAtMs;
    const dataGapMs = this.lastDataAtMs === undefined ? undefined : this.now() - this.lastDataAtMs;
    return {
      connected:
        !this.stopped &&
        this.marketSocket?.readyState === WS_OPEN &&
        (heartbeatGapMs === undefined || heartbeatGapMs <= this.staleAfterMs),
      reconnectCount: this.reconnectCount,
      outOfOrderCount: this.outOfOrderCount,
      invalidMessageCount: this.invalidMessageCount,
      source: 'live',
      ...(this.lastTransportAtMs === undefined ? {} : { lastMessageAtMs: this.lastTransportAtMs }),
      ...(this.lastDataAtMs === undefined ? {} : { lastDataAtMs: this.lastDataAtMs }),
      ...(heartbeatGapMs === undefined ? {} : { heartbeatGapMs }),
      ...(dataGapMs === undefined ? {} : { dataGapMs }),
    };
  }

  /** Revalidates the selected books and sports sources without changing the viewer delay. */
  public async refresh(): Promise<void> {
    if (this.stopped) return;
    await Promise.all([
      this.refreshMarketBooks(),
      this.pollSportsState(true),
      this.pollPlayByPlay(true),
    ]);
    this.emitHealth();
  }

  /** Revalidates only the scoreboard and play-by-play sources. */
  public async refreshSports(): Promise<void> {
    if (this.stopped) return;
    await Promise.all([this.pollSportsState(true), this.pollPlayByPlay(true)]);
  }

  private emitHealth(): void {
    this.options.callbacks.onHealth(this.health());
  }

  private hasSportsReceiver(): boolean {
    return (
      this.options.callbacks.onSportsObservation !== undefined ||
      this.options.callbacks.onSportsState !== undefined
    );
  }

  private emitSportsObservation(
    state: SportsState & { slug?: string; homeTeam?: string; awayTeam?: string },
    descriptor: SportsFeedDescriptor,
    providerEventId: string,
    timestampQuality: SportsTimestampQuality,
    revision = 0,
    correction = false,
  ): void {
    const receivedTimestampMs = this.now();
    const normalized = normalizedSportsState(state);
    const observation: SportsObservation = {
      id: `${descriptor.id}:${providerEventId}:${revision}`,
      sourceId: descriptor.id,
      sourceLabel: descriptor.label,
      authority: descriptor.authority,
      capabilities: [...descriptor.capabilities],
      providerEventId,
      revision,
      correction,
      timestampQuality,
      sourceTimestampMs: normalized.sourceTimestampMs,
      receivedTimestampMs,
      monotonicReceivedMs: this.monotonicNow(),
      state: normalized,
      rawSchemaVersion: 'marketsync-sports-observation-v1',
    };
    this.options.callbacks.onSportsObservation?.(observation);
    this.options.callbacks.onSportsState?.(state);
  }

  private connect(): void {
    if (this.stopped) return;
    const marketSocket = this.webSocketFactory(POLYMARKET_ENDPOINTS.marketWebSocket);
    this.marketSocket = marketSocket;
    marketSocket.onopen = () => {
      this.reconnectCount = 0;
      this.lastTransportAtMs = this.now();
      marketSocket.send(this.adapter.subscription(this.options.assetIds));
      this.emitHealth();
    };
    marketSocket.onmessage = (event) => {
      this.lastTransportAtMs = this.now();
      if (event.data === 'PONG') {
        this.emitHealth();
        return;
      }
      try {
        const ticks = this.adapter.normalizeWebSocketPayload(
          JSON.parse(String(event.data)) as unknown,
          this.lastTransportAtMs,
          this.monotonicNow(),
        );
        if (ticks.length > 0) this.lastDataAtMs = this.lastTransportAtMs;
        this.options.callbacks.onTicks(ticks);
      } catch (error) {
        this.invalidMessageCount += 1;
        this.options.callbacks.onError?.(
          error instanceof Error ? error : new Error('Invalid Polymarket market message'),
        );
      }
      this.emitHealth();
    };
    marketSocket.onerror = () => this.emitHealth();
    marketSocket.onclose = () => this.scheduleReconnect();

    if (this.options.eventSlug !== undefined && this.hasSportsReceiver()) this.connectSports();

    this.startSportsPolling();
    this.startPlayByPlayPolling();

    if (this.heartbeatTimer !== undefined) clearInterval(this.heartbeatTimer);
    this.heartbeatTimer = setInterval(() => {
      if (this.marketSocket?.readyState === WS_OPEN) {
        const transportAge =
          this.lastTransportAtMs === undefined ? 0 : this.now() - this.lastTransportAtMs;
        if (transportAge > this.staleAfterMs) {
          this.marketSocket.close(4000, 'heartbeat timeout');
        } else {
          this.marketSocket.send('PING');
        }
      }
      if (this.sportsSocket?.readyState === WS_OPEN) {
        const sportsAge =
          this.lastSportsTransportAtMs === undefined
            ? 0
            : this.now() - this.lastSportsTransportAtMs;
        if (sportsAge > this.staleAfterMs)
          this.sportsSocket.close(4000, 'sports heartbeat timeout');
      }
      this.emitHealth();
    }, this.heartbeatMs);
  }

  private connectSports(): void {
    if (this.stopped || this.sportsSocket !== null) return;
    const socket = this.webSocketFactory(POLYMARKET_ENDPOINTS.sportsWebSocket);
    this.sportsSocket = socket;
    this.options.callbacks.onSportsStatus?.('connecting');
    socket.onopen = () => {
      this.lastSportsTransportAtMs = this.now();
      this.emitHealth();
    };
    socket.onmessage = (event) => {
      this.lastSportsTransportAtMs = this.now();
      if (event.data === 'ping') {
        socket.send('pong');
        return;
      }
      try {
        const state = this.adapter.normalizeSportsPayload(
          JSON.parse(String(event.data)) as unknown,
          this.now(),
        );
        if (state.slug === this.options.eventSlug) {
          this.receivedSportsSocketData = true;
          this.options.callbacks.onSportsStatus?.(this.hasPlayByPlay ? 'play-by-play' : 'live');
          const providerEventId = [
            state.eventId,
            state.sourceTimestampMs,
            state.period ?? '',
            state.homeScore ?? '',
            state.awayScore ?? '',
          ].join(':');
          this.emitSportsObservation(
            state,
            POLYMARKET_SPORTS_DESCRIPTOR,
            providerEventId,
            state.sourceTimestampMs === this.lastSportsTransportAtMs
              ? 'receipt_approximation'
              : 'provider',
          );
        }
      } catch (error) {
        this.invalidMessageCount += 1;
        this.options.callbacks.onError?.(
          error instanceof Error ? error : new Error('Invalid Polymarket sports message'),
        );
      }
    };
    socket.onerror = () => this.emitHealth();
    socket.onclose = () => {
      this.sportsSocket = null;
      if (!this.receivedSportsSocketData) this.options.callbacks.onSportsStatus?.('connecting');
      if (this.stopped || this.sportsReconnectTimer !== undefined) return;
      const delay = reconnectDelayMs({
        attempt: this.reconnectCount,
        random: this.random,
      });
      this.reconnectCount += 1;
      this.sportsReconnectTimer = setTimeout(() => {
        this.sportsReconnectTimer = undefined;
        this.connectSports();
      }, delay);
    };
  }

  private startSportsPolling(): void {
    if (
      this.options.eventSlug === undefined ||
      !this.hasSportsReceiver() ||
      this.sportsPollMs <= 0 ||
      this.sportsPollTimer !== undefined
    )
      return;
    void this.pollSportsState();
    this.sportsPollTimer = setInterval(() => void this.pollSportsState(), this.sportsPollMs);
  }

  private async pollSportsState(force = false): Promise<void> {
    if (
      this.stopped ||
      (!force && this.receivedSportsSocketData) ||
      this.sportsPollInFlight ||
      this.options.eventSlug === undefined
    )
      return;
    this.sportsPollInFlight = true;
    try {
      const event = await this.adapter.resolveEvent(this.options.eventSlug);
      if (this.stopped) return;
      if (event.initialSportsState === undefined) {
        if (!this.receivedSportsSocketData)
          this.options.callbacks.onSportsStatus?.(this.hasPlayByPlay ? 'play-by-play' : 'limited');
        return;
      }
      if (!this.receivedSportsSocketData)
        this.options.callbacks.onSportsStatus?.(this.hasPlayByPlay ? 'play-by-play' : 'polling');
      const state = {
        ...event.initialSportsState,
        slug: event.slug,
      };
      this.emitSportsObservation(
        state,
        POLYMARKET_SPORTS_DESCRIPTOR,
        [
          state.eventId,
          state.sourceTimestampMs,
          state.period ?? '',
          state.homeScore ?? '',
          state.awayScore ?? '',
        ].join(':'),
        'provider',
      );
    } catch {
      if (!this.stopped && !this.receivedSportsSocketData)
        this.options.callbacks.onSportsStatus?.(this.hasPlayByPlay ? 'play-by-play' : 'limited');
    } finally {
      this.sportsPollInFlight = false;
    }
  }

  private async refreshMarketBooks(): Promise<void> {
    const settled = await Promise.allSettled(
      this.options.assetIds.map((assetId) =>
        this.adapter.loadBookTick(assetId, this.now(), this.monotonicNow()),
      ),
    );
    if (this.stopped) return;
    const ticks = settled.flatMap((result) =>
      result.status === 'fulfilled' ? [result.value] : [],
    );
    if (ticks.length > 0) {
      this.lastTransportAtMs = this.now();
      this.lastDataAtMs = this.lastTransportAtMs;
      this.options.callbacks.onTicks(ticks);
    }
    const firstFailure = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstFailure !== undefined && ticks.length === 0)
      this.options.callbacks.onError?.(
        firstFailure.reason instanceof Error
          ? firstFailure.reason
          : new Error('Could not refresh the selected Polymarket order books.'),
      );
  }

  private startPlayByPlayPolling(): void {
    if (
      this.options.sportsEvent === undefined ||
      !this.hasSportsReceiver() ||
      this.playByPlayPollMs <= 0 ||
      this.playByPlayPollTimer !== undefined
    )
      return;
    void this.pollPlayByPlay();
    this.playByPlayPollTimer = setInterval(() => void this.pollPlayByPlay(), this.playByPlayPollMs);
  }

  private async pollPlayByPlay(force = false): Promise<void> {
    if (
      this.stopped ||
      this.playByPlayPollInFlight ||
      this.options.sportsEvent === undefined ||
      !this.hasSportsReceiver()
    )
      return;
    this.playByPlayPollInFlight = true;
    try {
      const feed = await this.espnAdapter.loadLiveFeed(this.options.sportsEvent, this.now());
      if (this.stopped) return;
      if (feed === null) {
        if (!this.receivedSportsSocketData) this.options.callbacks.onSportsStatus?.('limited');
        return;
      }
      // A fresh, timestamped state on every poll keeps the projected score and
      // interpolated game clock advancing even when no discrete play occurred.
      this.emitSportsObservation(
        feed.scoreboard,
        ESPN_SPORTS_DESCRIPTOR,
        `scoreboard:${feed.scoreboard.eventId}:${feed.scoreboard.sourceTimestampMs}`,
        'receipt_approximation',
      );
      let emitted = 0;
      for (const state of feed.plays) {
        const playId = String(state.discreteState?.['playId'] ?? '');
        const key = `${state.eventId}:${playId || state.sourceTimestampMs}`;
        const description = String(state.discreteState?.['description'] ?? '')
          .toLowerCase()
          .normalize('NFKD')
          .replace(/[^a-z0-9]+/g, ' ')
          .trim();
        const fingerprint = [
          state.eventId,
          description,
          state.period ?? '',
          state.clock ?? '',
          String(state.discreteState?.['team'] ?? '').toLowerCase(),
        ].join(':');
        if (this.seenPlayIds.has(key) || this.seenPlayFingerprints.has(fingerprint)) continue;
        this.seenPlayIds.add(key);
        this.seenPlayFingerprints.add(fingerprint);
        this.emitSportsObservation(
          state,
          ESPN_SPORTS_DESCRIPTOR,
          playId || `${state.eventId}:${state.sourceTimestampMs}:${fingerprint}`,
          'provider',
        );
        emitted += 1;
      }
      if (this.seenPlayIds.size > 4_000) {
        const retained = [...this.seenPlayIds].slice(-2_000);
        this.seenPlayIds.clear();
        for (const key of retained) this.seenPlayIds.add(key);
      }
      if (this.seenPlayFingerprints.size > 4_000) {
        const retained = [...this.seenPlayFingerprints].slice(-2_000);
        this.seenPlayFingerprints.clear();
        for (const fingerprint of retained) this.seenPlayFingerprints.add(fingerprint);
      }
      if (emitted > 0 || (force && feed.plays.length > 0)) this.hasPlayByPlay = true;
      if (this.hasPlayByPlay) this.options.callbacks.onSportsStatus?.('play-by-play');
    } catch (error) {
      // This is a best-effort enhancement. The validated Polymarket sports
      // socket and poller remain active when Gamecast is unavailable.
      if (force)
        this.options.callbacks.onError?.(
          error instanceof Error ? error : new Error('Could not refresh public play-by-play.'),
        );
    } finally {
      this.playByPlayPollInFlight = false;
    }
  }

  private scheduleReconnect(): void {
    this.marketSocket = null;
    this.emitHealth();
    if (this.stopped || this.reconnectTimer !== undefined) return;
    const delay = reconnectDelayMs({
      attempt: this.reconnectCount,
      random: this.random,
    });
    this.reconnectCount += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.connect();
    }, delay);
  }
}
