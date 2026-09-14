export interface PendingVideoAnchor {
  delayMs: number;
  confidence: number;
  method: 'program-date-time';
  detectedAtMs: number;
}

export interface ConfirmedVideoAnchorPlan {
  viewerTimestampMs: number;
  rawDelayMs: number;
  confidence: number;
  previousDelayMs: number;
  method: 'program-date-time';
}

export const createPendingVideoAnchor = (
  delayMs: number,
  confidence: number,
  detectedAtMs: number,
): PendingVideoAnchor => {
  if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > 6 * 60 * 60 * 1_000)
    throw new RangeError('Pending video delay is outside the six-hour window');
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)
    throw new RangeError('Pending video confidence must be between 0 and 1');
  return { delayMs, confidence, detectedAtMs, method: 'program-date-time' };
};

export const planConfirmedVideoAnchor = (
  pending: PendingVideoAnchor,
  observedAtMs: number,
  previousDelayMs: number,
): ConfirmedVideoAnchorPlan => ({
  viewerTimestampMs: observedAtMs - pending.delayMs,
  rawDelayMs: pending.delayMs,
  confidence: pending.confidence,
  previousDelayMs,
  method: pending.method,
});
