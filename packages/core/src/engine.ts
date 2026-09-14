import type { MarketTick, ProviderHealth } from '@marketsync/shared-types';
import type { Clock } from './clock';
import { projectDelayedMarket, type DelayedMarketProjection } from './projection';
import { TickBuffer, type InsertResult, type TickBufferOptions } from './tick-buffer';
import { ViewerTimeline, type TimelineOptions } from './timeline';

export interface SyncEngineOptions extends TimelineOptions, TickBufferOptions {
  strictAntiSpoiler?: boolean;
  strictConfidenceThreshold?: number;
}

export class SyncEngine {
  public readonly timeline: ViewerTimeline;
  private readonly buffer: TickBuffer;
  private strictAntiSpoiler: boolean;
  private readonly strictConfidenceThreshold: number;
  private lastSafeProjection: DelayedMarketProjection | undefined;
  private providerHealth: ProviderHealth = {
    connected: true,
    reconnectCount: 0,
    outOfOrderCount: 0,
    invalidMessageCount: 0,
    source: 'mocked',
  };

  public constructor(
    private readonly clock: Clock,
    options: SyncEngineOptions = {},
  ) {
    this.timeline = new ViewerTimeline(clock, options);
    this.buffer = new TickBuffer(options);
    this.strictAntiSpoiler = options.strictAntiSpoiler ?? true;
    this.strictConfidenceThreshold = options.strictConfidenceThreshold ?? 0.55;
  }

  public ingest(tick: MarketTick): InsertResult {
    const result = this.buffer.insert(tick);
    if (result.outOfOrder) this.providerHealth.outOfOrderCount += 1;
    this.providerHealth = { ...this.providerHealth, lastMessageAtMs: this.clock.wallNowMs() };
    return result;
  }

  public projection(): DelayedMarketProjection {
    const state = this.timeline.snapshot();
    const result = projectDelayedMarket(this.buffer.all(), this.timeline.virtualNowMs(), {
      confidence: state.confidence,
      strictAntiSpoiler: this.strictAntiSpoiler,
      strictConfidenceThreshold: this.strictConfidenceThreshold,
      ...(this.lastSafeProjection === undefined
        ? {}
        : { previousSafeProjection: this.lastSafeProjection }),
    });
    if (!result.frozen) this.lastSafeProjection = result;
    return result;
  }

  public setStrictAntiSpoiler(enabled: boolean): void {
    this.strictAntiSpoiler = enabled;
  }

  public reconnect(): void {
    this.providerHealth = {
      ...this.providerHealth,
      connected: false,
      reconnectCount: this.providerHealth.reconnectCount + 1,
    };
    this.timeline.reduceConfidence(0.12, 'provider_reconnect');
  }

  public markConnected(): void {
    this.providerHealth = { ...this.providerHealth, connected: true };
  }

  public health(): ProviderHealth {
    return { ...this.providerHealth };
  }

  public diagnostics(): Record<string, unknown> {
    const projection = this.projection();
    return {
      viewerVirtualTimestampMs: projection.viewerTimestampMs,
      realWallClockTimestampMs: this.clock.wallNowMs(),
      estimatedDelayMs: this.timeline.snapshot().estimatedDelayMs,
      timelineMode: this.timeline.snapshot().mode,
      confidence: this.timeline.snapshot().confidence,
      queuedFutureTicks: projection.queuedFutureTickCount,
      visibleDelayedTicks: projection.visibleTickCount,
      ...this.buffer.bounds(),
      providerHealth: this.health(),
      anchors: this.timeline.getAnchors(),
    };
  }
}
