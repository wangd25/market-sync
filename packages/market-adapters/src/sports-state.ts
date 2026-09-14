import type { SportsState } from '@marketsync/shared-types';

/** Sports-state feeds aid synchronization only and are never treated as settlement authority. */
export interface SportsStateAdapter {
  readonly sourceLabel: string;
  readonly reliability: 'fixture' | 'unverified_public' | 'unavailable';
  getState(eventId: string): Promise<SportsState | null>;
}
