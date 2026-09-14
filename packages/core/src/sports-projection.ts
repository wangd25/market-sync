import type { SportsState } from '@marketsync/shared-types';

export interface DelayedSportsProjection {
  state: SportsState | null;
  displayClock: string | null;
  estimated: boolean;
  stale: boolean;
  updateAgeMs: number | null;
}

const parseClockSeconds = (clock: string): number | null => {
  const normalized = clock.trim().replace(/['’]$/, '');
  if (/^\d+$/.test(normalized)) return Number(normalized) * 60;
  const parts = normalized.split(':').map(Number);
  if (parts.length !== 2 || parts.some((part) => !Number.isFinite(part))) return null;
  return (parts[0] ?? 0) * 60 + (parts[1] ?? 0);
};

const formatClockSeconds = (seconds: number): string => {
  const bounded = Math.max(0, Math.round(seconds));
  return `${Math.floor(bounded / 60)}:${String(bounded % 60).padStart(2, '0')}`;
};

/** Projects sports state through the same viewer-time cutoff used by the market projection. */
export const projectDelayedSportsState = (
  states: readonly SportsState[],
  viewerTimestampMs: number,
  staleAfterMs = 20_000,
): DelayedSportsProjection => {
  const visible = states
    .filter((candidate) => candidate.sourceTimestampMs <= viewerTimestampMs)
    .toSorted((a, b) => a.sourceTimestampMs - b.sourceTimestampMs);
  const latest = visible.at(-1);
  if (latest === undefined)
    return { state: null, displayClock: null, estimated: false, stale: false, updateAgeMs: null };
  const latestWith = <K extends keyof SportsState>(key: K): SportsState | undefined =>
    visible.findLast((candidate) => candidate[key] !== undefined);
  const periodState = latestWith('period');
  const clockState = latestWith('clock');
  const homeScoreState = latestWith('homeScore');
  const awayScoreState = latestWith('awayScore');
  const discreteState = latestWith('discreteState');
  const state: SportsState = {
    ...latest,
    ...(periodState?.period === undefined ? {} : { period: periodState.period }),
    ...(clockState?.clock === undefined ? {} : { clock: clockState.clock }),
    ...(clockState?.clockDirection === undefined
      ? {}
      : { clockDirection: clockState.clockDirection }),
    ...(homeScoreState?.homeScore === undefined ? {} : { homeScore: homeScoreState.homeScore }),
    ...(awayScoreState?.awayScore === undefined ? {} : { awayScore: awayScoreState.awayScore }),
    ...(discreteState?.discreteState === undefined
      ? {}
      : { discreteState: discreteState.discreteState }),
  };
  const updateAgeMs = Math.max(0, viewerTimestampMs - latest.sourceTimestampMs);
  const clockAgeMs =
    clockState === undefined
      ? updateAgeMs
      : Math.max(0, viewerTimestampMs - clockState.sourceTimestampMs);
  const parsedClock = state.clock === undefined ? null : parseClockSeconds(state.clock);
  const canInterpolate =
    state.status === 'live' &&
    state.clockDirection !== undefined &&
    parsedClock !== null &&
    clockAgeMs <= staleAfterMs;
  const displayClock = canInterpolate
    ? formatClockSeconds(
        parsedClock + (state.clockDirection === 'up' ? 1 : -1) * Math.floor(clockAgeMs / 1_000),
      )
    : (state.clock ?? null);
  return {
    state,
    displayClock,
    estimated: canInterpolate && clockAgeMs >= 1_000,
    stale: updateAgeMs > staleAfterMs,
    updateAgeMs,
  };
};
