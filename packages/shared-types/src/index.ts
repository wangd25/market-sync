import { z } from 'zod';

/** Unix epoch milliseconds supplied by or aligned with an external system. */
export type WallClockMs = number;
/** Milliseconds from a local monotonic clock. Only valid for duration measurement. */
export type MonotonicMs = number;

export const providers = ['polymarket', 'kalshi', 'fixture'] as const;
export type Provider = (typeof providers)[number];

export const marketTickKinds = [
  'trade',
  'midpoint',
  'best_bid_ask',
  'book_snapshot',
  'book_delta',
  'status',
] as const;
export type MarketTickKind = (typeof marketTickKinds)[number];

export interface MarketTick {
  id: string;
  provider: Provider;
  providerMarketId: string;
  outcomeId: string;
  sourceTimestampMs: WallClockMs;
  receivedTimestampMs: WallClockMs;
  monotonicReceivedMs: MonotonicMs;
  kind: MarketTickKind;
  price?: number;
  bestBid?: number;
  bestAsk?: number;
  volume?: number;
  sequence?: number;
  status?: 'open' | 'halted' | 'closed' | 'unknown';
  rawSchemaVersion: string;
}

export const marketTickSchema = z
  .object({
    id: z.string().min(1).max(256),
    provider: z.enum(providers),
    providerMarketId: z.string().min(1).max(256),
    outcomeId: z.string().min(1).max(256),
    sourceTimestampMs: z.number().int().nonnegative(),
    receivedTimestampMs: z.number().int().nonnegative(),
    monotonicReceivedMs: z.number().nonnegative(),
    kind: z.enum(marketTickKinds),
    price: z.number().min(0).max(1).optional(),
    bestBid: z.number().min(0).max(1).optional(),
    bestAsk: z.number().min(0).max(1).optional(),
    volume: z.number().nonnegative().optional(),
    sequence: z.number().int().nonnegative().optional(),
    status: z.enum(['open', 'halted', 'closed', 'unknown']).optional(),
    rawSchemaVersion: z.string().min(1).max(64),
  })
  .strict();

export interface SportsState {
  eventId: string;
  sport: string;
  sourceTimestampMs: WallClockMs;
  period?: string;
  clock?: string;
  clockDirection?: 'up' | 'down';
  homeScore?: number;
  awayScore?: number;
  discreteState?: Record<string, string | number | boolean>;
  status: 'scheduled' | 'live' | 'paused' | 'complete' | 'unknown';
  homeTeam?: string;
  awayTeam?: string;
}

const discreteStateValueSchema = z.union([z.string(), z.number(), z.boolean()]);

export const sportsStateSchema = z
  .object({
    eventId: z.string().min(1).max(256),
    sport: z.string().min(1).max(64),
    sourceTimestampMs: z.number().int().nonnegative(),
    period: z.string().max(64).optional(),
    clock: z.string().max(64).optional(),
    clockDirection: z.enum(['up', 'down']).optional(),
    homeScore: z.number().nonnegative().optional(),
    awayScore: z.number().nonnegative().optional(),
    discreteState: z.record(z.string().min(1).max(64), discreteStateValueSchema).optional(),
    status: z.enum(['scheduled', 'live', 'paused', 'complete', 'unknown']),
    homeTeam: z.string().min(1).max(128).optional(),
    awayTeam: z.string().min(1).max(128).optional(),
  })
  .strict();

export const sportsFeedCapabilities = [
  'scoreboard',
  'game_clock',
  'play_by_play',
  'player_attribution',
  'possession',
  'wall_clock_timestamp',
  'ordered_sequence',
  'push_delivery',
  'replay_recovery',
] as const;
export type SportsFeedCapability = (typeof sportsFeedCapabilities)[number];

export const sportsSourceAuthorities = [
  'official',
  'licensed',
  'public_verified',
  'public_unverified',
  'market_corroboration',
  'fixture',
] as const;
export type SportsSourceAuthority = (typeof sportsSourceAuthorities)[number];

export interface SportsFeedDescriptor {
  id: string;
  label: string;
  authority: SportsSourceAuthority;
  capabilities: ReadonlySet<SportsFeedCapability>;
  expectedUpdateIntervalMs: number;
  commercialAccess: 'public' | 'metered' | 'licensed';
}

export const sportsTimestampQualities = ['provider', 'receipt_approximation'] as const;
export type SportsTimestampQuality = (typeof sportsTimestampQualities)[number];

export interface SportsObservation {
  id: string;
  sourceId: string;
  sourceLabel: string;
  authority: SportsSourceAuthority;
  capabilities: readonly SportsFeedCapability[];
  providerEventId: string;
  revision: number;
  correction: boolean;
  timestampQuality: SportsTimestampQuality;
  sourceTimestampMs: WallClockMs;
  receivedTimestampMs: WallClockMs;
  monotonicReceivedMs: MonotonicMs;
  state: SportsState;
  rawSchemaVersion: string;
}

export const sportsObservationSchema = z
  .object({
    id: z.string().min(1).max(512),
    sourceId: z.string().min(1).max(128),
    sourceLabel: z.string().min(1).max(128),
    authority: z.enum(sportsSourceAuthorities),
    capabilities: z.array(z.enum(sportsFeedCapabilities)).max(sportsFeedCapabilities.length),
    providerEventId: z.string().min(1).max(256),
    revision: z.number().int().nonnegative(),
    correction: z.boolean(),
    timestampQuality: z.enum(sportsTimestampQualities),
    sourceTimestampMs: z.number().int().nonnegative(),
    receivedTimestampMs: z.number().int().nonnegative(),
    monotonicReceivedMs: z.number().nonnegative(),
    state: sportsStateSchema,
    rawSchemaVersion: z.string().min(1).max(64),
  })
  .strict()
  .refine((observation) => observation.sourceTimestampMs === observation.state.sourceTimestampMs, {
    message: 'Sports observation and state timestamps must match',
  });

export type SyncAnchorType =
  | 'manual_delay'
  | 'guided_clock_tap'
  | 'event_tap'
  | 'state_match'
  | 'video_event'
  | 'camera_ocr'
  | 'provider_default';

export interface SyncAnchor {
  id: string;
  type: SyncAnchorType;
  realTimestampMs: WallClockMs;
  viewerTimestampMs: WallClockMs;
  estimatedDelayMs: number;
  confidence: number;
  metadata: Record<string, unknown>;
}

export interface ViewerTimelineState {
  mode: 'playing' | 'paused' | 'seeking' | 'uncertain';
  anchorRealTimestampMs: WallClockMs;
  anchorViewerTimestampMs: WallClockMs;
  playbackRate: number;
  estimatedDelayMs: number;
  confidence: number;
}

export interface ProviderHealth {
  connected: boolean;
  lastMessageAtMs?: WallClockMs;
  lastDataAtMs?: WallClockMs;
  reconnectCount: number;
  heartbeatGapMs?: number;
  dataGapMs?: number;
  outOfOrderCount: number;
  invalidMessageCount: number;
  source: 'live' | 'polling' | 'mocked';
}

export const providerHealthSchema = z
  .object({
    connected: z.boolean(),
    lastMessageAtMs: z.number().int().nonnegative().optional(),
    lastDataAtMs: z.number().int().nonnegative().optional(),
    reconnectCount: z.number().int().nonnegative(),
    heartbeatGapMs: z.number().nonnegative().optional(),
    dataGapMs: z.number().nonnegative().optional(),
    outOfOrderCount: z.number().int().nonnegative(),
    invalidMessageCount: z.number().int().nonnegative(),
    source: z.enum(['live', 'polling', 'mocked']),
  })
  .strict();

const researchBaseSchema = z.object({
  id: z.string().min(1).max(512),
  sessionId: z.string().min(1).max(128),
  recordedAtMs: z.number().int().nonnegative(),
  monotonicRecordedMs: z.number().nonnegative(),
});

export const researchObservationSchema = z.discriminatedUnion('kind', [
  researchBaseSchema.extend({ kind: z.literal('market'), tick: marketTickSchema }).strict(),
  researchBaseSchema
    .extend({ kind: z.literal('sports'), observation: sportsObservationSchema })
    .strict(),
  researchBaseSchema
    .extend({
      kind: z.literal('anchor'),
      anchorType: z.enum([
        'manual_delay',
        'guided_clock_tap',
        'event_tap',
        'state_match',
        'video_event',
        'camera_ocr',
        'provider_default',
      ]),
      viewerTimestampMs: z.number().int().nonnegative(),
      estimatedDelayMs: z.number().nonnegative(),
      confidence: z.number().min(0).max(1),
      method: z.string().min(1).max(64),
    })
    .strict(),
  researchBaseSchema
    .extend({
      kind: z.literal('broadcast_tap'),
      eventId: z.string().min(1).max(256),
      side: z.enum(['home', 'away', 'unknown']),
      broadcastVisibleAtMs: z.number().int().nonnegative(),
      matchedSourceTimestampMs: z.number().int().nonnegative().optional(),
      method: z.enum(['next_score', 'visible_event', 'state_match']),
    })
    .strict(),
  researchBaseSchema
    .extend({
      kind: z.literal('health'),
      sourceId: z.string().min(1).max(128),
      health: providerHealthSchema,
    })
    .strict(),
]);

interface ResearchObservationBase {
  id: string;
  sessionId: string;
  recordedAtMs: WallClockMs;
  monotonicRecordedMs: MonotonicMs;
}

export type ResearchObservation =
  | (ResearchObservationBase & { kind: 'market'; tick: MarketTick })
  | (ResearchObservationBase & { kind: 'sports'; observation: SportsObservation })
  | (ResearchObservationBase & {
      kind: 'anchor';
      anchorType: SyncAnchorType;
      viewerTimestampMs: WallClockMs;
      estimatedDelayMs: number;
      confidence: number;
      method: string;
    })
  | (ResearchObservationBase & {
      kind: 'broadcast_tap';
      eventId: string;
      side: 'home' | 'away' | 'unknown';
      broadcastVisibleAtMs: WallClockMs;
      matchedSourceTimestampMs?: WallClockMs;
      method: 'next_score' | 'visible_event' | 'state_match';
    })
  | (ResearchObservationBase & {
      kind: 'health';
      sourceId: string;
      health: ProviderHealth;
    });

export interface MarketMetadata {
  provider: Provider;
  providerMarketId: string;
  eventId: string;
  title: string;
  outcomes: Array<{ id: string; label: string; assetId?: string }>;
  url?: string;
  status: 'open' | 'closed' | 'unknown';
}

export interface RoomState {
  code: string;
  selectedMarket: MarketMetadata | null;
  revision: number;
}
