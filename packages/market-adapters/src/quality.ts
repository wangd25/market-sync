import type { ProviderHealth } from '@marketsync/shared-types';

export interface ProviderQualityInput {
  contractMatchConfidence: number;
  ruleEquivalenceConfidence: number;
  lastUpdateAgeMs: number;
  spread?: number;
  availableDepth?: number;
  tradesPerMinute?: number;
  volume?: number;
  health: ProviderHealth;
  valueType: 'executable' | 'derived';
}

export interface ProviderQualityScore {
  score: number;
  reasons: readonly string[];
}

const clamp = (value: number): number => Math.max(0, Math.min(1, value));

export const scoreProviderQuality = (input: ProviderQualityInput): ProviderQualityScore => {
  const freshness = clamp(1 - input.lastUpdateAgeMs / 60_000);
  const spreadScore = input.spread === undefined ? 0.35 : clamp(1 - input.spread / 0.15);
  const depthScore = clamp((input.availableDepth ?? 0) / 10_000);
  const activityScore = clamp((input.tradesPerMinute ?? 0) / 20);
  const connectionScore = input.health.connected ? 1 : 0;
  const sourceScore =
    input.health.source === 'live' ? 1 : input.health.source === 'polling' ? 0.7 : 0.45;
  const score =
    input.contractMatchConfidence * 0.2 +
    input.ruleEquivalenceConfidence * 0.15 +
    freshness * 0.15 +
    spreadScore * 0.15 +
    depthScore * 0.08 +
    activityScore * 0.07 +
    connectionScore * 0.1 +
    sourceScore * 0.05 +
    (input.valueType === 'executable' ? 1 : 0.6) * 0.05;
  return {
    score: Math.round(clamp(score) * 100),
    reasons: [
      `Contract match ${Math.round(input.contractMatchConfidence * 100)}%`,
      `Rule equivalence ${Math.round(input.ruleEquivalenceConfidence * 100)}%`,
      `${input.health.source} source`,
      input.health.connected ? 'Connection healthy' : 'Connection unavailable',
      input.valueType === 'executable' ? 'Executable quote' : 'Derived value',
    ],
  };
};

export const CONTRACT_EQUIVALENCE_THRESHOLD = 0.85;

export const weightedComposite = (
  inputs: readonly { price: number; qualityScore: number; ruleEquivalenceConfidence: number }[],
): number | null => {
  if (
    inputs.length < 2 ||
    inputs.some((input) => input.ruleEquivalenceConfidence < CONTRACT_EQUIVALENCE_THRESHOLD)
  )
    return null;
  const totalWeight = inputs.reduce((sum, input) => sum + input.qualityScore, 0);
  if (totalWeight <= 0) return null;
  return inputs.reduce((sum, input) => sum + input.price * input.qualityScore, 0) / totalWeight;
};
