import type { SportsState } from '@marketsync/shared-types';

export type DelayedSportsEventKind =
  'coverage' | 'period' | 'score' | 'status' | 'possession' | 'play';

export interface DelayedSportsEvent {
  id: string;
  sourceTimestampMs: number;
  kind: DelayedSportsEventKind;
  title: string;
  detail: string;
  period: string | null;
  clock: string | null;
  homeScore: number | null;
  awayScore: number | null;
}

export interface DelayedSportsEventOptions {
  homeLabel?: string;
  awayLabel?: string;
  limit?: number;
}

export type ScoringSide = 'home' | 'away';

/**
 * Finds the first confirmed score increase after a user arms guided sync.
 * Sparse provider states are merged in source order so a play without a full
 * scoreboard cannot erase the last known score.
 */
export const findNextScoreChange = (
  states: readonly SportsState[],
  afterSourceTimestampMs: number,
  side: ScoringSide,
): SportsState | null => {
  let homeScore: number | undefined;
  let awayScore: number | undefined;
  for (const state of states.toSorted(
    (left, right) => left.sourceTimestampMs - right.sourceTimestampMs,
  )) {
    const previousHome = homeScore;
    const previousAway = awayScore;
    if (state.homeScore !== undefined) homeScore = state.homeScore;
    if (state.awayScore !== undefined) awayScore = state.awayScore;
    if (state.sourceTimestampMs <= afterSourceTimestampMs) continue;
    const increased =
      side === 'home'
        ? previousHome !== undefined && homeScore !== undefined && homeScore > previousHome
        : previousAway !== undefined && awayScore !== undefined && awayScore > previousAway;
    if (increased) return state;
  }
  return null;
};

const readableToken = (value: unknown): string =>
  String(value)
    .replaceAll('_', ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

const scoreDetail = (state: SportsState): string => {
  if (state.homeScore === undefined || state.awayScore === undefined) return 'Score unavailable';
  return `${state.homeScore} — ${state.awayScore}`;
};

const eventTitle = (state: SportsState, fallback: string): string => {
  const description = state.discreteState?.['description'];
  if (typeof description === 'string' && description.length > 0) return description;
  const event = state.discreteState?.['event'];
  return typeof event === 'string' && event.length > 0 ? readableToken(event) : fallback;
};

const createEvent = (
  state: SportsState,
  kind: DelayedSportsEventKind,
  title: string,
  detail: string,
  suffix: string,
): DelayedSportsEvent => ({
  id: `${state.eventId}-${state.sourceTimestampMs}-${kind}-${suffix}`,
  sourceTimestampMs: state.sourceTimestampMs,
  kind,
  title,
  detail,
  period: state.period ?? null,
  clock: state.clock ?? null,
  homeScore: state.homeScore ?? null,
  awayScore: state.awayScore ?? null,
});

/**
 * Builds a semantic activity feed from only sports states at or before viewer time.
 * This keeps game updates on the same anti-spoiler cutoff as the chart and scoreboard.
 */
export const projectDelayedSportsEvents = (
  states: readonly SportsState[],
  viewerTimestampMs: number,
  options: DelayedSportsEventOptions = {},
): readonly DelayedSportsEvent[] => {
  const homeLabel = options.homeLabel ?? 'Home';
  const awayLabel = options.awayLabel ?? 'Away';
  const limit = Math.max(1, Math.floor(options.limit ?? 8));
  const visible = states
    .filter((state) => state.sourceTimestampMs <= viewerTimestampMs)
    .toSorted((left, right) => left.sourceTimestampMs - right.sourceTimestampMs);
  const events: DelayedSportsEvent[] = [];

  let effectiveState: SportsState | undefined;
  visible.forEach((rawState) => {
    const previous = effectiveState;
    const state: SportsState = {
      ...(previous ?? rawState),
      ...rawState,
      discreteState: {
        ...(previous?.discreteState ?? {}),
        ...(rawState.discreteState ?? {}),
      },
    };
    effectiveState = state;
    if (previous === undefined) {
      events.push(
        createEvent(
          state,
          'coverage',
          state.status === 'scheduled' ? 'Game coverage ready' : 'Broadcast window started',
          scoreDetail(state),
          'start',
        ),
      );
      return;
    }

    let homeDelta = 0;
    let awayDelta = 0;
    let scoreChanged = false;
    if (
      state.homeScore !== undefined &&
      state.awayScore !== undefined &&
      previous.homeScore !== undefined &&
      previous.awayScore !== undefined
    ) {
      homeDelta = state.homeScore - previous.homeScore;
      awayDelta = state.awayScore - previous.awayScore;
      scoreChanged = homeDelta !== 0 || awayDelta !== 0;
    }
    if (scoreChanged) {
      const scoringSide =
        homeDelta > awayDelta ? homeLabel : awayDelta > homeDelta ? awayLabel : 'Score';
      events.push(
        createEvent(
          state,
          'score',
          eventTitle(state, `${scoringSide} scored`),
          `${scoringSide} · ${scoreDetail(state)}`,
          'score',
        ),
      );
    }

    if (state.period !== undefined && state.period !== previous.period) {
      events.push(
        createEvent(state, 'period', `${state.period} begins`, scoreDetail(state), 'period'),
      );
    }

    if (state.status !== previous.status) {
      const titles: Partial<Record<SportsState['status'], string>> = {
        live: 'Play resumed',
        paused: 'Play paused',
        complete: 'Game ended',
      };
      events.push(
        createEvent(
          state,
          'status',
          titles[state.status] ?? `Game ${readableToken(state.status)}`,
          scoreDetail(state),
          state.status,
        ),
      );
    }

    // Only the raw update may introduce a play. Carrying the previous play
    // through a sparse scoreboard state would otherwise duplicate it.
    const explicitEvent = rawState.discreteState?.['event'];
    const playId = rawState.discreteState?.['playId'];
    const previousPlayId = previous.discreteState?.['playId'];
    const description = rawState.discreteState?.['description'];
    const previousDescription = previous.discreteState?.['description'];
    const isNewExplicitPlay =
      explicitEvent !== undefined &&
      (playId !== undefined
        ? playId !== previousPlayId
        : description !== undefined
          ? description !== previousDescription
          : explicitEvent !== previous.discreteState?.['event']);
    if (!scoreChanged && isNewExplicitPlay) {
      events.push(
        createEvent(
          state,
          'play',
          eventTitle(rawState, readableToken(explicitEvent)),
          scoreDetail(state),
          `event-${String(playId ?? explicitEvent)}`,
        ),
      );
    }

    const possession = state.discreteState?.['possession'];
    if (possession !== undefined && possession !== previous.discreteState?.['possession']) {
      const possessionLabel =
        possession === 'home'
          ? homeLabel
          : possession === 'away'
            ? awayLabel
            : readableToken(possession);
      events.push(
        createEvent(
          state,
          'possession',
          `${possessionLabel} possession`,
          state.period ?? scoreDetail(state),
          `possession-${String(possession)}`,
        ),
      );
    }

    const outs = state.discreteState?.['outs'];
    const previousOuts = previous.discreteState?.['outs'];
    if (typeof outs === 'number' && typeof previousOuts === 'number' && outs > previousOuts) {
      events.push(
        createEvent(
          state,
          'play',
          outs === 1 ? 'One out' : `${outs} outs`,
          `${state.period ?? 'In play'} · ${scoreDetail(state)}`,
          `outs-${outs}`,
        ),
      );
    }

    const point = state.discreteState?.['point'];
    if (point !== undefined && point !== previous.discreteState?.['point']) {
      const set = state.discreteState?.['set'];
      const game = state.discreteState?.['game'];
      const context = [
        set === undefined ? null : `Set ${set}`,
        game === undefined ? null : `Game ${game}`,
      ]
        .filter((value): value is string => value !== null)
        .join(' · ');
      events.push(
        createEvent(
          state,
          'play',
          `Point ${String(point)}`,
          context || scoreDetail(state),
          `point-${String(point)}`,
        ),
      );
    }
  });

  const priority: Record<DelayedSportsEventKind, number> = {
    score: 0,
    period: 1,
    status: 2,
    play: 3,
    possession: 4,
    coverage: 5,
  };
  return events
    .toSorted(
      (left, right) =>
        right.sourceTimestampMs - left.sourceTimestampMs ||
        priority[left.kind] - priority[right.kind],
    )
    .slice(0, limit);
};
