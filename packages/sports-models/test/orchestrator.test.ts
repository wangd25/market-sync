import { describe, expect, it } from 'vitest';
import type { SportsFeedDescriptor, SportsObservation } from '@marketsync/shared-types';
import { SportsSourceOrchestrator } from '../src';

const detailed: SportsFeedDescriptor = {
  id: 'official',
  label: 'Official play-by-play',
  authority: 'official',
  capabilities: new Set([
    'scoreboard',
    'game_clock',
    'play_by_play',
    'wall_clock_timestamp',
    'ordered_sequence',
    'push_delivery',
    'replay_recovery',
  ]),
  expectedUpdateIntervalMs: 1_000,
  commercialAccess: 'licensed',
};

const backup: SportsFeedDescriptor = {
  id: 'backup',
  label: 'Public scoreboard',
  authority: 'public_verified',
  capabilities: new Set(['scoreboard', 'game_clock', 'wall_clock_timestamp']),
  expectedUpdateIntervalMs: 2_000,
  commercialAccess: 'public',
};

const observation = (
  descriptor: SportsFeedDescriptor,
  providerEventId: string,
  sourceTimestampMs: number,
  receivedTimestampMs: number,
  options: Partial<SportsObservation> = {},
): SportsObservation => ({
  id: `${descriptor.id}:${providerEventId}:${options.revision ?? 0}`,
  sourceId: descriptor.id,
  sourceLabel: descriptor.label,
  authority: descriptor.authority,
  capabilities: [...descriptor.capabilities],
  providerEventId,
  revision: 0,
  correction: false,
  timestampQuality: 'provider',
  sourceTimestampMs,
  receivedTimestampMs,
  monotonicReceivedMs: receivedTimestampMs,
  state: {
    eventId: 'game',
    sport: 'basketball',
    sourceTimestampMs,
    period: 'Q4',
    clock: '0:10',
    homeScore: 100,
    awayScore: 99,
    status: 'live',
  },
  rawSchemaVersion: 'test-v1',
  ...options,
});

describe('sports source orchestration', () => {
  it('prefers detailed fresh truth and deterministically fails over when it becomes stale', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed, backup]);
    orchestrator.ingest(observation(detailed, 'official-1', 9_000, 9_100));
    orchestrator.ingest(observation(backup, 'backup-1', 9_500, 9_600));
    expect(orchestrator.selection(10_000)?.descriptor.id).toBe('official');

    orchestrator.ingest(observation(backup, 'backup-2', 21_000, 21_100));
    expect(orchestrator.selection(22_000)?.descriptor.id).toBe('backup');
    expect(orchestrator.states(22_000).at(-1)?.sourceTimestampMs).toBe(21_000);
  });

  it('deduplicates revisions, reports out-of-order delivery, and bounds retained history', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed], { maxItems: 2 });
    const latest = observation(detailed, 'p2', 2_000, 2_100);
    expect(orchestrator.ingest(latest)).toMatchObject({ accepted: true, outOfOrder: false });
    expect(orchestrator.ingest(latest)).toMatchObject({ accepted: false, duplicate: true });
    expect(orchestrator.ingest(observation(detailed, 'p1', 1_000, 1_100))).toMatchObject({
      accepted: true,
      outOfOrder: true,
    });
    expect(orchestrator.ingest(observation(detailed, 'p3', 3_000, 3_100)).pruned).toBe(1);
    expect(orchestrator.all()).toHaveLength(2);
  });

  it('replaces corrected revisions without backfilling the correction before receipt', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed]);
    orchestrator.ingest(observation(detailed, 'play-1', 10_000, 10_200));
    const corrected = observation(detailed, 'play-1', 10_000, 14_000, {
      id: 'official:play-1:1',
      revision: 1,
      correction: true,
      state: {
        eventId: 'game',
        sport: 'basketball',
        sourceTimestampMs: 10_000,
        period: 'Q4',
        clock: '0:10',
        homeScore: 103,
        awayScore: 99,
        status: 'live',
      },
    });
    expect(orchestrator.ingest(corrected)).toMatchObject({ accepted: true, correction: true });
    expect(orchestrator.all()).toHaveLength(1);
    expect(orchestrator.states(14_000)[0]).toMatchObject({
      homeScore: 103,
      sourceTimestampMs: 14_000,
    });
  });

  it('rejects score rollback unless a provider marks a newer revision as a correction', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed]);
    orchestrator.ingest(observation(detailed, 'p1', 10_000, 10_100));
    expect(() =>
      orchestrator.ingest(
        observation(detailed, 'p2', 11_000, 11_100, {
          state: {
            eventId: 'game',
            sport: 'basketball',
            sourceTimestampMs: 11_000,
            homeScore: 99,
            awayScore: 99,
            status: 'live',
          },
        }),
      ),
    ).toThrow('requires an explicit correction');
  });

  it('holds a marginally better challenger to prevent source flapping', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed, backup], {
      switchMargin: 0,
      switchHoldMs: 5_000,
    });
    orchestrator.ingest(observation(backup, 'backup-1', 9_700, 9_800));
    expect(orchestrator.selection(10_000)?.descriptor.id).toBe('backup');
    orchestrator.ingest(observation(detailed, 'official-1', 10_000, 10_100));
    expect(orchestrator.selection(10_200)).toMatchObject({
      descriptor: { id: 'backup' },
      reason: 'hysteresis',
      switched: false,
    });
    expect(orchestrator.selection(15_300)).toMatchObject({
      descriptor: { id: 'official' },
      reason: 'quality',
      switched: true,
    });
  });

  it('selects sources independently by capability', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed, backup]);
    orchestrator.ingest(observation(detailed, 'official-1', 10_000, 10_100));
    orchestrator.ingest(observation(backup, 'backup-1', 10_000, 10_050));
    expect(orchestrator.selectionFor('play_by_play', 10_200)?.descriptor.id).toBe('official');
    expect(orchestrator.selectionFor('scoreboard', 10_200)?.descriptor.id).toBe('official');
  });

  it('rejects unmarked period and clock regression and reports source disagreement', () => {
    const orchestrator = new SportsSourceOrchestrator([detailed, backup]);
    orchestrator.ingest(
      observation(detailed, 'official-1', 10_000, 10_100, {
        state: {
          eventId: 'game',
          sport: 'basketball',
          sourceTimestampMs: 10_000,
          period: 'Q4',
          clock: '0:10',
          clockDirection: 'down',
          homeScore: 100,
          awayScore: 99,
          status: 'live',
        },
      }),
    );
    expect(() =>
      orchestrator.ingest(
        observation(detailed, 'official-2', 11_000, 11_100, {
          state: {
            eventId: 'game',
            sport: 'basketball',
            sourceTimestampMs: 11_000,
            period: 'Q3',
            clock: '0:09',
            clockDirection: 'down',
            homeScore: 100,
            awayScore: 99,
            status: 'live',
          },
        }),
      ),
    ).toThrow('period regression');
    expect(
      orchestrator.ingest(
        observation(backup, 'backup-1', 10_000, 10_200, {
          state: {
            eventId: 'game',
            sport: 'basketball',
            sourceTimestampMs: 10_000,
            period: 'Q4',
            clock: '0:10',
            clockDirection: 'down',
            homeScore: 101,
            awayScore: 99,
            status: 'live',
          },
        }),
      ).disagreement,
    ).toBe(true);
  });
});
