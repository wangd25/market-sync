import type { DelayedChartPoint } from '@marketsync/core';

export interface MarketReaction {
  change: number;
  direction: 'up' | 'down';
  windowMs: number;
  level: MarketMoveLevel;
}

export type MarketMoveLevel = 'quiet' | 'little' | 'notable' | 'large' | 'massive';

export interface MarketMoveRead {
  level: MarketMoveLevel;
  label: string;
  possibleEvent: string | null;
  confidence: 'low' | 'medium';
}

export const classifyMarketMove = (change: number): MarketMoveLevel => {
  const absolute = Math.abs(change);
  if (absolute < 0.01) return 'quiet';
  if (absolute < 0.025) return 'little';
  if (absolute < 0.06) return 'notable';
  if (absolute < 0.12) return 'large';
  return 'massive';
};

const sportFamily = (sport: string): string => sport.toLowerCase();

/**
 * A market move cannot prove which play occurred. This copy intentionally gives
 * broad, probabilistic possibilities; confirmed events come from play-by-play.
 */
export const inferMarketMove = (
  sport: string,
  change: number,
  direction: 'up' | 'down' | 'flat',
): MarketMoveRead => {
  const level = classifyMarketMove(change);
  if (level === 'quiet' || direction === 'flat')
    return { level: 'quiet', label: 'Quiet', possibleEvent: null, confidence: 'low' };
  const favorable = direction === 'up';
  const family = sportFamily(sport);
  const possibilities = /baseball|mlb/.test(family)
    ? {
        little: 'a ball, strike, foul, or routine out',
        notable: favorable
          ? 'a walk, hit, or runner advance'
          : 'a strikeout, out, or opponent threat',
        large: favorable
          ? 'an extra-base hit or run-scoring chance'
          : 'a rally-ending out or opponent run',
        massive: favorable
          ? 'an RBI, home run, or multi-run play'
          : 'an opponent home run or inning-changing play',
      }
    : /basketball|nba|wnba/.test(family)
      ? {
          little: 'a free throw or routine possession',
          notable: favorable ? 'a made basket or forced turnover' : 'a miss or turnover',
          large: favorable ? 'a scoring run or key foul' : 'an opponent run or foul trouble',
          massive: 'a decisive score, ejection, injury, or late-game swing',
        }
      : /soccer|football association|fifa|epl/.test(family)
        ? {
            little: 'territorial pressure, a foul, or set piece',
            notable: favorable ? 'a dangerous attack or shot' : 'an opponent chance or card',
            large: 'a penalty, red card, overturned call, or major chance',
            massive: 'a goal or match-changing decision',
          }
        : /tennis|atp|wta/.test(family)
          ? {
              little: 'a routine point or serve result',
              notable: 'break-point pressure or a momentum swing',
              large: 'a service break or set swing',
              massive: 'a set-deciding break, match point, or retirement',
            }
          : /hockey|nhl/.test(family)
            ? {
                little: 'a shot, faceoff, or possession change',
                notable: 'a power play or high-danger chance',
                large: 'a goal, major penalty, or goalie change',
                massive: 'a decisive goal or match-changing penalty',
              }
            : /football|nfl|cfb/.test(family)
              ? {
                  little: 'a routine gain, incomplete pass, or minor penalty',
                  notable: 'a first down, sack, red-zone chance, or turnover threat',
                  large: 'a touchdown, turnover, or major penalty',
                  massive: 'a decisive touchdown, turnover, or late-game swing',
                }
              : {
                  little: 'a routine phase of play',
                  notable: 'a meaningful possession or scoring chance',
                  large: 'a major scoring or penalty event',
                  massive: 'a match-changing event',
                };
  const label: Record<Exclude<MarketMoveLevel, 'quiet'>, string> = {
    little: 'Subtle move',
    notable: 'Noticeable move',
    large: 'Big move',
    massive: 'Massive move',
  };
  return {
    level,
    label: label[level],
    possibleEvent: `Possible: ${possibilities[level]}`,
    confidence: level === 'large' || level === 'massive' ? 'medium' : 'low',
  };
};

export const projectMarketReaction = (
  points: readonly DelayedChartPoint[],
  eventTimestampMs: number,
  viewerTimestampMs: number,
): MarketReaction | null => {
  const before = points.findLast((point) => point.timestampMs < eventTimestampMs);
  const after = points
    .filter(
      (point) =>
        point.timestampMs >= eventTimestampMs &&
        point.timestampMs <= Math.min(viewerTimestampMs, eventTimestampMs + 5_000),
    )
    .at(-1);
  if (before === undefined || after === undefined) return null;
  const change = after.probability - before.probability;
  const level = classifyMarketMove(change);
  if (level === 'quiet') return null;
  return {
    change,
    direction: change > 0 ? 'up' : 'down',
    windowMs: Math.max(1, after.timestampMs - before.timestampMs),
    level,
  };
};

export const formatReaction = (reaction: MarketReaction): string => {
  const points = Math.abs(reaction.change * 100).toFixed(1);
  const sign = reaction.direction === 'up' ? '+' : '−';
  return `${sign}${points} pts`;
};
