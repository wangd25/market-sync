import type { SportsState } from '@marketsync/shared-types';

export type BaseballHalf = 'top' | 'bottom';
export type BaseballMoment = 'scoreboard' | 'run' | 'half-inning';

export interface BaseballObservation {
  inning: number;
  half: BaseballHalf;
  homeScore: number;
  awayScore: number;
  outs?: number;
  count?: string;
  moment: BaseballMoment;
}

export type BaseballCalibrationResult =
  | { kind: 'matched'; state: SportsState; estimatedDelayMs: number }
  | { kind: 'ambiguous'; candidateCount: number }
  | { kind: 'unavailable' }
  | { kind: 'out-of-range'; estimatedDelayMs: number };

const inningFrom = (state: SportsState): number | null => {
  const discrete = Number(state.discreteState?.['inning']);
  if (Number.isInteger(discrete) && discrete > 0) return discrete;
  const parsed = /(?:top|bot|bottom)\s*(\d+)/i.exec(state.period ?? '');
  return parsed?.[1] === undefined ? null : Number(parsed[1]);
};

const halfFrom = (state: SportsState): BaseballHalf | null => {
  const discrete = String(state.discreteState?.['half'] ?? '').toLowerCase();
  if (discrete === 'top' || discrete === 'bottom') return discrete;
  if (/^top/i.test(state.period ?? '')) return 'top';
  if (/^(?:bot|bottom)/i.test(state.period ?? '')) return 'bottom';
  return null;
};

const scoreChanged = (previous: SportsState | undefined, state: SportsState): boolean =>
  previous !== undefined &&
  (previous.homeScore !== state.homeScore || previous.awayScore !== state.awayScore);

const halfChanged = (previous: SportsState | undefined, state: SportsState): boolean =>
  previous !== undefined &&
  (inningFrom(previous) !== inningFrom(state) || halfFrom(previous) !== halfFrom(state));

const matchesObservation = (
  state: SportsState,
  previous: SportsState | undefined,
  observation: BaseballObservation,
): boolean => {
  if (inningFrom(state) !== observation.inning || halfFrom(state) !== observation.half)
    return false;
  if (state.homeScore !== observation.homeScore || state.awayScore !== observation.awayScore)
    return false;
  if (observation.outs !== undefined && Number(state.discreteState?.['outs']) !== observation.outs)
    return false;
  if (
    observation.count !== undefined &&
    observation.count !== '' &&
    String(state.discreteState?.['count'] ?? '') !== observation.count
  )
    return false;
  if (observation.moment === 'run' && !scoreChanged(previous, state)) return false;
  if (observation.moment === 'half-inning' && !halfChanged(previous, state)) return false;
  return true;
};

export const matchBaseballObservation = (
  states: readonly SportsState[],
  observation: BaseballObservation,
  observedAtMs: number,
  maximumDelayMs = 5 * 60_000,
): BaseballCalibrationResult => {
  const ordered = states
    .filter((state) => /baseball|mlb/i.test(state.sport))
    .toSorted((left, right) => left.sourceTimestampMs - right.sourceTimestampMs);
  const candidates = ordered.filter((state, index) =>
    matchesObservation(state, ordered[index - 1], observation),
  );
  if (candidates.length === 0) return { kind: 'unavailable' };
  if (candidates.length > 1) return { kind: 'ambiguous', candidateCount: candidates.length };
  const state = candidates[0];
  if (state === undefined) return { kind: 'unavailable' };
  const estimatedDelayMs = observedAtMs - state.sourceTimestampMs;
  if (estimatedDelayMs < 0 || estimatedDelayMs > maximumDelayMs)
    return { kind: 'out-of-range', estimatedDelayMs };
  return { kind: 'matched', state, estimatedDelayMs };
};

export const findNextBaseballRun = (
  states: readonly SportsState[],
  afterSourceTimestampMs: number,
  side: 'home' | 'away',
): SportsState | null => {
  const ordered = states
    .filter((state) => /baseball|mlb/i.test(state.sport))
    .toSorted((left, right) => left.sourceTimestampMs - right.sourceTimestampMs);
  for (let index = 1; index < ordered.length; index += 1) {
    const previous = ordered[index - 1];
    const state = ordered[index];
    if (
      previous === undefined ||
      state === undefined ||
      state.sourceTimestampMs <= afterSourceTimestampMs
    )
      continue;
    const previousScore = side === 'home' ? previous.homeScore : previous.awayScore;
    const nextScore = side === 'home' ? state.homeScore : state.awayScore;
    if (previousScore !== undefined && nextScore !== undefined && nextScore > previousScore)
      return state;
  }
  return null;
};
