import { describe, expect, it } from 'vitest';
import type { SportsFeedDescriptor, SportsObservation } from '@marketsync/shared-types';
import { ProviderNeutralSportsGateway, type GatewaySportsProvider } from '../src';

const descriptor: SportsFeedDescriptor = {
  id: 'licensed',
  label: 'Licensed source',
  authority: 'licensed',
  capabilities: new Set([
    'scoreboard',
    'game_clock',
    'play_by_play',
    'wall_clock_timestamp',
    'replay_recovery',
  ]),
  expectedUpdateIntervalMs: 1_000,
  commercialAccess: 'licensed',
};

const observation = (id: string, timestampMs: number): SportsObservation => ({
  id: `licensed:${id}`,
  sourceId: descriptor.id,
  sourceLabel: descriptor.label,
  authority: descriptor.authority,
  capabilities: [...descriptor.capabilities],
  providerEventId: id,
  revision: 0,
  correction: false,
  timestampQuality: 'provider',
  sourceTimestampMs: timestampMs,
  receivedTimestampMs: timestampMs + 100,
  monotonicReceivedMs: timestampMs,
  state: {
    eventId: 'canonical-1',
    sport: 'basketball',
    sourceTimestampMs: timestampMs,
    period: 'Q1',
    clock: '11:59',
    clockDirection: 'down',
    homeScore: 0,
    awayScore: 0,
    status: 'live',
  },
  rawSchemaVersion: 'test-v1',
});

const provider: GatewaySportsProvider = {
  descriptor,
  resolve() {
    return Promise.resolve([
      {
        id: 'canonical-1',
        league: 'NBA',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Orlando Magic',
        startTimestampMs: 10_000,
      },
    ]);
  },
  replay() {
    return Promise.resolve([observation('replay-1', 10_000)]);
  },
  subscribe() {
    return Promise.resolve(() => undefined);
  },
};

describe('provider-neutral sports gateway', () => {
  it('resolves canonical events, replays normalized observations, and selects by capability', async () => {
    const gateway = new ProviderNeutralSportsGateway([provider]);
    await expect(
      gateway.resolve({
        league: 'NBA',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Orlando Magic',
        startTimestampMs: 10_000,
      }),
    ).resolves.toMatchObject({ event: { id: 'canonical-1' } });
    await expect(gateway.replay('canonical-1')).resolves.toBe(1);
    expect(gateway.selectionFor('play_by_play', 10_200)?.descriptor.id).toBe('licensed');
    expect(gateway.snapshot(10_200).observations).toHaveLength(1);
  });
});
