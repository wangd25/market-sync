import { openDB, type DBSchema } from 'idb';
import type { MarketTick, ResearchObservation, SyncAnchor } from '@marketsync/shared-types';

interface MarketSyncDatabase extends DBSchema {
  ticks: { key: string; value: MarketTick; indexes: { 'by-received': number } };
  anchors: { key: string; value: SyncAnchor; indexes: { 'by-real': number } };
  research: {
    key: string;
    value: ResearchObservation;
    indexes: { 'by-recorded': number; 'by-session': string };
  };
}

const database = () =>
  openDB<MarketSyncDatabase>('marketsync-history', 2, {
    upgrade(db) {
      if (!db.objectStoreNames.contains('ticks')) {
        const ticks = db.createObjectStore('ticks', { keyPath: 'id' });
        ticks.createIndex('by-received', 'receivedTimestampMs');
      }
      if (!db.objectStoreNames.contains('anchors')) {
        const anchors = db.createObjectStore('anchors', { keyPath: 'id' });
        anchors.createIndex('by-real', 'realTimestampMs');
      }
      if (!db.objectStoreNames.contains('research')) {
        const research = db.createObjectStore('research', { keyPath: 'id' });
        research.createIndex('by-recorded', 'recordedAtMs');
        research.createIndex('by-session', 'sessionId');
      }
    },
  });

export const browserHistoryStore = {
  async saveTicks(ticks: readonly MarketTick[]): Promise<void> {
    const db = await database();
    const transaction = db.transaction('ticks', 'readwrite');
    await Promise.all([...ticks.map((tick) => transaction.store.put(tick)), transaction.done]);
  },
  async loadTicks(providerMarketId: string, maxItems = 2_000): Promise<readonly MarketTick[]> {
    const db = await database();
    return (await db.getAll('ticks'))
      .filter((tick) => tick.providerMarketId === providerMarketId)
      .toSorted((a, b) => a.sourceTimestampMs - b.sourceTimestampMs)
      .slice(-maxItems);
  },
  async pruneTicks(cutoffMs: number, maxItems = 10_000): Promise<void> {
    const db = await database();
    const transaction = db.transaction('ticks', 'readwrite');
    let cursor = await transaction.store.index('by-received').openCursor();
    let count = await transaction.store.count();
    while (cursor !== null && (cursor.value.receivedTimestampMs < cutoffMs || count > maxItems)) {
      await cursor.delete();
      count -= 1;
      cursor = await cursor.continue();
    }
    await transaction.done;
  },
  async saveAnchors(anchors: readonly SyncAnchor[]): Promise<void> {
    const db = await database();
    const transaction = db.transaction('anchors', 'readwrite');
    await Promise.all([
      ...anchors.map((anchor) => transaction.store.put(anchor)),
      transaction.done,
    ]);
  },
  async saveResearchObservations(observations: readonly ResearchObservation[]): Promise<void> {
    if (observations.length === 0) return;
    const db = await database();
    const transaction = db.transaction('research', 'readwrite');
    await Promise.all([
      ...observations.map((observation) => transaction.store.put(observation)),
      transaction.done,
    ]);
  },
  async loadResearchSession(
    sessionId: string,
    maxItems = 5_000,
  ): Promise<readonly ResearchObservation[]> {
    const db = await database();
    return (await db.getAllFromIndex('research', 'by-session', sessionId))
      .toSorted(
        (left, right) =>
          left.recordedAtMs - right.recordedAtMs ||
          left.monotonicRecordedMs - right.monotonicRecordedMs,
      )
      .slice(-maxItems);
  },
  async pruneResearch(cutoffMs: number, maxItems = 10_000): Promise<void> {
    const db = await database();
    const transaction = db.transaction('research', 'readwrite');
    let cursor = await transaction.store.index('by-recorded').openCursor();
    let count = await transaction.store.count();
    while (cursor !== null && (cursor.value.recordedAtMs < cutoffMs || count > maxItems)) {
      await cursor.delete();
      count -= 1;
      cursor = await cursor.continue();
    }
    await transaction.done;
  },
};
