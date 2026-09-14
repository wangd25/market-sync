import {
  researchObservationSchema,
  type ResearchObservation,
  type SportsState,
} from '@marketsync/shared-types';

export interface ResearchSessionOptions {
  sessionId: string;
  maxItems?: number;
  retentionMs?: number;
}

export interface LatencyDistribution {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  worstMs: number | null;
}

export interface ResearchSessionSummary {
  sessionId: string;
  observationCount: number;
  counts: Record<ResearchObservation['kind'], number>;
  sportsProviderLatency: LatencyDistribution;
  approximateSportsLatencySamples: number;
  marketTransportLatency: LatencyDistribution;
  viewerBroadcastDelay: LatencyDistribution;
  currentDriftMs: number | null;
}

export interface ResearchSessionExport {
  schemaVersion: 'marketsync-research-v1';
  sessionId: string;
  exportedAtMs: number;
  summary: ResearchSessionSummary;
  observations: readonly ResearchObservation[];
}

const emptyCounts = (): Record<ResearchObservation['kind'], number> => ({
  market: 0,
  sports: 0,
  anchor: 0,
  broadcast_tap: 0,
  health: 0,
});

const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const sorted = values.toSorted((left, right) => left - right);
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1);
  return sorted[Math.max(0, index)] ?? null;
};

const distribution = (samples: readonly number[]): LatencyDistribution => ({
  samples: samples.length,
  medianMs: percentile(samples, 0.5),
  p95Ms: percentile(samples, 0.95),
  worstMs: samples.length === 0 ? null : Math.max(...samples),
});

const visibleTimestampMs = (observation: ResearchObservation): number => {
  if (observation.kind === 'market') return observation.tick.sourceTimestampMs;
  if (observation.kind === 'sports') return observation.observation.sourceTimestampMs;
  if (observation.kind === 'anchor') return observation.viewerTimestampMs;
  if (observation.kind === 'broadcast_tap')
    return observation.matchedSourceTimestampMs ?? observation.broadcastVisibleAtMs;
  return observation.recordedAtMs;
};

const exportableDiscreteKeys = new Set([
  'event',
  'description',
  'playId',
  'team',
  'possession',
  'sequence',
  'inning',
  'half',
  'outs',
  'count',
  'bases',
  'batter',
  'pitcher',
  'player',
  'set',
  'game',
  'point',
]);

const sanitizedSportsState = (state: SportsState): SportsState => {
  const discreteState = Object.fromEntries(
    Object.entries(state.discreteState ?? {}).filter(([key]) => exportableDiscreteKeys.has(key)),
  );
  const rest = { ...state };
  delete rest.discreteState;
  return Object.keys(discreteState).length === 0 ? rest : { ...rest, discreteState };
};

const sanitizeObservation = (observation: ResearchObservation): ResearchObservation => {
  if (observation.kind !== 'sports') return structuredClone(observation);
  return {
    ...structuredClone(observation),
    observation: {
      ...structuredClone(observation.observation),
      state: sanitizedSportsState(observation.observation.state),
    },
  };
};

/** A bounded normalized recorder. It never accepts or exports raw provider payloads. */
export class ResearchSessionRecorder {
  private readonly observations: ResearchObservation[] = [];
  private readonly ids = new Set<string>();
  private readonly maxItems: number;
  private readonly retentionMs: number;

  public constructor(private readonly options: ResearchSessionOptions) {
    this.maxItems = options.maxItems ?? 5_000;
    this.retentionMs = options.retentionMs ?? 6 * 60 * 60 * 1_000;
  }

  public record(candidate: ResearchObservation): boolean {
    const observation = researchObservationSchema.parse(candidate) as ResearchObservation;
    if (observation.sessionId !== this.options.sessionId)
      throw new Error('Research observation belongs to a different session');
    if (this.ids.has(observation.id)) return false;
    this.ids.add(observation.id);
    this.observations.push(observation);
    this.observations.sort(
      (left, right) =>
        left.recordedAtMs - right.recordedAtMs ||
        left.monotonicRecordedMs - right.monotonicRecordedMs ||
        left.id.localeCompare(right.id),
    );
    this.prune(observation.recordedAtMs);
    return true;
  }

  public all(): readonly ResearchObservation[] {
    return this.observations.map(sanitizeObservation);
  }

  public summary(viewerTimestampMs = Number.POSITIVE_INFINITY): ResearchSessionSummary {
    const visible = this.observations.filter(
      (observation) => visibleTimestampMs(observation) <= viewerTimestampMs,
    );
    const counts = emptyCounts();
    const providerLatencies: number[] = [];
    let approximateSportsLatencySamples = 0;
    const marketLatencies: number[] = [];
    const viewerDelays: number[] = [];
    for (const observation of visible) {
      counts[observation.kind] += 1;
      if (observation.kind === 'sports') {
        const latency =
          observation.observation.receivedTimestampMs - observation.observation.sourceTimestampMs;
        if (latency >= 0 && observation.observation.timestampQuality === 'provider')
          providerLatencies.push(latency);
        else if (observation.observation.timestampQuality === 'receipt_approximation')
          approximateSportsLatencySamples += 1;
      }
      if (observation.kind === 'market') {
        const latency = observation.tick.receivedTimestampMs - observation.tick.sourceTimestampMs;
        if (latency >= 0) marketLatencies.push(latency);
      }
      if (observation.kind === 'anchor') viewerDelays.push(observation.estimatedDelayMs);
      if (
        observation.kind === 'broadcast_tap' &&
        observation.matchedSourceTimestampMs !== undefined
      ) {
        const latency = observation.broadcastVisibleAtMs - observation.matchedSourceTimestampMs;
        if (latency >= 0) viewerDelays.push(latency);
      }
    }
    const anchorDelays = visible
      .filter((observation) => observation.kind === 'anchor')
      .map((observation) => observation.estimatedDelayMs)
      .slice(-9);
    const latestDelay = anchorDelays.at(-1);
    const medianDelay = percentile(anchorDelays, 0.5);
    return {
      sessionId: this.options.sessionId,
      observationCount: visible.length,
      counts,
      sportsProviderLatency: distribution(providerLatencies),
      approximateSportsLatencySamples,
      marketTransportLatency: distribution(marketLatencies),
      viewerBroadcastDelay: distribution(viewerDelays),
      currentDriftMs:
        latestDelay === undefined || medianDelay === null ? null : latestDelay - medianDelay,
    };
  }

  public export(exportedAtMs: number): ResearchSessionExport {
    return {
      schemaVersion: 'marketsync-research-v1',
      sessionId: this.options.sessionId,
      exportedAtMs,
      summary: this.summary(),
      observations: this.all(),
    };
  }

  public exportJsonl(): string {
    return this.all()
      .map((observation) => JSON.stringify(observation))
      .join('\n');
  }

  private prune(nowMs: number): void {
    const cutoffMs = nowMs - this.retentionMs;
    while (
      this.observations.length > 0 &&
      ((this.observations[0]?.recordedAtMs ?? nowMs) < cutoffMs ||
        this.observations.length > this.maxItems)
    ) {
      const removed = this.observations.shift();
      if (removed !== undefined) this.ids.delete(removed.id);
    }
  }
}
