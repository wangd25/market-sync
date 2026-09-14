import {
  sportsObservationSchema,
  type SportsFeedCapability,
  type SportsFeedDescriptor,
  type SportsObservation,
  type SportsSourceAuthority,
  type SportsState,
} from '@marketsync/shared-types';

export type { SportsFeedCapability, SportsFeedDescriptor } from '@marketsync/shared-types';

export type SportTimelineKind =
  'continuous_clock' | 'stop_clock' | 'discrete_event' | 'asynchronous';

export interface MatchResult {
  estimatedDelayMs: number | null;
  confidence: number;
  exactSynchronizationPossible: boolean;
  reasons: readonly string[];
}

export interface SportTimelineStrategy {
  kind: SportTimelineKind;
  match(reference: readonly SportsState[], observation: SportsState): MatchResult;
}

const scoreMatch = (candidate: SportsState, observation: SportsState): number => {
  let score = 0;
  if (candidate.period === observation.period) score += 2;
  if (candidate.clock === observation.clock) score += 1;
  if (candidate.homeScore === observation.homeScore) score += 2;
  if (candidate.awayScore === observation.awayScore) score += 2;
  return score;
};

const uniqueBest = (
  reference: readonly SportsState[],
  observation: SportsState,
): SportsState | null => {
  const ranked = reference
    .map((state) => ({ state, score: scoreMatch(state, observation) }))
    .sort((a, b) => b.score - a.score);
  if ((ranked[0]?.score ?? 0) < 5 || ranked[0]?.score === ranked[1]?.score) return null;
  return ranked[0]?.state ?? null;
};

export const continuousClockStrategy: SportTimelineStrategy = {
  kind: 'continuous_clock',
  match(reference, observation) {
    const match = uniqueBest(reference, observation);
    return match === null
      ? {
          estimatedDelayMs: null,
          confidence: 0.25,
          exactSynchronizationPossible: false,
          reasons: ['Clock and score state is not unique'],
        }
      : {
          estimatedDelayMs: observation.sourceTimestampMs - match.sourceTimestampMs,
          confidence: 0.85,
          exactSynchronizationPossible: true,
          reasons: ['Period, clock, and score uniquely matched'],
        };
  },
};

export const stopClockStrategy: SportTimelineStrategy = {
  kind: 'stop_clock',
  match(reference, observation) {
    const match = uniqueBest(reference, observation);
    const hasPossession = observation.discreteState?.['possession'] !== undefined;
    return match === null
      ? {
          estimatedDelayMs: null,
          confidence: 0.2,
          exactSynchronizationPossible: false,
          reasons: ['Matching clock alone is ambiguous during stoppages'],
        }
      : {
          estimatedDelayMs: observation.sourceTimestampMs - match.sourceTimestampMs,
          confidence: hasPossession ? 0.88 : 0.72,
          exactSynchronizationPossible: true,
          reasons: [
            hasPossession
              ? 'Clock, score, period, and possession matched'
              : 'Clock, score, and period matched without possession',
          ],
        };
  },
};

export const discreteEventStrategy: SportTimelineStrategy = {
  kind: 'discrete_event',
  match(reference, observation) {
    const sequence = observation.discreteState?.['sequence'];
    const match = reference.find((state) => state.discreteState?.['sequence'] === sequence);
    return match === undefined
      ? {
          estimatedDelayMs: null,
          confidence: 0.2,
          exactSynchronizationPossible: false,
          reasons: ['Discrete event sequence not found'],
        }
      : {
          estimatedDelayMs: observation.sourceTimestampMs - match.sourceTimestampMs,
          confidence: 0.9,
          exactSynchronizationPossible: true,
          reasons: ['Ordered discrete event matched'],
        };
  },
};

export const asynchronousStrategy: SportTimelineStrategy = {
  kind: 'asynchronous',
  match() {
    return {
      estimatedDelayMs: null,
      confidence: 0.2,
      exactSynchronizationPossible: false,
      reasons: ['Editorially asynchronous coverage supports conservative approximate delay only'],
    };
  },
};

const registry = new Map<string, SportTimelineStrategy>([
  ['soccer', continuousClockStrategy],
  ['hockey', continuousClockStrategy],
  ['basketball', stopClockStrategy],
  ['american_football', stopClockStrategy],
  ['tennis', discreteEventStrategy],
  ['baseball', discreteEventStrategy],
  ['volleyball', discreteEventStrategy],
  ['esports', discreteEventStrategy],
  ['golf', asynchronousStrategy],
  ['cycling', asynchronousStrategy],
]);

export const getSportTimelineStrategy = (sport: string): SportTimelineStrategy =>
  registry.get(sport.toLowerCase()) ?? asynchronousStrategy;

export interface CameraClockObservation {
  capturedAtMs: number;
  clock?: string;
  period?: string;
  homeScore?: number;
  awayScore?: number;
  confidence: number;
}

export interface CameraFrameSampler {
  start(): Promise<void>;
  stop(): void;
  observe(): AsyncIterable<CameraClockObservation>;
}

export interface CanonicalSportsEvent {
  id: string;
  league?: string;
  homeTeam: string;
  awayTeam: string;
  startTimestampMs: number;
  venue?: string;
}

export interface VendorSportsEventReference {
  league?: string;
  homeTeam: string;
  awayTeam: string;
  startTimestampMs?: number;
  venue?: string;
}

export interface CanonicalEventResolution {
  event: CanonicalSportsEvent;
  confidence: number;
  reasons: readonly string[];
}

const normalizedIdentity = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

/** Resolves a vendor event without silently choosing tied or weak candidates. */
export const resolveCanonicalSportsEvent = (
  reference: VendorSportsEventReference,
  candidates: readonly CanonicalSportsEvent[],
  startToleranceMs = 4 * 60 * 60 * 1_000,
): CanonicalEventResolution | null => {
  const ranked = candidates
    .map((event) => {
      const reasons: string[] = [];
      let score = 0;
      if (normalizedIdentity(event.homeTeam) === normalizedIdentity(reference.homeTeam)) {
        score += 0.35;
        reasons.push('home team matched');
      }
      if (normalizedIdentity(event.awayTeam) === normalizedIdentity(reference.awayTeam)) {
        score += 0.35;
        reasons.push('away team matched');
      }
      if (
        reference.league !== undefined &&
        event.league !== undefined &&
        normalizedIdentity(event.league) === normalizedIdentity(reference.league)
      ) {
        score += 0.1;
        reasons.push('league matched');
      }
      if (reference.startTimestampMs !== undefined) {
        const deltaMs = Math.abs(event.startTimestampMs - reference.startTimestampMs);
        if (deltaMs <= startToleranceMs) {
          score += 0.15 * (1 - deltaMs / startToleranceMs);
          reasons.push('start time matched');
        }
      }
      if (
        reference.venue !== undefined &&
        event.venue !== undefined &&
        normalizedIdentity(event.venue) === normalizedIdentity(reference.venue)
      ) {
        score += 0.05;
        reasons.push('venue matched');
      }
      return { event, confidence: Math.min(1, score), reasons };
    })
    .filter((candidate) => candidate.confidence >= 0.7)
    .toSorted(
      (left, right) =>
        right.confidence - left.confidence || left.event.id.localeCompare(right.event.id),
    );
  const best = ranked[0];
  if (best === undefined) return null;
  if (ranked[1] !== undefined && Math.abs(best.confidence - ranked[1].confidence) < 0.05)
    return null;
  return best;
};

export interface SportsFeedHealthSample {
  connected: boolean;
  updateAgeMs: number | null;
  invalidObservationCount: number;
}

/**
 * Scores provider suitability without trusting it as settlement authority. The result is intended
 * for source selection and failover; anti-spoiler projection still owns every visible field.
 */
export const scoreSportsFeed = (
  descriptor: SportsFeedDescriptor,
  health: SportsFeedHealthSample,
): number => {
  if (!health.connected) return 0;
  const capabilities = descriptor.capabilities;
  let score = 0.25;
  if (capabilities.has('scoreboard')) score += 0.15;
  if (capabilities.has('game_clock')) score += 0.12;
  if (capabilities.has('play_by_play')) score += 0.12;
  if (capabilities.has('wall_clock_timestamp')) score += 0.12;
  if (capabilities.has('ordered_sequence')) score += 0.08;
  if (capabilities.has('push_delivery')) score += 0.08;
  if (capabilities.has('replay_recovery')) score += 0.08;

  if (health.updateAgeMs === null) score -= 0.25;
  else {
    const toleratedAgeMs = Math.max(1_000, descriptor.expectedUpdateIntervalMs * 3);
    score -= Math.min(0.35, (health.updateAgeMs / toleratedAgeMs) * 0.2);
  }
  score -= Math.min(0.2, health.invalidObservationCount * 0.02);
  return Math.max(0, Math.min(1, score));
};

export interface SportsObservationIngestResult {
  accepted: boolean;
  duplicate: boolean;
  correction: boolean;
  outOfOrder: boolean;
  disagreement: boolean;
  pruned: number;
}

export interface SportsSourceSelection {
  descriptor: SportsFeedDescriptor;
  score: number;
  updateAgeMs: number;
  observationCount: number;
  reason: 'initial' | 'stable' | 'hysteresis' | 'quality' | 'stale_failover';
  switched: boolean;
}

export interface SportsSourceOrchestratorOptions {
  maxItems?: number;
  retentionMs?: number;
  switchMargin?: number;
  switchHoldMs?: number;
}

const authorityWeight: Record<SportsSourceAuthority, number> = {
  official: 0.2,
  licensed: 0.16,
  public_verified: 0.1,
  public_unverified: 0.04,
  market_corroboration: 0,
  fixture: 0.12,
};

const compareObservations = (left: SportsObservation, right: SportsObservation): number =>
  left.sourceTimestampMs - right.sourceTimestampMs ||
  left.receivedTimestampMs - right.receivedTimestampMs ||
  left.id.localeCompare(right.id);

const clockSeconds = (clock: string | undefined): number | null => {
  if (clock === undefined) return null;
  const parts = clock.split(':').map(Number);
  if (parts.some((part) => !Number.isFinite(part))) return null;
  if (parts.length === 1) return (parts[0] ?? 0) * 60;
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
};

const periodOrdinal = (period: string | undefined): number | null => {
  if (period === undefined) return null;
  const normalized = period.trim().toLowerCase();
  const direct = /^(?:q|quarter|period|set|inning)\s*(\d+)$/.exec(normalized);
  if (direct?.[1] !== undefined) return Number(direct[1]);
  if (normalized === '1h' || normalized === 'first half') return 1;
  if (normalized === '2h' || normalized === 'second half') return 2;
  const baseball = /^(?:top|bottom)\s+(\d+)$/.exec(normalized);
  if (baseball?.[1] !== undefined)
    return Number(baseball[1]) * 2 + (normalized.startsWith('bottom') ? 1 : 0);
  return null;
};

const incompatibleProgression = (
  previous: SportsObservation,
  next: SportsObservation,
): string | null => {
  if (next.correction || next.sourceTimestampMs < previous.sourceTimestampMs) return null;
  const previousPeriod = periodOrdinal(previous.state.period);
  const nextPeriod = periodOrdinal(next.state.period);
  if (previousPeriod !== null && nextPeriod !== null && nextPeriod < previousPeriod)
    return 'Sports period regression requires an explicit correction revision';
  if (previous.state.period !== next.state.period) return null;
  const previousClock = clockSeconds(previous.state.clock);
  const nextClock = clockSeconds(next.state.clock);
  if (previousClock === null || nextClock === null) return null;
  const direction = next.state.clockDirection ?? previous.state.clockDirection;
  if (direction === 'down' && nextClock > previousClock + 2)
    return 'Sports countdown clock regression requires an explicit correction revision';
  if (direction === 'up' && nextClock + 2 < previousClock)
    return 'Sports count-up clock regression requires an explicit correction revision';
  return null;
};

/**
 * Deterministically selects and fails over among normalized sports sources.
 * Corrections replace earlier revisions but become visible at correction receipt time.
 */
export class SportsSourceOrchestrator {
  private readonly descriptors = new Map<string, SportsFeedDescriptor>();
  private readonly observations: SportsObservation[] = [];
  private readonly identities = new Map<string, SportsObservation>();
  private readonly invalidCounts = new Map<string, number>();
  private readonly maxItems: number;
  private readonly retentionMs: number;
  private readonly switchMargin: number;
  private readonly switchHoldMs: number;
  private selectedSourceId: string | null = null;
  private challengerSourceId: string | null = null;
  private challengerSinceMs = 0;

  public constructor(
    descriptors: readonly SportsFeedDescriptor[],
    options: SportsSourceOrchestratorOptions = {},
  ) {
    for (const descriptor of descriptors) this.descriptors.set(descriptor.id, descriptor);
    this.maxItems = options.maxItems ?? 2_000;
    this.retentionMs = options.retentionMs ?? 6 * 60 * 60 * 1_000;
    this.switchMargin = options.switchMargin ?? 0.08;
    this.switchHoldMs = options.switchHoldMs ?? 5_000;
  }

  public ingest(candidate: SportsObservation): SportsObservationIngestResult {
    let observation: SportsObservation;
    try {
      observation = sportsObservationSchema.parse(candidate) as SportsObservation;
    } catch (error) {
      this.invalidCounts.set(
        candidate.sourceId,
        (this.invalidCounts.get(candidate.sourceId) ?? 0) + 1,
      );
      throw error;
    }
    const descriptor = this.descriptors.get(observation.sourceId);
    if (descriptor === undefined) throw new Error(`Unknown sports source: ${observation.sourceId}`);
    const identity = `${observation.sourceId}:${observation.providerEventId}`;
    const existing = this.identities.get(identity);
    if (existing !== undefined && observation.revision <= existing.revision)
      return {
        accepted: false,
        duplicate: true,
        correction: false,
        outOfOrder: false,
        disagreement: false,
        pruned: 0,
      };

    const correction = existing !== undefined || observation.correction;
    if (correction && !observation.correction) observation = { ...observation, correction: true };
    const latestForEvent = this.observations
      .filter(
        (item) =>
          item.sourceId === observation.sourceId &&
          item.state.eventId === observation.state.eventId,
      )
      .toSorted(compareObservations)
      .at(-1);
    const scoreRollback =
      latestForEvent !== undefined &&
      observation.sourceTimestampMs >= latestForEvent.sourceTimestampMs &&
      ((observation.state.homeScore !== undefined &&
        latestForEvent.state.homeScore !== undefined &&
        observation.state.homeScore < latestForEvent.state.homeScore) ||
        (observation.state.awayScore !== undefined &&
          latestForEvent.state.awayScore !== undefined &&
          observation.state.awayScore < latestForEvent.state.awayScore));
    if (scoreRollback && !correction) {
      this.invalidCounts.set(
        observation.sourceId,
        (this.invalidCounts.get(observation.sourceId) ?? 0) + 1,
      );
      throw new Error('Sports score rollback requires an explicit correction revision');
    }
    if (latestForEvent !== undefined) {
      const progressionError = incompatibleProgression(latestForEvent, observation);
      if (progressionError !== null) {
        this.invalidCounts.set(
          observation.sourceId,
          (this.invalidCounts.get(observation.sourceId) ?? 0) + 1,
        );
        throw new Error(progressionError);
      }
    }

    const disagreement = this.observations.some(
      (item) =>
        item.sourceId !== observation.sourceId &&
        item.state.eventId === observation.state.eventId &&
        (Math.abs(item.sourceTimestampMs - observation.sourceTimestampMs) <= 2_000 ||
          (item.state.period === observation.state.period &&
            item.state.clock !== undefined &&
            item.state.clock === observation.state.clock)) &&
        item.state.homeScore !== undefined &&
        item.state.awayScore !== undefined &&
        observation.state.homeScore !== undefined &&
        observation.state.awayScore !== undefined &&
        (item.state.homeScore !== observation.state.homeScore ||
          item.state.awayScore !== observation.state.awayScore),
    );

    const last = this.observations.at(-1);
    const outOfOrder = last !== undefined && compareObservations(observation, last) < 0;
    if (existing !== undefined) {
      const index = this.observations.findIndex((item) => item.id === existing.id);
      if (index >= 0) this.observations.splice(index, 1);
    }
    this.identities.set(identity, observation);
    this.observations.push(observation);
    this.observations.sort(compareObservations);
    const pruned = this.prune(observation.receivedTimestampMs);
    return { accepted: true, duplicate: false, correction, outOfOrder, disagreement, pruned };
  }

  public selectionFor(
    capability: SportsFeedCapability,
    nowMs: number,
  ): SportsSourceSelection | null {
    return this.select(nowMs, capability);
  }

  public selection(nowMs: number): SportsSourceSelection | null {
    return this.select(nowMs);
  }

  private select(nowMs: number, capability?: SportsFeedCapability): SportsSourceSelection | null {
    const candidates = [...this.descriptors.values()].flatMap((descriptor) => {
      if (capability !== undefined && !descriptor.capabilities.has(capability)) return [];
      const source = this.observations.filter((item) => item.sourceId === descriptor.id);
      const latest = source.toSorted(compareObservations).at(-1);
      if (latest === undefined) return [];
      const updateAgeMs = Math.max(0, nowMs - latest.receivedTimestampMs);
      const connected = updateAgeMs <= Math.max(10_000, descriptor.expectedUpdateIntervalMs * 6);
      const quality = scoreSportsFeed(descriptor, {
        connected,
        updateAgeMs,
        invalidObservationCount: this.invalidCounts.get(descriptor.id) ?? 0,
      });
      return [
        {
          descriptor,
          score: Math.min(1, quality + authorityWeight[descriptor.authority]),
          updateAgeMs,
          observationCount: source.length,
          reason: 'stable' as const,
          switched: false,
        },
      ];
    });
    const ordered = candidates.toSorted(
      (left, right) =>
        right.score - left.score ||
        left.updateAgeMs - right.updateAgeMs ||
        left.descriptor.id.localeCompare(right.descriptor.id),
    );
    const best = ordered[0];
    if (best === undefined) return null;
    if (capability !== undefined)
      return { ...best, reason: this.selectedSourceId === null ? 'initial' : 'quality' };
    if (this.selectedSourceId === null) {
      this.selectedSourceId = best.descriptor.id;
      return { ...best, reason: 'initial', switched: true };
    }
    const current = candidates.find(
      (candidate) => candidate.descriptor.id === this.selectedSourceId,
    );
    const currentStale =
      current !== undefined &&
      current.updateAgeMs > Math.max(10_000, current.descriptor.expectedUpdateIntervalMs * 6);
    if (current === undefined || currentStale) {
      const switched = best.descriptor.id !== this.selectedSourceId;
      this.selectedSourceId = best.descriptor.id;
      this.challengerSourceId = null;
      return { ...best, reason: switched ? 'stale_failover' : 'stable', switched };
    }
    if (
      best.descriptor.id === current.descriptor.id ||
      best.score < current.score + this.switchMargin
    ) {
      this.challengerSourceId = null;
      return { ...current, reason: 'stable', switched: false };
    }
    if (this.challengerSourceId !== best.descriptor.id) {
      this.challengerSourceId = best.descriptor.id;
      this.challengerSinceMs = nowMs;
      return { ...current, reason: 'hysteresis', switched: false };
    }
    if (nowMs - this.challengerSinceMs < this.switchHoldMs)
      return { ...current, reason: 'hysteresis', switched: false };
    this.selectedSourceId = best.descriptor.id;
    this.challengerSourceId = null;
    return { ...best, reason: 'quality', switched: true };
  }

  public states(nowMs: number): readonly SportsState[] {
    const selected = this.selection(nowMs);
    if (selected === null) return [];
    return this.observations
      .filter((observation) => observation.sourceId === selected.descriptor.id)
      .toSorted(compareObservations)
      .map((observation) => ({
        ...observation.state,
        // A correction must not be backfilled to the original event time before
        // the correction itself reached the client.
        sourceTimestampMs: observation.correction
          ? Math.max(observation.sourceTimestampMs, observation.receivedTimestampMs)
          : observation.sourceTimestampMs,
      }));
  }

  public all(): readonly SportsObservation[] {
    return this.observations.map((observation) => structuredClone(observation));
  }

  private prune(nowMs: number): number {
    const cutoffMs = nowMs - this.retentionMs;
    let pruned = 0;
    while (
      this.observations.length > 0 &&
      ((this.observations[0]?.receivedTimestampMs ?? nowMs) < cutoffMs ||
        this.observations.length > this.maxItems)
    ) {
      const removed = this.observations.shift();
      if (removed === undefined) break;
      const identity = `${removed.sourceId}:${removed.providerEventId}`;
      if (this.identities.get(identity)?.id === removed.id) this.identities.delete(identity);
      pruned += 1;
    }
    return pruned;
  }
}
