'use client';

import type { DelayedChartPoint, DelayedSportsEvent } from '@marketsync/core';
import { formatReaction, projectMarketReaction } from './market-reaction';

export interface SportsActivityFeedProps {
  events: readonly DelayedSportsEvent[];
  viewerTimestampMs: number;
  frozen: boolean;
  syncStatus: string;
  coverageLabel: string;
  marketLabel: string;
  marketPoints: readonly DelayedChartPoint[];
  onSyncEvent: (event: DelayedSportsEvent) => void;
}

const ageLabel = (viewerTimestampMs: number, eventTimestampMs: number): string => {
  const seconds = Math.max(0, Math.round((viewerTimestampMs - eventTimestampMs) / 1_000));
  if (seconds <= 1) return 'Now';
  if (seconds < 60) return `${seconds}s ago`;
  return `${Math.floor(seconds / 60)}m ago`;
};

const contextLabel = (event: DelayedSportsEvent): string => {
  const context = [event.period, event.clock].filter(
    (value): value is string => value !== null && value.length > 0,
  );
  if (event.homeScore !== null && event.awayScore !== null)
    context.push(`${event.homeScore} — ${event.awayScore}`);
  return context.join(' · ');
};

export const SportsActivityFeed = ({
  events,
  viewerTimestampMs,
  frozen,
  syncStatus,
  coverageLabel,
  marketLabel,
  marketPoints,
  onSyncEvent,
}: SportsActivityFeedProps) => {
  const tickerEvent = events[0] ?? null;

  return (
    <section className="ms-activity" aria-labelledby="ms-activity-title">
      <div className="ms-activity-head">
        <div>
          <h2 id="ms-activity-title">Broadcast updates</h2>
          <p>Delayed with the chart. Match a moment to what you see on your stream.</p>
        </div>
        <span className={frozen ? 'warning' : ''}>{frozen ? 'Held' : coverageLabel}</span>
      </div>
      {tickerEvent === null ? null : (
        <div className="ms-play-ticker" role="status" aria-live="polite" aria-atomic="true">
          <span>Live wire</span>
          <div key={tickerEvent.id}>
            <strong>{tickerEvent.title}</strong>
            <small>
              {tickerEvent.detail} · {contextLabel(tickerEvent)}
            </small>
          </div>
        </div>
      )}
      {events.length === 0 ? (
        <div className="ms-activity-empty">
          <i />
          <span>
            {coverageLabel === 'Limited coverage'
              ? 'This market has not supplied a scoreboard update yet. Price momentum remains available.'
              : 'Connecting to the public scoreboard and waiting for the first delayed update.'}
          </span>
        </div>
      ) : (
        <ol className="ms-activity-list">
          {events.map((event, index) => {
            const reaction = projectMarketReaction(
              marketPoints,
              event.sourceTimestampMs,
              viewerTimestampMs,
            );
            return (
              <li key={event.id} className={index === 0 ? 'latest' : ''}>
                <div className={`ms-activity-marker ${event.kind}`} aria-hidden="true">
                  <i />
                </div>
                <div className="ms-activity-copy">
                  <div>
                    <strong>{event.title}</strong>
                    <time dateTime={new Date(event.sourceTimestampMs).toISOString()}>
                      {ageLabel(viewerTimestampMs, event.sourceTimestampMs)}
                    </time>
                  </div>
                  <p>{event.detail}</p>
                  <small>{contextLabel(event)}</small>
                  {reaction === null ? null : (
                    <b
                      className={`ms-event-reaction ${reaction.direction} level-${reaction.level}`}
                    >
                      {marketLabel} {formatReaction(reaction)} after this update
                    </b>
                  )}
                </div>
                {index === 0 && !frozen ? (
                  <button type="button" onClick={() => onSyncEvent(event)}>
                    Sync when seen
                  </button>
                ) : null}
              </li>
            );
          })}
        </ol>
      )}
      <p className="ms-activity-status" role="status" aria-live="polite">
        {syncStatus}
      </p>
    </section>
  );
};
