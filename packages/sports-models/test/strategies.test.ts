import { describe, expect, it } from 'vitest';
import { fixtures } from '@marketsync/fixtures';
import {
  asynchronousStrategy,
  getSportTimelineStrategy,
  scoreSportsFeed,
  resolveCanonicalSportsEvent,
  type SportsFeedDescriptor,
} from '../src';

describe('sport timeline strategy registry', () => {
  it('does not treat a repeated stop clock alone as unique', () => {
    const states = fixtures.basketball.sportsStates;
    const observation = {
      ...states[0]!,
      sourceTimestampMs: states[0]!.sourceTimestampMs + 20_000,
      homeScore: 0,
      awayScore: 0,
    };
    expect(
      getSportTimelineStrategy('basketball').match(states, observation)
        .exactSynchronizationPossible,
    ).toBe(false);
  });

  it('matches ordered discrete events', () => {
    const states = fixtures.tennis.sportsStates;
    const observation = { ...states[1]!, sourceTimestampMs: states[1]!.sourceTimestampMs + 20_000 };
    expect(
      getSportTimelineStrategy('tennis').match(states, observation).confidence,
    ).toBeGreaterThan(0.8);
  });

  it('reports asynchronous coverage as approximate only', () => {
    const result = asynchronousStrategy.match([], fixtures.soccer.sportsStates[0]!);
    expect(result.exactSynchronizationPossible).toBe(false);
    expect(result.estimatedDelayMs).toBeNull();
  });
});

describe('sports feed selection', () => {
  const detailedFeed: SportsFeedDescriptor = {
    id: 'detailed',
    label: 'Detailed live feed',
    authority: 'licensed',
    capabilities: new Set([
      'scoreboard',
      'game_clock',
      'play_by_play',
      'wall_clock_timestamp',
      'ordered_sequence',
      'push_delivery',
      'replay_recovery',
    ]),
    expectedUpdateIntervalMs: 2_000,
    commercialAccess: 'licensed',
  };

  it('prefers a fresh detailed source and rejects a disconnected source', () => {
    expect(
      scoreSportsFeed(detailedFeed, {
        connected: true,
        updateAgeMs: 750,
        invalidObservationCount: 0,
      }),
    ).toBeGreaterThan(0.9);
    expect(
      scoreSportsFeed(detailedFeed, {
        connected: false,
        updateAgeMs: 750,
        invalidObservationCount: 0,
      }),
    ).toBe(0);
  });

  it('degrades a stale or repeatedly invalid source', () => {
    const fresh = scoreSportsFeed(detailedFeed, {
      connected: true,
      updateAgeMs: 1_000,
      invalidObservationCount: 0,
    });
    const degraded = scoreSportsFeed(detailedFeed, {
      connected: true,
      updateAgeMs: 30_000,
      invalidObservationCount: 8,
    });
    expect(degraded).toBeLessThan(fresh - 0.3);
  });
});

describe('canonical sports event resolution', () => {
  it('uses teams, league, start time, and venue and rejects ambiguous matches', () => {
    const candidates = [
      {
        id: 'game-1',
        league: 'NBA',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Orlando Magic',
        startTimestampMs: 10_000,
        venue: 'TD Garden',
      },
      {
        id: 'game-2',
        league: 'NBA',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Miami Heat',
        startTimestampMs: 10_000,
      },
    ];
    const resolution = resolveCanonicalSportsEvent(
      {
        league: 'nba',
        homeTeam: 'Boston Celtics',
        awayTeam: 'Orlando Magic',
        startTimestampMs: 10_500,
        venue: 'TD Garden',
      },
      candidates,
    );
    expect(resolution?.event.id).toBe('game-1');
    expect(resolution?.confidence).toBeGreaterThan(0.9);
    expect(
      resolveCanonicalSportsEvent(
        { homeTeam: 'Boston Celtics', awayTeam: 'Unknown', startTimestampMs: 10_000 },
        candidates,
      ),
    ).toBeNull();
  });
});
