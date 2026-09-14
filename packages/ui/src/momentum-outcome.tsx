'use client';

import type { DelayedOutcomeProjection } from '@marketsync/core';
import { inferMarketMove } from './market-reaction';
import { RollingProbability } from './rolling-probability';

export type MarketDisplayMode = 'chart' | 'pulse';

export interface MomentumOutcomeProps {
  label: string;
  projection: DelayedOutcomeProjection;
  tone: 'blue' | 'red';
  displayMode: MarketDisplayMode;
  updateLabel: string;
  sport: string;
}

const formatProbability = (value: number | null, displayMode: MarketDisplayMode): string =>
  value === null ? '—' : `${Math.round(value * 100)}${displayMode === 'pulse' ? '%' : '¢'}`;

const formatCents = (value: number | null): string =>
  value === null ? '—' : `${Math.round(value * 100)}¢`;

const momentumCopy = (projection: DelayedOutcomeProjection): string => {
  const { momentum } = projection;
  if (momentum.direction === 'flat' || Math.abs(momentum.change) < 0.01) return 'Holding steady';
  const sign = momentum.direction === 'up' ? '+' : '−';
  const points = Math.abs(momentum.change * 100).toFixed(1);
  const seconds = Math.max(0.1, momentum.windowMs / 1_000).toFixed(
    momentum.windowMs < 1_000 ? 1 : 0,
  );
  return `${sign}${points} pts in ${seconds}s`;
};

export const MomentumOutcome = ({
  label,
  projection,
  tone,
  displayMode,
  updateLabel,
  sport,
}: MomentumOutcomeProps) => {
  const { momentum } = projection;
  const moveRead = inferMarketMove(sport, momentum.change, momentum.direction);
  const priceLabel = formatProbability(projection.currentPrice, displayMode);
  const rippleKey = `${momentum.lastChangedAtMs ?? 'none'}-${priceLabel}`;
  const showRipple = ['notable', 'large', 'massive'].includes(moveRead.level);
  return (
    <section
      className={`ms-outcome ${tone} momentum-${momentum.direction} move-${moveRead.level}`}
      aria-label={`${label} win probability ${priceLabel}`}
    >
      {!showRipple ? null : <i key={rippleKey} className="ms-outcome-ripple" aria-hidden="true" />}
      <span className="ms-outcome-label">{label}</span>
      <RollingProbability
        value={projection.currentPrice}
        suffix={displayMode === 'pulse' ? '%' : '¢'}
      />
      <div
        className={`ms-momentum-readout ${moveRead.level === 'quiet' ? 'flat' : momentum.direction}`}
      >
        <svg viewBox="0 0 20 16" aria-hidden="true">
          {momentum.direction === 'flat' ? (
            <path d="M3 8h14" />
          ) : (
            <path d="m2 12 5-5 4 3 7-7m-5 0h5v5" />
          )}
        </svg>
        <span>{momentumCopy(projection)}</span>
        {moveRead.level === 'quiet' ? null : <strong>{moveRead.label}</strong>}
      </div>
      {moveRead.possibleEvent === null ? null : (
        <p className="ms-move-inference">
          {moveRead.possibleEvent}
          <span>{moveRead.confidence} confidence · not confirmed</span>
        </p>
      )}
      {displayMode === 'chart' ? (
        <dl>
          <div>
            <dt>Bid</dt>
            <dd>{formatCents(projection.bestBid)}</dd>
          </div>
          <div>
            <dt>Ask</dt>
            <dd>{formatCents(projection.bestAsk)}</dd>
          </div>
          <div>
            <dt>Updated</dt>
            <dd>{updateLabel}</dd>
          </div>
        </dl>
      ) : null}
    </section>
  );
};
