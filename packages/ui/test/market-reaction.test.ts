import { describe, expect, it } from 'vitest';
import { classifyMarketMove, inferMarketMove, projectMarketReaction } from '../src/market-reaction';

describe('market move significance', () => {
  it('suppresses sub-point noise and grades progressively larger changes', () => {
    expect(classifyMarketMove(0.009)).toBe('quiet');
    expect(classifyMarketMove(0.01)).toBe('little');
    expect(classifyMarketMove(0.03)).toBe('notable');
    expect(classifyMarketMove(0.08)).toBe('large');
    expect(classifyMarketMove(0.14)).toBe('massive');
  });

  it('does not attach a reaction badge to a tiny post-play price movement', () => {
    expect(
      projectMarketReaction(
        [
          { timestampMs: 1_000, probability: 0.5 },
          { timestampMs: 3_000, probability: 0.507 },
        ],
        2_000,
        4_000,
      ),
    ).toBeNull();
  });

  it('labels sport reads as possibilities rather than confirmed play data', () => {
    const read = inferMarketMove('baseball', 0.14, 'up');
    expect(read).toMatchObject({ level: 'massive', confidence: 'medium' });
    expect(read.possibleEvent).toMatch(/^Possible: /);
  });
});
