'use client';

import type { DelayedSportsEvent } from '@marketsync/core';
import { formatReaction, type MarketReaction } from './market-reaction';

export interface PulseUpdateProps {
  event: DelayedSportsEvent | null;
  reaction: MarketReaction | null;
  marketLabel: string;
}

export const PulseUpdate = ({ event, reaction, marketLabel }: PulseUpdateProps) => (
  <section className="ms-pulse-update" aria-live="polite">
    <i aria-hidden="true" />
    <div>
      <span>Latest on your broadcast</span>
      <strong>{event?.title ?? 'Watching for the next game update'}</strong>
      <small>{event?.detail ?? 'Scores and market reactions will appear here.'}</small>
    </div>
    {reaction === null ? null : (
      <b className={`${reaction.direction} level-${reaction.level}`}>
        {marketLabel} {formatReaction(reaction)}
      </b>
    )}
  </section>
);
