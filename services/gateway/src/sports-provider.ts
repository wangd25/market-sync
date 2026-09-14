import type {
  SportsFeedDescriptor,
  SportsObservation,
  SportsFeedCapability,
} from '@marketsync/shared-types';
import {
  SportsSourceOrchestrator,
  resolveCanonicalSportsEvent,
  type CanonicalEventResolution,
  type CanonicalSportsEvent,
  type VendorSportsEventReference,
} from '@marketsync/sports-models';

/** Server-owned contract for licensed or public sports sources. Credentials stay in implementations. */
export interface GatewaySportsProvider {
  descriptor: SportsFeedDescriptor;
  resolve(reference: VendorSportsEventReference): Promise<readonly CanonicalSportsEvent[]>;
  replay(canonicalEventId: string, afterRevision?: number): Promise<readonly SportsObservation[]>;
  subscribe(
    canonicalEventId: string,
    listener: (observation: SportsObservation) => void,
  ): Promise<() => void>;
}

export interface GatewaySportsSnapshot {
  selection: ReturnType<SportsSourceOrchestrator['selection']>;
  scoreboardSelection: ReturnType<SportsSourceOrchestrator['selection']>;
  playByPlaySelection: ReturnType<SportsSourceOrchestrator['selection']>;
  observations: readonly SportsObservation[];
}

/**
 * Owns normalized source arbitration at the server boundary. It accepts no credentials and emits
 * no vendor payloads; provider implementations must normalize before calling ingest.
 */
export class ProviderNeutralSportsGateway {
  private readonly providers = new Map<string, GatewaySportsProvider>();
  private readonly orchestrator: SportsSourceOrchestrator;

  public constructor(providers: readonly GatewaySportsProvider[]) {
    for (const provider of providers) this.providers.set(provider.descriptor.id, provider);
    this.orchestrator = new SportsSourceOrchestrator(
      providers.map((provider) => provider.descriptor),
      { maxItems: 10_000, retentionMs: 6 * 60 * 60 * 1_000, switchHoldMs: 5_000 },
    );
  }

  public ingest(observation: SportsObservation) {
    if (!this.providers.has(observation.sourceId))
      throw new Error(`Unregistered gateway sports source: ${observation.sourceId}`);
    return this.orchestrator.ingest(observation);
  }

  public async resolve(
    reference: VendorSportsEventReference,
  ): Promise<CanonicalEventResolution | null> {
    const candidates = (
      await Promise.all([...this.providers.values()].map((provider) => provider.resolve(reference)))
    ).flat();
    return resolveCanonicalSportsEvent(reference, candidates);
  }

  public async replay(canonicalEventId: string): Promise<number> {
    const batches = await Promise.all(
      [...this.providers.values()]
        .filter((provider) => provider.descriptor.capabilities.has('replay_recovery'))
        .map((provider) => provider.replay(canonicalEventId)),
    );
    let accepted = 0;
    for (const observation of batches.flat()) {
      if (this.ingest(observation).accepted) accepted += 1;
    }
    return accepted;
  }

  public selectionFor(capability: SportsFeedCapability, nowMs: number) {
    return this.orchestrator.selectionFor(capability, nowMs);
  }

  public snapshot(nowMs: number): GatewaySportsSnapshot {
    return {
      selection: this.orchestrator.selection(nowMs),
      scoreboardSelection: this.orchestrator.selectionFor('scoreboard', nowMs),
      playByPlaySelection: this.orchestrator.selectionFor('play_by_play', nowMs),
      observations: this.orchestrator.all(),
    };
  }
}
