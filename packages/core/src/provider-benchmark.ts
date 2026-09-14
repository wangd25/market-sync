import {
  researchObservationSchema,
  type ResearchObservation,
  type SportsObservation,
} from '@marketsync/shared-types';

export type BenchmarkSignalKind = 'scoreboard' | 'clock' | 'play_by_play';

export interface BenchmarkDistribution {
  samples: number;
  medianMs: number | null;
  p95Ms: number | null;
  worstMs: number | null;
}

export interface ProviderSignalBenchmark {
  sourceId: string;
  signal: BenchmarkSignalKind;
  observations: number;
  providerLatency: BenchmarkDistribution;
  approximateTimestampCount: number;
  missingEventRate: number | null;
  duplicateRate: number;
  correctionRate: number;
  outOfOrderRate: number;
}

export interface ProviderBenchmarkReport {
  schemaVersion: 'marketsync-provider-benchmark-v1';
  sessionIds: readonly string[];
  generatedAtMs: number;
  warning: string;
  signals: readonly ProviderSignalBenchmark[];
  disconnectDuration: BenchmarkDistribution;
  replayRecovery: BenchmarkDistribution;
  marketReaction: BenchmarkDistribution;
  viewerDrift: BenchmarkDistribution;
  scoreAgreementRate: number | null;
}

const percentile = (values: readonly number[], fraction: number): number | null => {
  if (values.length === 0) return null;
  const ordered = values.toSorted((left, right) => left - right);
  return (
    ordered[Math.min(ordered.length - 1, Math.max(0, Math.ceil(ordered.length * fraction) - 1))] ??
    null
  );
};

const distribution = (values: readonly number[]): BenchmarkDistribution => ({
  samples: values.length,
  medianMs: percentile(values, 0.5),
  p95Ms: percentile(values, 0.95),
  worstMs: values.length === 0 ? null : Math.max(...values),
});

const signalsFor = (observation: SportsObservation): readonly BenchmarkSignalKind[] => {
  const signals: BenchmarkSignalKind[] = [];
  if (observation.state.homeScore !== undefined || observation.state.awayScore !== undefined)
    signals.push('scoreboard');
  if (observation.state.clock !== undefined) signals.push('clock');
  if (observation.state.discreteState?.['event'] !== undefined) signals.push('play_by_play');
  return signals;
};

const playKey = (observation: SportsObservation): string => {
  const state = observation.state;
  const discrete = state.discreteState ?? {};
  return [
    state.eventId,
    state.period ?? '',
    state.clock ?? '',
    state.homeScore ?? '',
    state.awayScore ?? '',
    discrete['event'] ?? '',
    String(discrete['description'] ?? '')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .trim(),
  ].join(':');
};

/** Parses bounded sanitized JSONL and rejects the whole import on any malformed line. */
export const parseResearchJsonl = (
  input: string,
  maxItems = 50_000,
): readonly ResearchObservation[] => {
  const lines = input.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length > maxItems) throw new Error(`Research import exceeds ${maxItems} observations`);
  return lines.map((line, index) => {
    try {
      return researchObservationSchema.parse(JSON.parse(line) as unknown) as ResearchObservation;
    } catch (error) {
      throw new Error(`Invalid research observation on line ${index + 1}`, { cause: error });
    }
  });
};

export const analyzeResearchObservations = (
  input: readonly ResearchObservation[],
  generatedAtMs: number,
): ProviderBenchmarkReport => {
  const observations = input.map(
    (candidate) => researchObservationSchema.parse(candidate) as ResearchObservation,
  );
  const sports = observations.filter((item) => item.kind === 'sports');
  const playUniverse = new Set(
    sports
      .map((item) => item.observation)
      .filter((item) => signalsFor(item).includes('play_by_play'))
      .map(playKey),
  );
  const sources = [...new Set(sports.map((item) => item.observation.sourceId))].toSorted();
  const signalKinds: readonly BenchmarkSignalKind[] = ['scoreboard', 'clock', 'play_by_play'];
  const signals = sources.flatMap((sourceId) =>
    signalKinds.map((signal): ProviderSignalBenchmark => {
      const source = sports
        .map((item) => item.observation)
        .filter((item) => item.sourceId === sourceId && signalsFor(item).includes(signal));
      const trueLatencies = source
        .filter((item) => item.timestampQuality === 'provider')
        .map((item) => item.receivedTimestampMs - item.sourceTimestampMs)
        .filter((latency) => latency >= 0);
      const identities = new Set<string>();
      let duplicates = 0;
      let outOfOrder = 0;
      let lastSourceTimestampMs = Number.NEGATIVE_INFINITY;
      for (const item of source.toSorted(
        (left, right) => left.receivedTimestampMs - right.receivedTimestampMs,
      )) {
        const identity = `${item.providerEventId}:${item.revision}`;
        if (identities.has(identity)) duplicates += 1;
        identities.add(identity);
        if (item.sourceTimestampMs < lastSourceTimestampMs) outOfOrder += 1;
        lastSourceTimestampMs = Math.max(lastSourceTimestampMs, item.sourceTimestampMs);
      }
      const sourcePlays =
        signal === 'play_by_play'
          ? new Set(source.map((item) => playKey(item)))
          : new Set<string>();
      return {
        sourceId,
        signal,
        observations: source.length,
        providerLatency: distribution(trueLatencies),
        approximateTimestampCount: source.filter(
          (item) => item.timestampQuality === 'receipt_approximation',
        ).length,
        missingEventRate:
          signal !== 'play_by_play' || playUniverse.size === 0
            ? null
            : (playUniverse.size - sourcePlays.size) / playUniverse.size,
        duplicateRate: source.length === 0 ? 0 : duplicates / source.length,
        correctionRate:
          source.length === 0 ? 0 : source.filter((item) => item.correction).length / source.length,
        outOfOrderRate: source.length === 0 ? 0 : outOfOrder / source.length,
      };
    }),
  );

  const disconnectStarts = new Map<string, number>();
  const disconnectDurations: number[] = [];
  const recoveryDurations: number[] = [];
  for (const item of observations.toSorted(
    (left, right) => left.recordedAtMs - right.recordedAtMs,
  )) {
    if (item.kind === 'health') {
      if (!item.health.connected && !disconnectStarts.has(item.sourceId))
        disconnectStarts.set(item.sourceId, item.recordedAtMs);
      if (item.health.connected) {
        const startedAtMs = disconnectStarts.get(item.sourceId);
        if (startedAtMs !== undefined) disconnectDurations.push(item.recordedAtMs - startedAtMs);
      }
    }
    if (item.kind === 'sports') {
      const startedAtMs = disconnectStarts.get(item.observation.sourceId);
      if (startedAtMs !== undefined) {
        recoveryDurations.push(item.recordedAtMs - startedAtMs);
        disconnectStarts.delete(item.observation.sourceId);
      }
    }
  }

  const markets = observations
    .filter(
      (item): item is Extract<ResearchObservation, { kind: 'market' }> =>
        item.kind === 'market' && item.tick.price !== undefined,
    )
    .toSorted((left, right) => left.tick.sourceTimestampMs - right.tick.sourceTimestampMs);
  const reactions: number[] = [];
  for (const item of sports) {
    if (!signalsFor(item.observation).includes('play_by_play')) continue;
    const candidateIndex = markets.findIndex(
      (market, index) =>
        market.tick.sourceTimestampMs >= item.observation.sourceTimestampMs &&
        market.tick.sourceTimestampMs - item.observation.sourceTimestampMs <= 60_000 &&
        index > 0 &&
        Math.abs((market.tick.price ?? 0) - (markets[index - 1]?.tick.price ?? 0)) >= 0.01,
    );
    const reaction = candidateIndex < 0 ? undefined : markets[candidateIndex];
    if (reaction !== undefined)
      reactions.push(reaction.tick.sourceTimestampMs - item.observation.sourceTimestampMs);
  }

  const anchors = observations
    .filter((item) => item.kind === 'anchor')
    .toSorted((left, right) => left.recordedAtMs - right.recordedAtMs);
  const drift = anchors
    .slice(1)
    .map((item, index) =>
      Math.abs(item.estimatedDelayMs - (anchors[index]?.estimatedDelayMs ?? item.estimatedDelayMs)),
    );

  const scoreGroups = new Map<string, Set<string>>();
  for (const item of sports) {
    const state = item.observation.state;
    if (state.homeScore === undefined || state.awayScore === undefined) continue;
    const key = `${state.eventId}:${state.period ?? ''}:${state.clock ?? ''}`;
    const values = scoreGroups.get(key) ?? new Set<string>();
    values.add(`${state.homeScore}:${state.awayScore}`);
    scoreGroups.set(key, values);
  }
  const comparableScores = [...scoreGroups.values()].filter((values) => values.size > 0);
  const agreements = comparableScores.filter((values) => values.size === 1).length;

  return {
    schemaVersion: 'marketsync-provider-benchmark-v1',
    sessionIds: [...new Set(observations.map((item) => item.sessionId))].toSorted(),
    generatedAtMs,
    warning:
      'Results describe only the supplied normalized sessions and are not a general provider latency claim.',
    signals,
    disconnectDuration: distribution(disconnectDurations),
    replayRecovery: distribution(recoveryDurations),
    marketReaction: distribution(reactions),
    viewerDrift: distribution(drift),
    scoreAgreementRate: comparableScores.length === 0 ? null : agreements / comparableScores.length,
  };
};

export const providerBenchmarkMarkdown = (report: ProviderBenchmarkReport): string => {
  const rows = report.signals.map((signal) =>
    [
      signal.sourceId,
      signal.signal,
      signal.observations,
      signal.providerLatency.medianMs ?? '—',
      signal.providerLatency.p95Ms ?? '—',
      signal.providerLatency.worstMs ?? '—',
      signal.approximateTimestampCount,
      signal.missingEventRate === null ? '—' : `${(signal.missingEventRate * 100).toFixed(1)}%`,
      `${(signal.correctionRate * 100).toFixed(1)}%`,
      `${(signal.outOfOrderRate * 100).toFixed(1)}%`,
    ].join(' | '),
  );
  return [
    '# MarketSync provider benchmark',
    '',
    `> ${report.warning}`,
    '',
    'Source | Signal | Samples | p50 ms | p95 ms | Worst ms | Approx. timestamps | Missing | Corrections | Out of order',
    '--- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---:',
    ...rows,
    '',
    `Score agreement: ${report.scoreAgreementRate === null ? 'not measurable' : `${(report.scoreAgreementRate * 100).toFixed(1)}%`}`,
    `Disconnect p95: ${report.disconnectDuration.p95Ms ?? '—'} ms`,
    `Replay recovery p95: ${report.replayRecovery.p95Ms ?? '—'} ms`,
    `Market reaction p95: ${report.marketReaction.p95Ms ?? '—'} ms`,
    `Viewer drift p95: ${report.viewerDrift.p95Ms ?? '—'} ms`,
    '',
  ].join('\n');
};
