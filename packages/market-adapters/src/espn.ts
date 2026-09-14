import type { SportsState } from '@marketsync/shared-types';
import { z } from 'zod';
import { classifyProviderError } from './errors';
import { browserSafeFetch, type Fetcher } from './fetcher';

const stringOrNumber = z.union([z.string(), z.number()]).transform(String);

const competitorSchema = z.object({
  homeAway: z.enum(['home', 'away']),
  score: stringOrNumber.optional(),
  team: z.object({ displayName: z.string() }),
});

const competitionSchema = z.object({
  date: z.string().optional(),
  competitors: z.array(competitorSchema),
  status: z
    .object({
      clock: z.number().optional(),
      displayClock: z.string().optional(),
      period: z.number().optional(),
      type: z.object({
        state: z.enum(['pre', 'in', 'post']).optional(),
        description: z.string().optional(),
        detail: z.string().optional(),
      }),
    })
    .optional(),
});

const scoreboardSchema = z.object({
  events: z.array(
    z.object({
      id: stringOrNumber,
      name: z.string(),
      date: z.string(),
      competitions: z.array(competitionSchema).min(1),
    }),
  ),
});

const playSchema = z.object({
  id: stringOrNumber.optional(),
  text: z.string().optional(),
  shortText: z.string().optional(),
  wallclock: z.string().optional(),
  type: z.object({ text: z.string().optional(), type: z.string().optional() }).optional(),
  period: z.object({ number: z.number().optional() }).optional(),
  clock: z
    .object({
      value: z.number().optional(),
      displayValue: z.string().optional(),
    })
    .optional(),
  team: z.object({ displayName: z.string().optional() }).optional(),
  homeScore: stringOrNumber.optional(),
  awayScore: stringOrNumber.optional(),
});

const commentarySchema = z.object({
  sequence: z.union([z.string(), z.number()]).optional(),
  text: z.string().optional(),
  play: playSchema.optional(),
  time: z.object({ value: z.number().optional(), displayValue: z.string().optional() }).optional(),
});

const summarySchema = z.object({
  header: z.object({
    competitions: z.array(competitionSchema).min(1),
  }),
  commentary: z.array(commentarySchema).optional().default([]),
  plays: z.array(playSchema).optional().default([]),
});

export interface EspnEventReference {
  sport: string;
  league?: string;
  startTimestampMs?: number;
  homeTeam?: string;
  awayTeam?: string;
}

interface EspnRoute {
  sport: string;
  league: string;
}

const routeFor = (reference: EspnEventReference): EspnRoute | null => {
  const value = `${reference.sport} ${reference.league ?? ''}`.toLowerCase();
  if (/fifwc|fifa world|world cup/.test(value)) return { sport: 'soccer', league: 'fifa.world' };
  if (/epl|premier league/.test(value)) return { sport: 'soccer', league: 'eng.1' };
  if (/la liga|laliga|soccer-esp/.test(value)) return { sport: 'soccer', league: 'esp.1' };
  if (/bundesliga|soccer-ger/.test(value)) return { sport: 'soccer', league: 'ger.1' };
  if (/serie a|soccer-ita/.test(value)) return { sport: 'soccer', league: 'ita.1' };
  if (/ligue 1|soccer-fra/.test(value)) return { sport: 'soccer', league: 'fra.1' };
  if (/champions league|uefa-champions/.test(value))
    return { sport: 'soccer', league: 'uefa.champions' };
  if (/mls|major league soccer/.test(value)) return { sport: 'soccer', league: 'usa.1' };
  if (/soccer|football association/.test(value)) return null;
  if (/wnba/.test(value)) return { sport: 'basketball', league: 'wnba' };
  if (/nba/.test(value)) return { sport: 'basketball', league: 'nba' };
  if (/ncaab|college basketball|cbb/.test(value))
    return { sport: 'basketball', league: 'mens-college-basketball' };
  if (/mlb|baseball/.test(value)) return { sport: 'baseball', league: 'mlb' };
  if (/nfl/.test(value)) return { sport: 'football', league: 'nfl' };
  if (/cfb|college football/.test(value)) return { sport: 'football', league: 'college-football' };
  if (/nhl|hockey/.test(value)) return { sport: 'hockey', league: 'nhl' };
  return null;
};

const normalizedTeam = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]/g, '');

const dateKey = (timestampMs: number): string => {
  const date = new Date(timestampMs);
  return `${date.getUTCFullYear()}${String(date.getUTCMonth() + 1).padStart(2, '0')}${String(
    date.getUTCDate(),
  ).padStart(2, '0')}`;
};

const teamNames = (competition: z.infer<typeof competitionSchema>) => ({
  home: competition.competitors.find((team) => team.homeAway === 'home')?.team.displayName,
  away: competition.competitors.find((team) => team.homeAway === 'away')?.team.displayName,
});

const teamMatches = (candidate: string | undefined, expected: string | undefined): boolean => {
  if (expected === undefined) return true;
  if (candidate === undefined) return false;
  const candidateKey = normalizedTeam(candidate);
  const expectedKey = normalizedTeam(expected);
  return (
    candidateKey === expectedKey ||
    candidateKey.includes(expectedKey) ||
    expectedKey.includes(candidateKey)
  );
};

const gameStatus = (competition: z.infer<typeof competitionSchema>): SportsState['status'] => {
  const state = competition.status?.type.state;
  if (state === 'pre') return 'scheduled';
  if (state === 'post') return 'complete';
  if (state === 'in')
    return /half[- ]?time|break|delay|suspend/i.test(competition.status?.type.description ?? '')
      ? 'paused'
      : 'live';
  return 'unknown';
};

const soccerPeriod = (period: number | undefined): string | undefined => {
  if (period === 1) return '1H';
  if (period === 2) return '2H';
  if (period === 3) return 'ET 1';
  if (period === 4) return 'ET 2';
  return period === undefined ? undefined : `Period ${period}`;
};

const elapsedClock = (seconds: number): string => {
  const bounded = Math.max(0, Math.floor(seconds));
  return `${Math.floor(bounded / 60)}:${String(bounded % 60).padStart(2, '0')}`;
};

const finiteScore = (value: string | undefined): number | undefined => {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
};

const normalizeDescription = (value: string): string =>
  value
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

const periodLabel = (sport: string, period: number | undefined): string | undefined => {
  if (period === undefined) return undefined;
  if (sport === 'soccer') return soccerPeriod(period);
  if (sport === 'basketball') return period <= 4 ? `Q${period}` : `OT${period - 4}`;
  if (sport === 'football') return period <= 4 ? `Q${period}` : `OT${period - 4}`;
  if (sport === 'hockey') return period <= 3 ? `P${period}` : `OT${period - 3}`;
  if (sport === 'baseball') return `Inning ${period}`;
  return `Period ${period}`;
};

const clockDirection = (sport: string): 'up' | 'down' => (sport === 'soccer' ? 'up' : 'down');

const scoreboardState = (
  eventId: string,
  route: EspnRoute,
  competition: z.infer<typeof competitionSchema>,
  receivedTimestampMs: number,
): SportsState => {
  const home = competition.competitors.find((team) => team.homeAway === 'home');
  const away = competition.competitors.find((team) => team.homeAway === 'away');
  const homeScore = finiteScore(home?.score);
  const awayScore = finiteScore(away?.score);
  const period = periodLabel(route.sport, competition.status?.period);
  const rawClock = competition.status?.clock;
  const clock =
    route.sport === 'soccer' && rawClock !== undefined
      ? elapsedClock(rawClock)
      : competition.status?.displayClock;
  return {
    eventId,
    sport: route.sport,
    sourceTimestampMs: receivedTimestampMs,
    status: gameStatus(competition),
    ...(period === undefined ? {} : { period }),
    ...(clock === undefined ? {} : { clock, clockDirection: clockDirection(route.sport) }),
    ...(homeScore === undefined ? {} : { homeScore }),
    ...(awayScore === undefined ? {} : { awayScore }),
    ...(home?.team.displayName === undefined ? {} : { homeTeam: home.team.displayName }),
    ...(away?.team.displayName === undefined ? {} : { awayTeam: away.team.displayName }),
  };
};

export interface EspnLiveFeed {
  scoreboard: SportsState;
  plays: readonly SportsState[];
}

/**
 * Best-effort, credential-free ESPN Gamecast reader. ESPN does not document this
 * response as a public developer contract, so every response is runtime validated
 * and failures leave the Polymarket scoreboard path in place.
 */
export class EspnPublicSportsAdapter {
  private readonly eventIds = new Map<string, string>();

  public constructor(private readonly fetcher: Fetcher = browserSafeFetch) {}

  private async json(url: string): Promise<unknown> {
    try {
      const response = await this.fetcher(url);
      if (!response.ok) throw new Error(`ESPN public feed returned ${response.status}.`);
      return response.json();
    } catch (error) {
      throw classifyProviderError(error);
    }
  }

  private cacheKey(reference: EspnEventReference, route: EspnRoute): string {
    return [
      route.sport,
      route.league,
      reference.startTimestampMs ?? 'today',
      normalizedTeam(reference.homeTeam ?? ''),
      normalizedTeam(reference.awayTeam ?? ''),
    ].join(':');
  }

  private async resolveEventId(
    reference: EspnEventReference,
    route: EspnRoute,
  ): Promise<string | null> {
    const key = this.cacheKey(reference, route);
    const cached = this.eventIds.get(key);
    if (cached !== undefined) return cached;
    const timestampMs = reference.startTimestampMs ?? Date.now();
    const dates = dateKey(timestampMs);
    const payload = scoreboardSchema.parse(
      await this.json(
        `https://site.api.espn.com/apis/site/v2/sports/${route.sport}/${route.league}/scoreboard?dates=${dates}`,
      ),
    );
    const event = payload.events.find((candidate) => {
      const competition = candidate.competitions[0];
      if (competition === undefined) return false;
      const names = teamNames(competition);
      return (
        teamMatches(names.home, reference.homeTeam) && teamMatches(names.away, reference.awayTeam)
      );
    });
    if (event === undefined) return null;
    this.eventIds.set(key, event.id);
    return event.id;
  }

  public async loadLiveFeed(
    reference: EspnEventReference,
    receivedTimestampMs = Date.now(),
  ): Promise<EspnLiveFeed | null> {
    const route = routeFor(reference);
    if (route === null) return null;
    const eventId = await this.resolveEventId(reference, route);
    if (eventId === null) return null;
    const summary = summarySchema.parse(
      await this.json(
        `https://site.api.espn.com/apis/site/v2/sports/${route.sport}/${route.league}/summary?event=${encodeURIComponent(eventId)}`,
      ),
    );
    const competition = summary.header.competitions[0];
    if (competition === undefined) return null;
    const status = gameStatus(competition);
    const rawPlays = [
      ...summary.commentary.map((item) => ({
        play: item.play ?? {
          text: item.text,
          clock: item.time,
        },
        sequence: item.sequence,
      })),
      ...summary.plays.map((play) => ({ play, sequence: play.id })),
    ];
    const seenIds = new Set<string>();
    const seenDescriptions = new Set<string>();
    const states: SportsState[] = [];
    for (const [index, item] of rawPlays.entries()) {
      const play = item.play;
      const description = play.text ?? play.shortText;
      const sourceTimestampMs = Date.parse(play.wallclock ?? '');
      if (description === undefined || !Number.isFinite(sourceTimestampMs)) continue;
      const playId = play.id ?? String(item.sequence ?? index);
      const period = periodLabel(route.sport, play.period?.number);
      const clock =
        route.sport === 'soccer' && play.clock?.value !== undefined
          ? elapsedClock(play.clock.value)
          : play.clock?.displayValue;
      const homeScore = finiteScore(play.homeScore);
      const awayScore = finiteScore(play.awayScore);
      const semanticKey = [
        normalizeDescription(description),
        period ?? '',
        clock ?? '',
        normalizeDescription(play.team?.displayName ?? ''),
      ].join('|');
      if (seenIds.has(playId) || seenDescriptions.has(semanticKey)) continue;
      seenIds.add(playId);
      seenDescriptions.add(semanticKey);
      states.push({
        eventId,
        sport: route.sport,
        sourceTimestampMs,
        status,
        ...(period === undefined ? {} : { period }),
        ...(clock === undefined ? {} : { clock }),
        ...(clock === undefined ? {} : { clockDirection: clockDirection(route.sport) }),
        ...(homeScore === undefined ? {} : { homeScore }),
        ...(awayScore === undefined ? {} : { awayScore }),
        discreteState: {
          event: play.type?.type ?? play.type?.text ?? 'play',
          description,
          playId,
          source: 'espn',
          ...(play.team?.displayName === undefined ? {} : { team: play.team.displayName }),
        },
      });
    }
    return {
      scoreboard: scoreboardState(eventId, route, competition, receivedTimestampMs),
      plays: states.toSorted((left, right) => left.sourceTimestampMs - right.sourceTimestampMs),
    };
  }

  public async loadPlayByPlay(reference: EspnEventReference): Promise<readonly SportsState[]> {
    return (await this.loadLiveFeed(reference))?.plays ?? [];
  }

  public async loadScoreboard(
    reference: EspnEventReference,
    receivedTimestampMs = Date.now(),
  ): Promise<SportsState | null> {
    const route = routeFor(reference);
    if (route === null) return null;
    const eventId = await this.resolveEventId(reference, route);
    if (eventId === null) return null;
    const dates = dateKey(reference.startTimestampMs ?? receivedTimestampMs);
    const payload = scoreboardSchema.parse(
      await this.json(
        `https://site.api.espn.com/apis/site/v2/sports/${route.sport}/${route.league}/scoreboard?dates=${dates}`,
      ),
    );
    const event = payload.events.find((candidate) => candidate.id === eventId);
    const competition = event?.competitions[0];
    if (competition === undefined) return null;
    return scoreboardState(eventId, route, competition, receivedTimestampMs);
  }
}
