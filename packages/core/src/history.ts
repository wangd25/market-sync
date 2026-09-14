export interface TimestampedRecord {
  id: string;
  receivedTimestampMs: number;
}

export const pruneHistory = <T extends TimestampedRecord>(
  records: readonly T[],
  nowMs: number,
  retentionMs: number,
  maxItems: number,
): readonly T[] =>
  records
    .filter((record) => record.receivedTimestampMs >= nowMs - retentionMs)
    .sort((a, b) => a.receivedTimestampMs - b.receivedTimestampMs)
    .slice(-maxItems);
