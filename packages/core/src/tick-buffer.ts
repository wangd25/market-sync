import type { MarketTick, WallClockMs } from '@marketsync/shared-types';

export interface TickBufferOptions {
  maxItems?: number;
  retentionMs?: number;
}

export interface InsertResult {
  accepted: boolean;
  duplicate: boolean;
  outOfOrder: boolean;
  pruned: number;
}

const compareTicks = (a: MarketTick, b: MarketTick): number =>
  a.sourceTimestampMs - b.sourceTimestampMs ||
  (a.sequence ?? 0) - (b.sequence ?? 0) ||
  a.id.localeCompare(b.id);

export class TickBuffer {
  private readonly ticks: MarketTick[] = [];
  private readonly ids = new Set<string>();
  private readonly maxItems: number;
  private readonly retentionMs: number;

  public constructor(options: TickBufferOptions = {}) {
    this.maxItems = options.maxItems ?? 10_000;
    this.retentionMs = options.retentionMs ?? 2 * 60 * 60 * 1000;
  }

  public insert(tick: MarketTick): InsertResult {
    if (this.ids.has(tick.id))
      return { accepted: false, duplicate: true, outOfOrder: false, pruned: 0 };
    const last = this.ticks.at(-1);
    const outOfOrder = last !== undefined && compareTicks(tick, last) < 0;
    let low = 0;
    let high = this.ticks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      const candidate = this.ticks[middle];
      if (candidate !== undefined && compareTicks(candidate, tick) <= 0) low = middle + 1;
      else high = middle;
    }
    this.ticks.splice(low, 0, tick);
    this.ids.add(tick.id);
    const pruned = this.prune(tick.receivedTimestampMs);
    return { accepted: true, duplicate: false, outOfOrder, pruned };
  }

  public atOrBefore(viewerTimestampMs: WallClockMs): readonly MarketTick[] {
    let low = 0;
    let high = this.ticks.length;
    while (low < high) {
      const middle = (low + high) >>> 1;
      if ((this.ticks[middle]?.sourceTimestampMs ?? Infinity) <= viewerTimestampMs)
        low = middle + 1;
      else high = middle;
    }
    return this.ticks.slice(0, low);
  }

  public after(viewerTimestampMs: WallClockMs): readonly MarketTick[] {
    return this.ticks.filter((tick) => tick.sourceTimestampMs > viewerTimestampMs);
  }

  public all(): readonly MarketTick[] {
    return [...this.ticks];
  }

  public bounds(): { oldestTimestampMs?: WallClockMs; newestTimestampMs?: WallClockMs } {
    const oldestTimestampMs = this.ticks[0]?.sourceTimestampMs;
    const newestTimestampMs = this.ticks.at(-1)?.sourceTimestampMs;
    return {
      ...(oldestTimestampMs === undefined ? {} : { oldestTimestampMs }),
      ...(newestTimestampMs === undefined ? {} : { newestTimestampMs }),
    };
  }

  public get size(): number {
    return this.ticks.length;
  }

  public prune(nowMs: WallClockMs): number {
    const cutoff = nowMs - this.retentionMs;
    let removeCount = 0;
    while (
      removeCount < this.ticks.length &&
      ((this.ticks[removeCount]?.receivedTimestampMs ?? nowMs) < cutoff ||
        this.ticks.length - removeCount > this.maxItems)
    ) {
      removeCount += 1;
    }
    if (removeCount === 0) return 0;
    const removed = this.ticks.splice(0, removeCount);
    for (const tick of removed) this.ids.delete(tick.id);
    return removed.length;
  }
}
