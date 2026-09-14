'use client';

import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  FakeClock,
  ResearchSessionRecorder,
  SyncEngine,
  findNextScoreChange,
  findNextBaseballRun,
  matchBaseballObservation,
  projectDelayedSportsEvents,
  projectDelayedSportsState,
  systemClock,
  type BaseballHalf,
  type BaseballMoment,
  type Clock,
  type DelayedSportsEvent,
  type DelayedMarketProjection,
  type DelayedOutcomeProjection,
} from '@marketsync/core';
import {
  FIXTURE_BASE_TIMESTAMP_MS,
  fixtureList,
  fixtures,
  type FixtureSport,
} from '@marketsync/fixtures';
import {
  PolymarketLiveSession,
  PolymarketReadOnlyAdapter,
  ESPN_SPORTS_DESCRIPTOR,
  POLYMARKET_SPORTS_DESCRIPTOR,
  classifyProviderError,
  parseMarketReference,
  type PolymarketEventSummary,
  type SportsFeedStatus,
} from '@marketsync/market-adapters';
import { SportsSourceOrchestrator, type SportsSourceSelection } from '@marketsync/sports-models';
import type {
  MarketMetadata,
  MarketTick,
  ProviderHealth,
  ResearchObservation,
  SportsFeedDescriptor,
  SportsObservation,
  SportsState,
} from '@marketsync/shared-types';
import { browserHistoryStore } from './history-store';
import { projectMarketReaction } from './market-reaction';
import { MomentumOutcome, type MarketDisplayMode } from './momentum-outcome';
import { PulseUpdate } from './pulse-update';
import { SportsActivityFeed } from './sports-activity-feed';
import {
  createPendingVideoAnchor,
  planConfirmedVideoAnchor,
  type PendingVideoAnchor,
} from './sync-control';

const ProbabilityChart = lazy(() =>
  import('./probability-chart').then((module) => ({ default: module.ProbabilityChart })),
);

export interface MarketSyncPublicSnapshot {
  title: string;
  provider: string;
  probability: number | null;
  bestBid: number | null;
  bestAsk: number | null;
  delaySeconds: number;
  aligned: boolean;
  frozen: boolean;
  updatedAtMs: number;
}

export type VideoTimelineEvent =
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'buffering' }
  | { kind: 'seek'; deltaMs: number }
  | { kind: 'playback-rate'; rate: number }
  | {
      kind: 'latency-estimate';
      delayMs: number;
      confidence: number;
      method: 'program-date-time';
    }
  | { kind: 'unavailable'; reason: string };

export interface MarketSyncDashboardProps {
  compact?: boolean;
  requestLiveAccess?: () => Promise<boolean>;
  onPublicSnapshot?: (snapshot: MarketSyncPublicSnapshot) => void;
  subscribeVideoEvents?: (listener: (event: VideoTimelineEvent) => void) => () => void;
  enableOverlayForActiveSite?: () => Promise<'enabled' | 'denied' | 'unavailable'>;
}

type ProviderMode = 'demo' | 'polymarket';
type LiveAccessState = 'unknown' | 'requesting' | 'granted' | 'denied';
type SyncMode = 'auto' | 'confirm' | 'manual';

interface ReversibleAdjustment {
  fromDelayMs: number;
  toDelayMs: number;
  appliedAtMs: number;
  method: string;
}

interface PersistedSettings {
  version: 2;
  providerMode: ProviderMode;
  sport: FixtureSport;
  delaySeconds: number;
  strict: boolean;
  displayMode?: MarketDisplayMode;
  syncMode?: SyncMode;
  selectedEventSlug?: string;
  selectedMarketId?: string;
}

const SETTINGS_KEY = 'marketsync:settings:v2';
const DEFAULT_SETTINGS: PersistedSettings = {
  version: 2,
  providerMode: 'demo',
  sport: 'soccer',
  delaySeconds: 20,
  strict: true,
  displayMode: 'chart',
  syncMode: 'auto',
};
const EMPTY_HEALTH: ProviderHealth = {
  connected: false,
  reconnectCount: 0,
  outOfOrderCount: 0,
  invalidMessageCount: 0,
  source: 'live',
};

const FIXTURE_SPORTS_DESCRIPTOR: SportsFeedDescriptor = {
  id: 'fixture-sports',
  label: 'Deterministic demo feed',
  authority: 'fixture',
  capabilities: new Set([
    'scoreboard',
    'game_clock',
    'play_by_play',
    'possession',
    'wall_clock_timestamp',
    'ordered_sequence',
    'replay_recovery',
  ]),
  expectedUpdateIntervalMs: 1_000,
  commercialAccess: 'public',
};

const sportsObservationFromState = (
  state: SportsState,
  descriptor: SportsFeedDescriptor,
  receivedTimestampMs: number,
  index: number,
): SportsObservation => {
  const providerEventId = String(
    state.discreteState?.['playId'] ??
      state.discreteState?.['sequence'] ??
      `${state.eventId}:${state.sourceTimestampMs}:${index}`,
  );
  return {
    id: `${descriptor.id}:${providerEventId}:0`,
    sourceId: descriptor.id,
    sourceLabel: descriptor.label,
    authority: descriptor.authority,
    capabilities: [...descriptor.capabilities],
    providerEventId,
    revision: 0,
    correction: false,
    timestampQuality: descriptor.authority === 'fixture' ? 'provider' : 'receipt_approximation',
    sourceTimestampMs: state.sourceTimestampMs,
    receivedTimestampMs: Math.max(state.sourceTimestampMs, receivedTimestampMs),
    monotonicReceivedMs: index,
    state,
    rawSchemaVersion: 'marketsync-sports-observation-v1',
  };
};

const createSportsOrchestrator = (
  states: readonly SportsState[],
  demo: boolean,
  receivedTimestampMs: number,
): SportsSourceOrchestrator => {
  const descriptors = demo
    ? [FIXTURE_SPORTS_DESCRIPTOR]
    : [ESPN_SPORTS_DESCRIPTOR, POLYMARKET_SPORTS_DESCRIPTOR];
  const orchestrator = new SportsSourceOrchestrator(descriptors);
  if (demo) {
    states.forEach((state, index) =>
      orchestrator.ingest(
        sportsObservationFromState(
          state,
          FIXTURE_SPORTS_DESCRIPTOR,
          state.sourceTimestampMs + 100,
          index,
        ),
      ),
    );
  } else {
    states.forEach((state, index) =>
      orchestrator.ingest(
        sportsObservationFromState(state, POLYMARKET_SPORTS_DESCRIPTOR, receivedTimestampMs, index),
      ),
    );
  }
  return orchestrator;
};

const formatLatency = (value: number | null): string =>
  value === null
    ? 'Collecting'
    : value < 1_000
      ? `${Math.round(value)}ms`
      : `${(value / 1_000).toFixed(1)}s`;

const readSettings = (): PersistedSettings => {
  if (typeof window === 'undefined') return DEFAULT_SETTINGS;
  try {
    const value = JSON.parse(window.localStorage.getItem(SETTINGS_KEY) ?? '') as PersistedSettings;
    if (value.version === 2)
      return {
        ...value,
        syncMode:
          value.syncMode === 'auto' || value.syncMode === 'confirm' || value.syncMode === 'manual'
            ? value.syncMode
            : 'auto',
      };
  } catch {
    // Defaults are safer than partially applying malformed local state.
  }
  return DEFAULT_SETTINGS;
};

const createDemoEngine = (clock: FakeClock, sport: FixtureSport, settings: PersistedSettings) => {
  const engine = new SyncEngine(clock, {
    initialDelayMs: settings.delaySeconds * 1_000,
    strictAntiSpoiler: settings.strict,
  });
  for (const tick of fixtures[sport].ticks) engine.ingest(tick);
  return engine;
};

const formatAge = (ageMs: number | null): string => {
  if (ageMs === null) return 'Waiting for data';
  if (ageMs < 1_000) return 'Updated now';
  return `Updated ${(ageMs / 1_000).toFixed(ageMs < 10_000 ? 1 : 0)}s ago`;
};
const formatStart = (timestampMs: number | undefined): string =>
  timestampMs === undefined || !Number.isFinite(timestampMs)
    ? 'Start time unavailable'
    : new Intl.DateTimeFormat(undefined, {
        weekday: 'short',
        hour: 'numeric',
        minute: '2-digit',
      }).format(timestampMs);

const DelayButton = ({ value, onClick }: { value: number; onClick: (seconds: number) => void }) => (
  <button type="button" className="ms-adjust" onClick={() => onClick(value)}>
    {value > 0 ? '+' : '−'}
    {Math.abs(value)}
  </button>
);

interface DisplayOutcome {
  id: string;
  label: string;
  projection: DelayedOutcomeProjection;
  tone: 'blue' | 'red';
}

const complementOutcome = (
  outcomeId: string,
  primary: DelayedOutcomeProjection,
): DelayedOutcomeProjection => ({
  outcomeId,
  currentPrice: primary.currentPrice === null ? null : 1 - primary.currentPrice,
  bestBid: primary.bestAsk === null ? null : 1 - primary.bestAsk,
  bestAsk: primary.bestBid === null ? null : 1 - primary.bestBid,
  spread: primary.spread,
  priceDirection:
    primary.priceDirection === 'up' ? 'down' : primary.priceDirection === 'down' ? 'up' : 'flat',
  momentum: {
    ...primary.momentum,
    direction:
      primary.momentum.direction === 'up'
        ? 'down'
        : primary.momentum.direction === 'down'
          ? 'up'
          : 'flat',
    change: -primary.momentum.change,
    fastChange: -primary.momentum.fastChange,
  },
  chartPoints: primary.chartPoints.map((point) => ({
    timestampMs: point.timestampMs,
    probability: 1 - point.probability,
  })),
});

interface BaseballFormState {
  inning: number;
  half: BaseballHalf;
  homeScore: number;
  awayScore: number;
  outs: number | '';
  count: string;
  moment: BaseballMoment;
}

const initialBaseballForm: BaseballFormState = {
  inning: 1,
  half: 'top',
  homeScore: 0,
  awayScore: 0,
  outs: '',
  count: '',
  moment: 'scoreboard',
};

export const MarketSyncDashboard = ({
  compact = false,
  requestLiveAccess,
  onPublicSnapshot,
  subscribeVideoEvents,
  enableOverlayForActiveSite,
}: MarketSyncDashboardProps) => {
  const initialSettings = DEFAULT_SETTINGS;
  const demoClock = useMemo(() => new FakeClock(FIXTURE_BASE_TIMESTAMP_MS + 60_000), []);
  const engineRef = useRef<SyncEngine>(
    createDemoEngine(demoClock, initialSettings.sport, initialSettings),
  );
  const clockRef = useRef<Clock>(demoClock);
  const sportsSourceRef = useRef<SportsSourceOrchestrator>(
    createSportsOrchestrator(
      fixtures[initialSettings.sport].sportsStates,
      true,
      demoClock.wallNowMs(),
    ),
  );
  const researchSessionIdRef = useRef(`demo-${initialSettings.sport}`);
  const researchRecorderRef = useRef(
    new ResearchSessionRecorder({ sessionId: researchSessionIdRef.current }),
  );
  const liveSessionRef = useRef<PolymarketLiveSession | null>(null);
  const researchWriteQueueRef = useRef<ResearchObservation[]>([]);
  const researchFlushTimerRef = useRef<number | undefined>(undefined);
  const restoredLiveSelectionRef = useRef(false);
  const initializedBaseballMarketRef = useRef<string | null>(null);
  const [restorationSettings, setRestorationSettings] =
    useState<PersistedSettings>(DEFAULT_SETTINGS);
  const sportsStatesRef = useRef<SportsState[]>([...fixtures[initialSettings.sport].sportsStates]);
  const isDemoRef = useRef(true);
  const [hydrated, setHydrated] = useState(false);
  const [providerMode, setProviderMode] = useState<ProviderMode>(initialSettings.providerMode);
  const [accessState, setAccessState] = useState<LiveAccessState>('unknown');
  const [sport, setSport] = useState<FixtureSport>(initialSettings.sport);
  const [metadata, setMetadata] = useState<MarketMetadata>(
    fixtures[initialSettings.sport].metadata,
  );
  const [selectedEvent, setSelectedEvent] = useState<PolymarketEventSummary | null>(null);
  const [events, setEvents] = useState<readonly PolymarketEventSummary[]>([]);
  const [eventsLoading, setEventsLoading] = useState(false);
  const [eventsError, setEventsError] = useState('');
  const [query, setQuery] = useState('');
  const [sportFilter, setSportFilter] = useState('All sports');
  const [marketReference, setMarketReference] = useState('');
  const [marketMessage, setMarketMessage] = useState('Paste a Polymarket event or market URL.');
  const [projection, setProjection] = useState<DelayedMarketProjection>(() =>
    engineRef.current.projection(),
  );
  const [strict, setStrict] = useState(initialSettings.strict);
  const [displayMode, setDisplayMode] = useState<MarketDisplayMode>(
    initialSettings.displayMode ?? 'chart',
  );
  const [liveHealth, setLiveHealth] = useState<ProviderHealth>(EMPTY_HEALTH);
  const [sportsFeedStatus, setSportsFeedStatus] = useState<SportsFeedStatus>('connecting');
  const [feedRefreshing, setFeedRefreshing] = useState(false);
  const [feedRefreshLabel, setFeedRefreshLabel] = useState('');
  const [lowConfidence, setLowConfidence] = useState(false);
  const [roomCode, setRoomCode] = useState('');
  const [roomStatus, setRoomStatus] = useState('Local only');
  const [overlayStatus, setOverlayStatus] = useState('');
  const [compactBrowseOpen, setCompactBrowseOpen] = useState(false);
  const [baseballForm, setBaseballForm] = useState<BaseballFormState>(initialBaseballForm);
  const [calibrationStatus, setCalibrationStatus] = useState(
    'Choose the scoreboard state you just saw. We only align when the state is unique.',
  );
  const [nextRunAfterMs, setNextRunAfterMs] = useState<number | null>(null);
  const [chartRefreshState, setChartRefreshState] = useState<{
    id: number;
    fromDelaySeconds: number;
    toDelaySeconds: number;
  } | null>(null);
  const chartRefreshTimerRef = useRef<number | undefined>(undefined);
  const feedRefreshTimerRef = useRef<number | undefined>(undefined);
  const [sportsSyncStatus, setSportsSyncStatus] = useState(
    'When a matching play reaches your screen, use it to tighten the delay.',
  );
  const [nextScoreAfterMs, setNextScoreAfterMs] = useState<number | null>(null);
  const [syncMode, setSyncMode] = useState<SyncMode>(initialSettings.syncMode ?? 'auto');
  const [pendingVideoAnchor, setPendingVideoAnchor] = useState<PendingVideoAnchor | null>(null);
  const [lastAdjustment, setLastAdjustment] = useState<ReversibleAdjustment | null>(null);
  const [researchRevision, setResearchRevision] = useState(0);
  const [exportStatus, setExportStatus] = useState('');

  const refresh = useCallback(() => setProjection(engineRef.current.projection()), []);
  const delaySeconds = engineRef.current.timeline.snapshot().estimatedDelayMs / 1_000;
  const confidence = engineRef.current.timeline.snapshot().confidence;
  const sportsProjection = projectDelayedSportsState(
    sportsStatesRef.current,
    projection.viewerTimestampMs,
  );
  const sportsState = sportsProjection.state;
  const activeSport = selectedEvent?.sport ?? sportsState?.sport ?? sport;
  const isBaseball = /baseball|mlb/i.test(activeSport);
  const activeIsDemo = metadata.provider === 'fixture';
  const health = activeIsDemo ? engineRef.current.health() : liveHealth;
  const sportsSelection: SportsSourceSelection | null = sportsSourceRef.current.selection(
    clockRef.current.wallNowMs(),
  );
  const researchSummary = useMemo(
    () => researchRecorderRef.current.summary(projection.viewerTimestampMs),
    [projection.viewerTimestampMs, researchRevision],
  );
  const exportAllowed = activeIsDemo || sportsState?.status === 'complete';
  const lastAnchor = engineRef.current.timeline.getAnchors().at(-1);
  const recentAnchors = engineRef.current.timeline.getAnchors().slice(-3).toReversed();
  const lastAnchorAgeMs =
    lastAnchor === undefined
      ? null
      : Math.max(0, clockRef.current.wallNowMs() - lastAnchor.realTimestampMs);
  const qualityLabel = projection.frozen
    ? 'Frozen'
    : !health.connected && !activeIsDemo
      ? 'Reconnecting'
      : confidence >= 0.8
        ? 'High'
        : confidence >= 0.55
          ? 'Medium'
          : 'Low';

  const displayOutcomes = useMemo<readonly DisplayOutcome[]>(() => {
    const projectedById = new Map(
      projection.outcomes.map((outcome) => [outcome.outcomeId, outcome]),
    );
    const primaryMetadata = metadata.outcomes[0];
    if (primaryMetadata === undefined) return [];
    const primary =
      projectedById.get(primaryMetadata.assetId ?? primaryMetadata.id) ?? projection.outcomes[0];
    if (primary === undefined) return [];
    const first: DisplayOutcome = {
      id: primaryMetadata.id,
      label: primaryMetadata.label,
      projection: primary,
      tone: 'blue',
    };
    const secondaryMetadata = metadata.outcomes[1];
    if (secondaryMetadata === undefined) return [first];
    const secondary =
      projectedById.get(secondaryMetadata.assetId ?? secondaryMetadata.id) ??
      complementOutcome(secondaryMetadata.id, primary);
    return [
      first,
      {
        id: secondaryMetadata.id,
        label: secondaryMetadata.label,
        projection: secondary,
        tone: 'red',
      },
    ];
  }, [metadata.outcomes, projection.outcomes]);
  const lastVisibleMarketTimestampMs = displayOutcomes.reduce<number | null>((latest, outcome) => {
    const timestampMs = outcome.projection.chartPoints.at(-1)?.timestampMs;
    if (timestampMs === undefined) return latest;
    return latest === null ? timestampMs : Math.max(latest, timestampMs);
  }, null);
  const visibleUpdateAgeMs =
    lastVisibleMarketTimestampMs === null
      ? null
      : Math.max(0, projection.viewerTimestampMs - lastVisibleMarketTimestampMs);
  const transportAgeMs = activeIsDemo
    ? 0
    : health.lastMessageAtMs === undefined
      ? null
      : Math.max(0, Date.now() - health.lastMessageAtMs);
  const marketActivityTone: 'live' | 'quiet' | 'warning' =
    !activeIsDemo && !health.connected
      ? 'warning'
      : visibleUpdateAgeMs !== null && visibleUpdateAgeMs >= 10_000
        ? 'quiet'
        : 'live';
  const marketActivityLabel = activeIsDemo
    ? 'Replay active'
    : !health.connected
      ? 'Reconnecting'
      : visibleUpdateAgeMs === null
        ? 'Waiting for price'
        : visibleUpdateAgeMs < 2_000
          ? 'Moving now'
          : visibleUpdateAgeMs < 10_000
            ? `Market quiet ${Math.ceil(visibleUpdateAgeMs / 1_000)}s`
            : `No price change ${Math.floor(visibleUpdateAgeMs / 1_000)}s`;
  const homeLabel =
    selectedEvent?.initialSportsState?.homeTeam ?? metadata.outcomes[0]?.label ?? 'Home';
  const awayLabel =
    selectedEvent?.initialSportsState?.awayTeam ?? metadata.outcomes[1]?.label ?? 'Away';
  const sportsEvents = useMemo(
    () =>
      projectDelayedSportsEvents(sportsStatesRef.current, projection.viewerTimestampMs, {
        homeLabel,
        awayLabel,
        limit: compact ? 5 : 7,
      }),
    [awayLabel, compact, homeLabel, projection.viewerTimestampMs],
  );
  const primaryMarketLabel = displayOutcomes[0]?.label ?? 'Market';
  const primaryMarketPoints = displayOutcomes[0]?.projection.chartPoints ?? [];
  const latestSportsEvent = sportsEvents[0] ?? null;
  const latestMarketReaction =
    latestSportsEvent === null
      ? null
      : projectMarketReaction(
          primaryMarketPoints,
          latestSportsEvent.sourceTimestampMs,
          projection.viewerTimestampMs,
        );
  const sportsCoverageLabel = activeIsDemo
    ? 'Demo updates'
    : sportsFeedStatus === 'play-by-play'
      ? 'Live play-by-play'
      : sportsFeedStatus === 'live'
        ? 'Live scoreboard'
        : sportsFeedStatus === 'polling'
          ? 'Scoreboard backup'
          : sportsFeedStatus === 'limited'
            ? 'Limited coverage'
            : 'Connecting scoreboard';

  const filteredEvents = useMemo(() => {
    const normalizedQuery = query.trim().toLowerCase();
    return events.filter((event) => {
      const matchesQuery =
        normalizedQuery.length === 0 ||
        `${event.title} ${event.subtitle ?? ''} ${event.league ?? ''} ${event.sport}`
          .toLowerCase()
          .includes(normalizedQuery);
      return matchesQuery && (sportFilter === 'All sports' || event.sport === sportFilter);
    });
  }, [events, query, sportFilter]);
  const liveEvents = filteredEvents.filter((event) => event.live);
  const upcomingEvents = filteredEvents.filter((event) => !event.live);
  const sports = useMemo(
    () => ['All sports', ...new Set(events.map((event) => event.sport))],
    [events],
  );

  const flushResearchWrites = useCallback(() => {
    if (researchFlushTimerRef.current !== undefined) {
      window.clearTimeout(researchFlushTimerRef.current);
      researchFlushTimerRef.current = undefined;
    }
    const pending = researchWriteQueueRef.current.splice(0);
    if (pending.length === 0) return;
    void browserHistoryStore.saveResearchObservations(pending);
    setResearchRevision((revision) => revision + 1);
  }, []);

  const recordResearch = useCallback(
    (observation: ResearchObservation) => {
      if (!researchRecorderRef.current.record(observation)) return;
      researchWriteQueueRef.current.push(observation);
      if (researchWriteQueueRef.current.length >= 25) {
        flushResearchWrites();
        return;
      }
      researchFlushTimerRef.current ??= window.setTimeout(flushResearchWrites, 500);
    },
    [flushResearchWrites],
  );

  const replaceEngine = useCallback(
    (
      engine: SyncEngine,
      clock: Clock,
      states: readonly SportsState[],
      demo: boolean,
      sessionId: string,
      initialTicks: readonly MarketTick[] = [],
    ) => {
      engineRef.current = engine;
      clockRef.current = clock;
      sportsSourceRef.current = createSportsOrchestrator(states, demo, clock.wallNowMs());
      sportsStatesRef.current = [...sportsSourceRef.current.states(clock.wallNowMs())];
      researchSessionIdRef.current = sessionId;
      researchRecorderRef.current = new ResearchSessionRecorder({ sessionId });
      const seeded: ResearchObservation[] = [
        ...initialTicks.map((tick): ResearchObservation => ({
          id: `${sessionId}:market:${tick.id}`,
          sessionId,
          kind: 'market',
          recordedAtMs: tick.receivedTimestampMs,
          monotonicRecordedMs: tick.monotonicReceivedMs,
          tick,
        })),
        ...sportsSourceRef.current.all().map((observation): ResearchObservation => ({
          id: `${sessionId}:sports:${observation.id}`,
          sessionId,
          kind: 'sports',
          recordedAtMs: observation.receivedTimestampMs,
          monotonicRecordedMs: observation.monotonicReceivedMs,
          observation,
        })),
      ];
      for (const observation of seeded) researchRecorderRef.current.record(observation);
      void browserHistoryStore.saveResearchObservations(seeded);
      void browserHistoryStore.pruneResearch(clock.wallNowMs() - 6 * 60 * 60 * 1_000);
      setResearchRevision((revision) => revision + 1);
      setExportStatus('');
      setPendingVideoAnchor(null);
      setLastAdjustment(null);
      setNextScoreAfterMs(null);
      isDemoRef.current = demo;
      setProjection(engine.projection());
    },
    [],
  );

  const activateDemo = useCallback(
    (nextSport: FixtureSport) => {
      liveSessionRef.current?.stop();
      liveSessionRef.current = null;
      demoClock.setWallMs(FIXTURE_BASE_TIMESTAMP_MS + 60_000);
      const settings = { ...initialSettings, delaySeconds, strict, sport: nextSport };
      replaceEngine(
        createDemoEngine(demoClock, nextSport, settings),
        demoClock,
        fixtures[nextSport].sportsStates,
        true,
        `demo-${nextSport}-${FIXTURE_BASE_TIMESTAMP_MS}`,
        fixtures[nextSport].ticks,
      );
      setMetadata(fixtures[nextSport].metadata);
      setSelectedEvent(null);
      setLiveHealth(EMPTY_HEALTH);
      setSportsFeedStatus('live');
    },
    [delaySeconds, demoClock, initialSettings, replaceEngine, strict],
  );

  const loadEvents = useCallback(async () => {
    setEventsLoading(true);
    setEventsError('');
    try {
      const result = await new PolymarketReadOnlyAdapter().discoverSportsEvents({ limit: 60 });
      setEvents(
        [...result].sort((a, b) =>
          a.live === b.live
            ? (a.startTimestampMs ?? Number.MAX_SAFE_INTEGER) -
              (b.startTimestampMs ?? Number.MAX_SAFE_INTEGER)
            : a.live
              ? -1
              : 1,
        ),
      );
      setAccessState('granted');
    } catch (error) {
      const classified = classifyProviderError(error);
      setEventsError(classified.message);
    } finally {
      setEventsLoading(false);
    }
  }, []);

  const requestAndLoadLive = useCallback(async () => {
    setAccessState('requesting');
    try {
      const granted = requestLiveAccess === undefined ? true : await requestLiveAccess();
      if (!granted) {
        setAccessState('denied');
        setEventsError('Public market access was not granted. Demo mode remains available.');
        return;
      }
      setAccessState('granted');
      await loadEvents();
    } catch (error) {
      setAccessState('denied');
      setEventsError(classifyProviderError(error).message);
    }
  }, [loadEvents, requestLiveAccess]);

  const startLiveMarket = useCallback(
    async (event: PolymarketEventSummary | null, market: MarketMetadata) => {
      const assetIds = market.outcomes.flatMap((outcome) =>
        outcome.assetId === undefined ? [] : [outcome.assetId],
      );
      if (assetIds.length === 0) {
        setMarketMessage('This contract does not expose a public CLOB asset ID.');
        return;
      }
      liveSessionRef.current?.stop();
      const engine = new SyncEngine(systemClock, {
        initialDelayMs: delaySeconds * 1_000,
        strictAntiSpoiler: strict,
      });
      const sessionId = `live-${market.providerMarketId}-${Date.now()}`;
      replaceEngine(
        engine,
        systemClock,
        event?.initialSportsState === undefined ? [] : [event.initialSportsState],
        false,
        sessionId,
      );
      setMetadata(market);
      setSelectedEvent(event);
      setSportsFeedStatus(event === null ? 'limited' : 'connecting');
      setMarketMessage(`Connecting to ${market.title}…`);
      const adapter = new PolymarketReadOnlyAdapter();
      let historyWarning = '';
      try {
        const [savedTicks, historyByOutcome] = await Promise.all([
          browserHistoryStore.loadTicks(market.providerMarketId),
          Promise.all(assetIds.map((assetId) => adapter.loadHistoryTicks(market, assetId))),
        ]);
        const historyTicks = historyByOutcome.flat();
        const selectedAssets = new Set(assetIds);
        for (const tick of [...savedTicks, ...historyTicks]) {
          if (selectedAssets.has(tick.outcomeId)) engine.ingest(tick);
        }
        void browserHistoryStore.saveTicks(historyTicks);
        void browserHistoryStore.pruneTicks(Date.now() - 6 * 60 * 60 * 1_000);
        refresh();
      } catch (error) {
        historyWarning = `${classifyProviderError(error).message} `;
      }
      const session = new PolymarketLiveSession({
        assetIds,
        ...(event === null ? {} : { eventSlug: event.slug }),
        ...(event === null
          ? {}
          : {
              sportsEvent: {
                sport: event.sport,
                ...(event.league === undefined ? {} : { league: event.league }),
                ...(event.startTimestampMs === undefined
                  ? {}
                  : { startTimestampMs: event.startTimestampMs }),
                ...(event.initialSportsState?.homeTeam === undefined
                  ? {}
                  : { homeTeam: event.initialSportsState.homeTeam }),
                ...(event.initialSportsState?.awayTeam === undefined
                  ? {}
                  : { awayTeam: event.initialSportsState.awayTeam }),
              },
            }),
        adapter,
        callbacks: {
          onTicks(ticks) {
            for (const tick of ticks) engine.ingest(tick);
            void browserHistoryStore.saveTicks(ticks);
            for (const tick of ticks)
              recordResearch({
                id: `${researchSessionIdRef.current}:market:${tick.id}`,
                sessionId: researchSessionIdRef.current,
                kind: 'market',
                recordedAtMs: tick.receivedTimestampMs,
                monotonicRecordedMs: tick.monotonicReceivedMs,
                tick,
              });
            refresh();
          },
          onSportsObservation(observation) {
            const result = sportsSourceRef.current.ingest(observation);
            if (!result.accepted) return;
            const nowMs = systemClock.wallNowMs();
            const selection = sportsSourceRef.current.selection(nowMs);
            sportsStatesRef.current = [...sportsSourceRef.current.states(nowMs)];
            if (result.disagreement) {
              engine.timeline.reduceConfidence(0.5, 'sports_source_disagreement');
              setSportsSyncStatus(
                'Reference sources disagree. Strict mode is holding the last safe projection.',
              );
            } else if (selection?.switched === true && selection.reason === 'stale_failover') {
              setSportsSyncStatus(
                `Reference switched to ${selection.descriptor.label} after the prior source went stale.`,
              );
            }
            recordResearch({
              id: `${researchSessionIdRef.current}:sports:${observation.id}`,
              sessionId: researchSessionIdRef.current,
              kind: 'sports',
              recordedAtMs: observation.receivedTimestampMs,
              monotonicRecordedMs: observation.monotonicReceivedMs,
              observation,
            });
            refresh();
          },
          onSportsStatus(status) {
            setSportsFeedStatus(status);
          },
          onHealth(nextHealth) {
            if (!nextHealth.connected && engine.health().connected) engine.reconnect();
            else if (nextHealth.connected && !engine.health().connected) engine.markConnected();
            setLiveHealth(nextHealth);
            const now = Date.now();
            recordResearch({
              id: `${researchSessionIdRef.current}:health:${now}:${nextHealth.reconnectCount}:${nextHealth.connected}`,
              sessionId: researchSessionIdRef.current,
              kind: 'health',
              recordedAtMs: now,
              monotonicRecordedMs: performance.now(),
              sourceId: 'polymarket-market',
              health: nextHealth,
            });
            refresh();
          },
          onError(error) {
            setMarketMessage(classifyProviderError(error).message);
          },
        },
      });
      liveSessionRef.current = session;
      session.start();
      void session.refresh();
      setMarketMessage(
        `${historyWarning}Selected ${market.title}. Live prices are delayed to your broadcast.`,
      );
    },
    [delaySeconds, recordResearch, refresh, replaceEngine, strict],
  );

  const resolveMarketReference = useCallback(async () => {
    try {
      if (accessState !== 'granted') {
        const granted = requestLiveAccess === undefined ? true : await requestLiveAccess();
        if (!granted) {
          setAccessState('denied');
          setMarketMessage('Permission denied. Grant public market access or continue in Demo.');
          return;
        }
        setAccessState('granted');
      }
      setMarketMessage('Resolving public market metadata…');
      const parsed = parseMarketReference(marketReference);
      if (parsed.provider !== 'polymarket') {
        setMarketMessage('Kalshi live selection is not enabled in this milestone.');
        return;
      }
      const resolved = await new PolymarketReadOnlyAdapter().resolveReference(parsed);
      setProviderMode('polymarket');
      if (resolved.kind === 'event') {
        if (resolved.event.markets.length === 0) {
          setMarketMessage(
            `Found ${resolved.event.title}, but it does not currently expose an active public contract. Your current chart remains selected.`,
          );
          return;
        }
        setSelectedEvent(resolved.event);
        if (resolved.event.markets.length === 1 && resolved.event.markets[0] !== undefined)
          await startLiveMarket(resolved.event, resolved.event.markets[0]);
        else
          setMarketMessage(
            `Found ${resolved.event.markets.length} contracts. Choose the one you want to follow.`,
          );
      } else {
        await startLiveMarket(null, resolved.market);
      }
    } catch (error) {
      const classified = classifyProviderError(error);
      setMarketMessage(classified.message);
    }
  }, [accessState, marketReference, requestLiveAccess, startLiveMarket]);

  const setDelay = useCallback(
    (seconds: number, recordManual = true) => {
      const timeline = engineRef.current.timeline;
      const fromDelaySeconds = timeline.snapshot().estimatedDelayMs / 1_000;
      const toDelaySeconds = Math.max(0, seconds);
      if (Math.abs(fromDelaySeconds - toDelaySeconds) < 0.001) return;
      timeline.setEstimatedDelay(toDelaySeconds * 1_000);
      if (recordManual) {
        const now = clockRef.current.wallNowMs();
        recordResearch({
          id: `${researchSessionIdRef.current}:anchor:manual:${now}:${Math.round(toDelaySeconds * 1_000)}`,
          sessionId: researchSessionIdRef.current,
          kind: 'anchor',
          recordedAtMs: now,
          monotonicRecordedMs: performance.now(),
          anchorType: 'manual_delay',
          viewerTimestampMs: now - toDelaySeconds * 1_000,
          estimatedDelayMs: toDelaySeconds * 1_000,
          confidence: timeline.snapshot().confidence,
          method: 'manual_delay',
        });
      }
      setChartRefreshState({
        id: Date.now(),
        fromDelaySeconds,
        toDelaySeconds,
      });
      if (chartRefreshTimerRef.current !== undefined)
        window.clearTimeout(chartRefreshTimerRef.current);
      chartRefreshTimerRef.current = window.setTimeout(() => {
        chartRefreshTimerRef.current = undefined;
        setChartRefreshState(null);
      }, 520);
      refresh();
    },
    [recordResearch, refresh],
  );
  const adjustDelay = (seconds: number) => setDelay(delaySeconds + seconds);
  const togglePause = () => {
    if (engineRef.current.timeline.snapshot().mode === 'playing')
      engineRef.current.timeline.pause();
    else engineRef.current.timeline.resume();
    refresh();
  };
  const toggleLowConfidence = () => {
    if (lowConfidence) engineRef.current.timeline.restoreConfidence(0.92);
    else engineRef.current.timeline.reduceConfidence(0.5, 'simulated_low_confidence');
    setLowConfidence(!lowConfidence);
    refresh();
  };

  const refreshLiveFeed = useCallback(async () => {
    if (feedRefreshing) return;
    setFeedRefreshing(true);
    setFeedRefreshLabel('Refreshing prices, clock, and plays…');
    try {
      if (metadata.provider === 'fixture') {
        refresh();
        setFeedRefreshLabel('Demo timeline refreshed now');
      } else if (liveSessionRef.current === null) {
        setFeedRefreshLabel('Choose a live contract first');
      } else {
        await liveSessionRef.current.refresh();
        refresh();
        setFeedRefreshLabel('Sources refreshed now · broadcast delay preserved');
      }
    } catch (error) {
      setFeedRefreshLabel(classifyProviderError(error).message);
    } finally {
      setFeedRefreshing(false);
      if (feedRefreshTimerRef.current !== undefined)
        window.clearTimeout(feedRefreshTimerRef.current);
      feedRefreshTimerRef.current = window.setTimeout(() => {
        feedRefreshTimerRef.current = undefined;
        setFeedRefreshLabel('');
      }, 2_500);
    }
  }, [feedRefreshing, metadata.provider, refresh]);

  const refreshSportsFeed = useCallback(async () => {
    if (feedRefreshing) return;
    setFeedRefreshing(true);
    setFeedRefreshLabel('Refreshing clock, score, and plays…');
    try {
      if (metadata.provider === 'fixture') {
        refresh();
        setFeedRefreshLabel('Demo reference refreshed');
      } else if (liveSessionRef.current === null) {
        setFeedRefreshLabel('Choose a live contract first');
      } else {
        await liveSessionRef.current.refreshSports();
        refresh();
        setFeedRefreshLabel('Clock, score, and plays refreshed');
      }
    } catch (error) {
      setFeedRefreshLabel(classifyProviderError(error).message);
    } finally {
      setFeedRefreshing(false);
      if (feedRefreshTimerRef.current !== undefined)
        window.clearTimeout(feedRefreshTimerRef.current);
      feedRefreshTimerRef.current = window.setTimeout(() => {
        feedRefreshTimerRef.current = undefined;
        setFeedRefreshLabel('');
      }, 2_500);
    }
  }, [feedRefreshing, metadata.provider, refresh]);

  const commitViewerAnchor = useCallback(
    ({
      type,
      viewerTimestampMs,
      rawDelayMs,
      anchorConfidence,
      metadata: anchorMetadata,
    }: {
      type: 'event_tap' | 'state_match' | 'video_event';
      viewerTimestampMs: number;
      rawDelayMs: number;
      anchorConfidence: number;
      metadata: Record<string, unknown>;
    }): number => {
      const timeline = engineRef.current.timeline;
      const observedAtMs = clockRef.current.wallNowMs();
      const priorSamples = timeline
        .getAnchors()
        .filter((anchor) => ['event_tap', 'state_match', 'video_event'].includes(anchor.type))
        .slice(-8)
        .map((anchor) => {
          const raw = anchor.metadata['rawDelayMs'];
          return typeof raw === 'number' && Number.isFinite(raw) ? raw : anchor.estimatedDelayMs;
        });
      const priorOrdered = priorSamples.toSorted((left, right) => left - right);
      const priorMedian = priorOrdered[Math.floor((priorOrdered.length - 1) / 2)];
      const contradictory = priorMedian !== undefined && Math.abs(rawDelayMs - priorMedian) > 5_000;
      const ordered = [...priorSamples, rawDelayMs].toSorted((left, right) => left - right);
      const combinedMedian = ordered[Math.floor((ordered.length - 1) / 2)] ?? rawDelayMs;
      const currentDelayMs = timeline.snapshot().estimatedDelayMs;
      const smoothedDelayMs = contradictory
        ? currentDelayMs
        : priorSamples.length >= 2 && timeline.snapshot().confidence >= 0.75
          ? currentDelayMs + Math.max(-2_000, Math.min(2_000, combinedMedian - currentDelayMs))
          : combinedMedian;
      setDelay(smoothedDelayMs / 1_000, false);
      timeline.addAnchor({
        id: `${type}-${observedAtMs}-${Math.round(rawDelayMs)}`,
        type,
        realTimestampMs: observedAtMs,
        viewerTimestampMs,
        estimatedDelayMs: rawDelayMs,
        confidence: anchorConfidence,
        metadata: {
          ...anchorMetadata,
          rawDelayMs,
          smoothedDelayMs,
          sampleCount: ordered.length,
          contradictory,
        },
      });
      void browserHistoryStore.saveAnchors(timeline.getAnchors().slice(-250));
      const anchorMethod = anchorMetadata['method'];
      recordResearch({
        id: `${researchSessionIdRef.current}:anchor:${type}:${observedAtMs}:${Math.round(rawDelayMs)}`,
        sessionId: researchSessionIdRef.current,
        kind: 'anchor',
        recordedAtMs: observedAtMs,
        monotonicRecordedMs: performance.now(),
        anchorType: type,
        viewerTimestampMs,
        estimatedDelayMs: rawDelayMs,
        confidence: anchorConfidence,
        method: typeof anchorMethod === 'string' ? anchorMethod : type,
      });
      refresh();
      return smoothedDelayMs;
    },
    [recordResearch, refresh, setDelay],
  );

  const commitSportsCalibration = useCallback(
    (state: SportsState, estimatedDelayMs: number, description: string) => {
      const appliedDelayMs = commitViewerAnchor({
        type: 'state_match',
        viewerTimestampMs: state.sourceTimestampMs,
        rawDelayMs: estimatedDelayMs,
        anchorConfidence: 0.9,
        metadata: {
          sport: 'baseball',
          period: state.period,
          ...state.discreteState,
        },
      });
      setCalibrationStatus(`${description} Delay set to ${(appliedDelayMs / 1_000).toFixed(1)}s.`);
      const observedAtMs = clockRef.current.wallNowMs();
      recordResearch({
        id: `${researchSessionIdRef.current}:tap:state:${observedAtMs}:${state.sourceTimestampMs}`,
        sessionId: researchSessionIdRef.current,
        kind: 'broadcast_tap',
        recordedAtMs: observedAtMs,
        monotonicRecordedMs: performance.now(),
        eventId: state.eventId,
        side: 'unknown',
        broadcastVisibleAtMs: observedAtMs,
        matchedSourceTimestampMs: state.sourceTimestampMs,
        method: 'state_match',
      });
      setNextRunAfterMs(null);
    },
    [commitViewerAnchor, recordResearch],
  );

  const syncToSportsEvent = useCallback(
    (event: DelayedSportsEvent) => {
      const observedAtMs = clockRef.current.wallNowMs();
      const estimatedDelayMs = observedAtMs - event.sourceTimestampMs;
      if (estimatedDelayMs < 0 || estimatedDelayMs > 5 * 60_000) {
        setSportsSyncStatus('That update is outside the five-minute sync window.');
        return;
      }
      const appliedDelayMs = commitViewerAnchor({
        type: 'event_tap',
        viewerTimestampMs: event.sourceTimestampMs,
        rawDelayMs: estimatedDelayMs,
        anchorConfidence: 0.88,
        metadata: { eventId: event.id, kind: event.kind, title: event.title },
      });
      setSportsSyncStatus(
        `Matched “${event.title}”. Delay updated to ${(appliedDelayMs / 1_000).toFixed(1)}s.`,
      );
      recordResearch({
        id: `${researchSessionIdRef.current}:tap:event:${observedAtMs}:${event.id}`,
        sessionId: researchSessionIdRef.current,
        kind: 'broadcast_tap',
        recordedAtMs: observedAtMs,
        monotonicRecordedMs: performance.now(),
        eventId: event.id,
        side: 'unknown',
        broadcastVisibleAtMs: observedAtMs,
        matchedSourceTimestampMs: event.sourceTimestampMs,
        method: 'visible_event',
      });
    },
    [commitViewerAnchor, recordResearch],
  );

  const armNextScore = useCallback(() => {
    const now = clockRef.current.wallNowMs();
    const latest = sportsStatesRef.current
      .filter((state) => state.sourceTimestampMs <= now)
      .toSorted((left, right) => right.sourceTimestampMs - left.sourceTimestampMs)[0];
    if (latest === undefined) {
      setSportsSyncStatus('Wait for the reference feed to connect, then try guided sync again.');
      return;
    }
    setNextScoreAfterMs(latest.sourceTimestampMs);
    setSportsSyncStatus('Armed. Tap the team that scores when the next score reaches your screen.');
  }, []);

  const completeNextScore = useCallback(
    (side: 'home' | 'away') => {
      if (nextScoreAfterMs === null) return;
      const observedAtMs = clockRef.current.wallNowMs();
      const score = findNextScoreChange(sportsStatesRef.current, nextScoreAfterMs, side);
      if (score === null) {
        setSportsSyncStatus(
          'The reference feed has not confirmed that score yet. Keep sync armed and try again shortly.',
        );
        return;
      }
      const rawDelayMs = observedAtMs - score.sourceTimestampMs;
      if (rawDelayMs < 0 || rawDelayMs > 5 * 60_000) {
        setSportsSyncStatus('That score is outside the five-minute sync window.');
        return;
      }
      const appliedDelayMs = commitViewerAnchor({
        type: 'event_tap',
        viewerTimestampMs: score.sourceTimestampMs,
        rawDelayMs,
        anchorConfidence: score.discreteState?.['source'] === 'espn' ? 0.86 : 0.72,
        metadata: {
          method: 'next-score',
          side,
          eventId: score.eventId,
          playId: score.discreteState?.['playId'],
        },
      });
      setNextScoreAfterMs(null);
      setSportsSyncStatus(
        `Score matched without revealing it early. Delay is ${(appliedDelayMs / 1_000).toFixed(1)}s. Repeat once more to improve confidence.`,
      );
      recordResearch({
        id: `${researchSessionIdRef.current}:tap:score:${observedAtMs}:${score.eventId}:${side}`,
        sessionId: researchSessionIdRef.current,
        kind: 'broadcast_tap',
        recordedAtMs: observedAtMs,
        monotonicRecordedMs: performance.now(),
        eventId: score.eventId,
        side,
        broadcastVisibleAtMs: observedAtMs,
        matchedSourceTimestampMs: score.sourceTimestampMs,
        method: 'next_score',
      });
    },
    [commitViewerAnchor, nextScoreAfterMs, recordResearch],
  );

  const calibrateBaseballState = useCallback(() => {
    const observedAtMs = clockRef.current.wallNowMs();
    const availableStates = sportsStatesRef.current.filter(
      (state) => state.sourceTimestampMs <= observedAtMs,
    );
    const result = matchBaseballObservation(
      availableStates,
      {
        inning: baseballForm.inning,
        half: baseballForm.half,
        homeScore: baseballForm.homeScore,
        awayScore: baseballForm.awayScore,
        moment: baseballForm.moment,
        ...(baseballForm.outs === '' ? {} : { outs: baseballForm.outs }),
        ...(baseballForm.count === '' ? {} : { count: baseballForm.count }),
      },
      observedAtMs,
    );
    if (result.kind === 'matched') {
      commitSportsCalibration(result.state, result.estimatedDelayMs, 'Unique play matched.');
      return;
    }
    if (result.kind === 'ambiguous') {
      setCalibrationStatus(
        `That state occurred ${result.candidateCount} times. Choose “Run scored” or add outs/count.`,
      );
      return;
    }
    if (result.kind === 'out-of-range') {
      setCalibrationStatus('The matching play is outside the five-minute calibration window.');
      return;
    }
    setCalibrationStatus(
      'The public sports feed did not report that exact state. Check home/away order or use the next-run method.',
    );
  }, [baseballForm, commitSportsCalibration]);

  const armNextRun = useCallback(() => {
    const now = clockRef.current.wallNowMs();
    const latest = sportsStatesRef.current
      .filter((state) => state.sourceTimestampMs <= now)
      .toSorted((left, right) => right.sourceTimestampMs - left.sourceTimestampMs)[0];
    if (latest === undefined) {
      setCalibrationStatus('Wait for the public sports feed before starting next-run alignment.');
      return;
    }
    setNextRunAfterMs(latest.sourceTimestampMs);
    setCalibrationStatus('Armed. When the next run appears on your broadcast, choose who scored.');
  }, []);

  const completeNextRun = useCallback(
    (side: 'home' | 'away') => {
      if (nextRunAfterMs === null) return;
      const observedAtMs = clockRef.current.wallNowMs();
      const run = findNextBaseballRun(
        sportsStatesRef.current.filter((state) => state.sourceTimestampMs <= observedAtMs),
        nextRunAfterMs,
        side,
      );
      if (run === null) {
        setCalibrationStatus(
          'No matching run has arrived from the public feed yet. Keep the alignment armed and try again shortly.',
        );
        return;
      }
      const estimatedDelayMs = observedAtMs - run.sourceTimestampMs;
      if (estimatedDelayMs < 0 || estimatedDelayMs > 5 * 60_000) {
        setCalibrationStatus('That run is outside the five-minute calibration window.');
        return;
      }
      commitSportsCalibration(run, estimatedDelayMs, 'Next run matched.');
    },
    [commitSportsCalibration, nextRunAfterMs],
  );

  useEffect(() => {
    const persisted = readSettings();
    setRestorationSettings(persisted);
    setProviderMode(persisted.providerMode);
    setSport(persisted.sport);
    setStrict(persisted.strict);
    setDisplayMode(persisted.displayMode ?? 'chart');
    setSyncMode(persisted.syncMode ?? 'auto');
    engineRef.current.timeline.setEstimatedDelay(persisted.delaySeconds * 1_000);
    engineRef.current.setStrictAntiSpoiler(persisted.strict);
    setHydrated(true);
    return () => liveSessionRef.current?.stop();
  }, []);

  useEffect(
    () => () => {
      if (chartRefreshTimerRef.current !== undefined)
        window.clearTimeout(chartRefreshTimerRef.current);
      if (feedRefreshTimerRef.current !== undefined)
        window.clearTimeout(feedRefreshTimerRef.current);
      flushResearchWrites();
    },
    [flushResearchWrites],
  );

  useEffect(() => {
    if (providerMode === 'demo') activateDemo(sport);
  }, [activateDemo, providerMode, sport]);

  useEffect(() => {
    if (!isBaseball) {
      initializedBaseballMarketRef.current = null;
      return;
    }
    if (sportsState === null || initializedBaseballMarketRef.current === metadata.providerMarketId)
      return;
    const parsedPeriod = /(?:top|bot|bottom)\s*(\d+)/i.exec(sportsState.period ?? '');
    const discreteInning = Number(sportsState.discreteState?.['inning']);
    const inning =
      Number.isInteger(discreteInning) && discreteInning > 0
        ? discreteInning
        : Number(parsedPeriod?.[1] ?? 1);
    const discreteHalf = String(sportsState.discreteState?.['half'] ?? '').toLowerCase();
    const half: BaseballHalf =
      discreteHalf === 'bottom' || /^(?:bot|bottom)/i.test(sportsState.period ?? '')
        ? 'bottom'
        : 'top';
    const outs = Number(sportsState.discreteState?.['outs']);
    setBaseballForm({
      inning,
      half,
      homeScore: sportsState.homeScore ?? 0,
      awayScore: sportsState.awayScore ?? 0,
      outs: Number.isInteger(outs) && outs >= 0 && outs <= 2 ? outs : '',
      count: String(sportsState.discreteState?.['count'] ?? ''),
      moment: 'scoreboard',
    });
    setCalibrationStatus(
      'Choose the scoreboard state you just saw. We only align when the state is unique.',
    );
    setNextRunAfterMs(null);
    initializedBaseballMarketRef.current = metadata.providerMarketId;
  }, [isBaseball, metadata.providerMarketId, sportsState]);

  useEffect(() => {
    if (
      accessState !== 'granted' ||
      providerMode !== 'polymarket' ||
      restorationSettings.selectedEventSlug === undefined ||
      restoredLiveSelectionRef.current
    )
      return;
    restoredLiveSelectionRef.current = true;
    void (async () => {
      try {
        const event = await new PolymarketReadOnlyAdapter().resolveEvent(
          restorationSettings.selectedEventSlug ?? '',
        );
        const market = event.markets.find(
          (candidate) => candidate.providerMarketId === restorationSettings.selectedMarketId,
        );
        if (market === undefined) {
          setSelectedEvent(null);
          setMarketMessage(
            `The previous ${event.title} contract is no longer active. Choose another live contract.`,
          );
          return;
        }
        setSelectedEvent(event);
        await startLiveMarket(event, market);
      } catch (error) {
        setMarketMessage(
          `Could not restore the previous live market. ${classifyProviderError(error).message}`,
        );
      }
    })();
  }, [accessState, providerMode, restorationSettings, startLiveMarket]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (
        isDemoRef.current &&
        demoClock.wallNowMs() < FIXTURE_BASE_TIMESTAMP_MS + 14 * 60_000 &&
        engineRef.current.timeline.snapshot().mode === 'playing'
      )
        demoClock.advanceBy(250);
      if (!isDemoRef.current)
        sportsStatesRef.current = [...sportsSourceRef.current.states(clockRef.current.wallNowMs())];
      setProjection(engineRef.current.projection());
    }, 250);
    return () => window.clearInterval(timer);
  }, [demoClock]);

  useEffect(() => {
    if (!hydrated) return;
    const settings: PersistedSettings = {
      version: 2,
      providerMode,
      sport,
      delaySeconds,
      strict,
      displayMode,
      syncMode,
      ...(selectedEvent === null ? {} : { selectedEventSlug: selectedEvent.slug }),
      ...(metadata.provider === 'fixture' ? {} : { selectedMarketId: metadata.providerMarketId }),
    };
    try {
      window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    } catch {
      // Private browsing and disabled storage must not break synchronization.
    }
  }, [
    delaySeconds,
    displayMode,
    hydrated,
    metadata,
    providerMode,
    selectedEvent,
    sport,
    strict,
    syncMode,
  ]);

  useEffect(() => {
    const primaryOutcome = displayOutcomes[0]?.projection;
    onPublicSnapshot?.({
      title: metadata.title,
      provider: metadata.provider,
      probability: primaryOutcome?.currentPrice ?? null,
      bestBid: primaryOutcome?.bestBid ?? null,
      bestAsk: primaryOutcome?.bestAsk ?? null,
      delaySeconds,
      aligned: !projection.frozen,
      frozen: projection.frozen,
      updatedAtMs: Date.now(),
    });
  }, [delaySeconds, displayOutcomes, metadata, onPublicSnapshot, projection.frozen]);

  useEffect(() => {
    if (subscribeVideoEvents === undefined) return;
    return subscribeVideoEvents((event) => {
      const timeline = engineRef.current.timeline;
      if (event.kind === 'pause') timeline.pause('video_pause');
      if (event.kind === 'resume') timeline.resume();
      if (event.kind === 'buffering') {
        timeline.pause('buffering');
        timeline.reduceConfidence(0.03, 'buffering');
      }
      if (event.kind === 'seek') timeline.seekBy(event.deltaMs);
      if (event.kind === 'playback-rate') timeline.setPlaybackRate(event.rate);
      if (event.kind === 'latency-estimate') {
        const observedAtMs = clockRef.current.wallNowMs();
        if (syncMode === 'auto') {
          const fromDelayMs = timeline.snapshot().estimatedDelayMs;
          const appliedDelayMs = commitViewerAnchor({
            type: 'video_event',
            viewerTimestampMs: observedAtMs - event.delayMs,
            rawDelayMs: event.delayMs,
            anchorConfidence: event.confidence,
            metadata: { method: event.method },
          });
          setSportsSyncStatus(
            `Video program time detected automatically. Delay is ${(appliedDelayMs / 1_000).toFixed(1)}s.`,
          );
          setPendingVideoAnchor(null);
          setLastAdjustment({
            fromDelayMs,
            toDelayMs: appliedDelayMs,
            appliedAtMs: observedAtMs,
            method: event.method,
          });
        } else if (syncMode === 'confirm') {
          setPendingVideoAnchor(
            createPendingVideoAnchor(event.delayMs, event.confidence, observedAtMs),
          );
          setSportsSyncStatus(
            `Video program time detected at ${(event.delayMs / 1_000).toFixed(1)}s. Review and apply it below.`,
          );
        }
      }
      if (event.kind === 'unavailable') timeline.reduceConfidence(0.08, event.reason);
      refresh();
    });
  }, [commitViewerAnchor, refresh, subscribeVideoEvents, syncMode]);

  const applyPendingVideoAnchor = () => {
    if (pendingVideoAnchor === null) return;
    const observedAtMs = clockRef.current.wallNowMs();
    const fromDelayMs = engineRef.current.timeline.snapshot().estimatedDelayMs;
    const plan = planConfirmedVideoAnchor(pendingVideoAnchor, observedAtMs, fromDelayMs);
    const appliedDelayMs = commitViewerAnchor({
      type: 'video_event',
      viewerTimestampMs: plan.viewerTimestampMs,
      rawDelayMs: plan.rawDelayMs,
      anchorConfidence: plan.confidence,
      metadata: { method: plan.method, confirmed: true },
    });
    setLastAdjustment({
      fromDelayMs: plan.previousDelayMs,
      toDelayMs: appliedDelayMs,
      appliedAtMs: observedAtMs,
      method: `${pendingVideoAnchor.method}-confirmed`,
    });
    setPendingVideoAnchor(null);
    setSportsSyncStatus(
      `Confirmed timing applied. Delay is ${(appliedDelayMs / 1_000).toFixed(1)}s.`,
    );
  };

  const undoLastAdjustment = () => {
    if (lastAdjustment === null) return;
    setDelay(lastAdjustment.fromDelayMs / 1_000, false);
    setSportsSyncStatus(
      `Last ${lastAdjustment.method.replaceAll('-', ' ')} adjustment was undone.`,
    );
    setLastAdjustment(null);
  };

  const gatewayUrl = () => `http://${window.location.hostname}:8787`;
  const createRoom = async () => {
    try {
      const response = await fetch(`${gatewayUrl()}/rooms`, { method: 'POST' });
      if (!response.ok) throw new Error('Gateway unavailable');
      const room = (await response.json()) as { code: string };
      setRoomCode(room.code);
      setRoomStatus('Room created · selection shared; your delay stays private');
    } catch {
      setRoomStatus('Start the local gateway to pair another client');
    }
  };
  const joinRoom = async () => {
    try {
      const response = await fetch(`${gatewayUrl()}/rooms/${roomCode.toUpperCase()}`);
      if (!response.ok) throw new Error('Room not found');
      setRoomStatus('Paired · personal delay remains on this device');
    } catch {
      setRoomStatus('Room not found or gateway unavailable');
    }
  };

  const exportResearchSession = () => {
    if (!exportAllowed) {
      setExportStatus('Benchmark export unlocks after the live game ends to avoid spoilers.');
      return;
    }
    const jsonl = researchRecorderRef.current.exportJsonl();
    const blob = new Blob([jsonl], { type: 'application/x-ndjson' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${researchSessionIdRef.current}.jsonl`;
    link.click();
    URL.revokeObjectURL(url);
    setExportStatus(`Exported ${researchRecorderRef.current.all().length} sanitized observations.`);
  };

  return (
    <main
      className={`ms-app ${compact ? 'ms-compact' : ''}`}
      data-hydrated={hydrated ? 'true' : 'false'}
    >
      <header className="ms-topbar">
        <a className="ms-brand" href="#main">
          MarketSync
        </a>
        <div className="ms-connection">
          <i className={health.connected ? '' : 'offline'} />
          {activeIsDemo ? 'Demo ready' : health.connected ? 'Live feed' : 'Connecting'}
          <button
            type="button"
            className="ms-feed-refresh"
            onClick={() => void refreshLiveFeed()}
            disabled={feedRefreshing}
            aria-label="Refresh live prices, game clock, and play-by-play"
            title={feedRefreshLabel || 'Refresh live prices, game clock, and play-by-play'}
          >
            <span aria-hidden="true">↻</span>
            {feedRefreshing
              ? 'Refreshing…'
              : /refreshed/i.test(feedRefreshLabel)
                ? 'Refreshed'
                : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="ms-shell">
        <aside
          className={`ms-discovery ${compactBrowseOpen ? 'browse-open' : ''}`}
          aria-label="Market discovery"
        >
          <div className="ms-provider-tabs" aria-label="Provider">
            <button
              type="button"
              className={providerMode === 'polymarket' ? 'active' : ''}
              onClick={() => setProviderMode('polymarket')}
            >
              Polymarket Live
            </button>
            <button
              type="button"
              className={providerMode === 'demo' ? 'active' : ''}
              onClick={() => setProviderMode('demo')}
            >
              Demo
            </button>
          </div>
          {compact ? (
            <button
              type="button"
              className="ms-compact-browse"
              onClick={() => setCompactBrowseOpen((open) => !open)}
            >
              {compactBrowseOpen ? 'Close games' : 'Browse games'}
            </button>
          ) : null}

          {providerMode === 'polymarket' ? (
            <>
              <div className="ms-live-heading">
                <h2>Live markets</h2>
                <span />
              </div>
              {accessState !== 'granted' ? (
                <section className="ms-permission-card">
                  <h3>Connect public market data</h3>
                  <p>
                    MarketSync needs access only to public read-only odds, scoreboard, and
                    play-by-play endpoints.
                  </p>
                  <button
                    type="button"
                    onClick={() => void requestAndLoadLive()}
                    disabled={accessState === 'requesting'}
                  >
                    {accessState === 'requesting'
                      ? 'Requesting…'
                      : accessState === 'denied'
                        ? 'Try again'
                        : 'Enable live markets'}
                  </button>
                </section>
              ) : (
                <>
                  <div className="ms-market-tools">
                    <input
                      aria-label="Search live markets"
                      placeholder="Search teams or leagues"
                      value={query}
                      onChange={(event) => setQuery(event.target.value)}
                    />
                    <select
                      aria-label="Sport filter"
                      value={sportFilter}
                      onChange={(event) => setSportFilter(event.target.value)}
                    >
                      {sports.map((value) => (
                        <option key={value}>{value}</option>
                      ))}
                    </select>
                    <button type="button" onClick={() => void loadEvents()}>
                      Refresh
                    </button>
                  </div>
                  {eventsLoading ? (
                    <p className="ms-state-message">Loading active sports markets…</p>
                  ) : null}
                  {eventsError ? (
                    <p className="ms-state-message error" role="alert">
                      {eventsError}
                    </p>
                  ) : null}
                  {!eventsLoading && events.length === 0 && !eventsError ? (
                    <p className="ms-state-message">
                      No active sports markets are available right now.
                    </p>
                  ) : null}
                  <div className="ms-event-groups">
                    {liveEvents.length > 0 ? <h3>Live</h3> : null}
                    {liveEvents.map((event) => (
                      <EventButton
                        key={event.id}
                        event={event}
                        selected={selectedEvent?.id === event.id}
                        onClick={() => {
                          setSelectedEvent(event);
                          if (event.markets.length === 1 && event.markets[0] !== undefined)
                            void startLiveMarket(event, event.markets[0]);
                        }}
                      />
                    ))}
                    {upcomingEvents.length > 0 ? <h3>Upcoming</h3> : null}
                    {upcomingEvents.map((event) => (
                      <EventButton
                        key={event.id}
                        event={event}
                        selected={selectedEvent?.id === event.id}
                        onClick={() => {
                          setSelectedEvent(event);
                          if (event.markets.length === 1 && event.markets[0] !== undefined)
                            void startLiveMarket(event, event.markets[0]);
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
              <div className="ms-url-entry">
                <label htmlFor="market-reference">Live market URL or ID</label>
                <div>
                  <input
                    id="market-reference"
                    value={marketReference}
                    placeholder="polymarket.com/event/…"
                    onChange={(event) => setMarketReference(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') void resolveMarketReference();
                    }}
                  />
                  <button type="button" onClick={() => void resolveMarketReference()}>
                    Open
                  </button>
                </div>
                <p role="status">{marketMessage}</p>
              </div>
            </>
          ) : (
            <>
              <div className="ms-live-heading">
                <h2>Demo games</h2>
                <span />
              </div>
              <p className="ms-demo-copy">Deterministic offline scenarios. No real-world odds.</p>
              <div className="ms-event-groups">
                {fixtureList.map((fixture) => (
                  <button
                    key={fixture.id}
                    type="button"
                    className={`ms-event-row ${sport === fixture.id ? 'active' : ''}`}
                    onClick={() => setSport(fixture.id)}
                  >
                    <span>
                      <strong>{fixture.metadata.title}</strong>
                      <small>{fixture.id} · replaying</small>
                    </span>
                    <b>Demo</b>
                  </button>
                ))}
              </div>
            </>
          )}
        </aside>

        <section id="main" className="ms-main-column">
          <div className="ms-market-selectors">
            <div>
              <span>Event</span>
              <strong>{selectedEvent?.title ?? metadata.title}</strong>
            </div>
            {selectedEvent !== null && selectedEvent.markets.length > 1 ? (
              <label>
                Contract
                <select
                  aria-label="Contract"
                  value={metadata.providerMarketId}
                  onChange={(event) => {
                    const market = selectedEvent.markets.find(
                      (candidate) => candidate.providerMarketId === event.target.value,
                    );
                    if (market !== undefined) void startLiveMarket(selectedEvent, market);
                  }}
                >
                  <option value="">Choose a contract</option>
                  {selectedEvent.markets.map((market) => (
                    <option key={market.providerMarketId} value={market.providerMarketId}>
                      {market.title}
                    </option>
                  ))}
                </select>
              </label>
            ) : null}
          </div>
          <section className={`ms-market-panel ${displayMode === 'pulse' ? 'pulse-mode' : ''}`}>
            <div className="ms-panel-title">
              <div>
                <h1>{metadata.title}</h1>
                <p>
                  {projection.frozen
                    ? 'All market fields held at the last safe projection'
                    : 'No future information'}
                </p>
              </div>
              <div className="ms-panel-actions">
                <span className={projection.frozen ? 'warning' : ''}>
                  {projection.frozen ? 'Frozen for safety' : 'Aligned to your broadcast'}
                </span>
                <div className="ms-view-mode" role="group" aria-label="Market view">
                  <button
                    type="button"
                    aria-pressed={displayMode === 'chart'}
                    onClick={() => setDisplayMode('chart')}
                  >
                    Chart
                  </button>
                  <button
                    type="button"
                    aria-pressed={displayMode === 'pulse'}
                    onClick={() => setDisplayMode('pulse')}
                  >
                    Pulse
                  </button>
                </div>
              </div>
            </div>
            <div className="ms-outcome-prices">
              {displayOutcomes.map((outcome) => (
                <MomentumOutcome
                  key={outcome.id}
                  label={outcome.label}
                  projection={outcome.projection}
                  tone={outcome.tone}
                  displayMode={displayMode}
                  updateLabel={marketActivityLabel}
                  sport={activeSport}
                />
              ))}
            </div>
            {displayMode === 'chart' ? (
              <Suspense
                fallback={
                  <div className="ms-chart-loading" role="status">
                    Loading broadcast chart…
                  </div>
                }
              >
                <ProbabilityChart
                  dataKey={metadata.providerMarketId}
                  outcomes={displayOutcomes.map((outcome) => ({
                    label: outcome.label,
                    points: outcome.projection.chartPoints,
                    color: outcome.tone === 'blue' ? '#1f5ed8' : '#ed4b4b',
                    price: outcome.projection.currentPrice,
                  }))}
                  viewerTimestampMs={projection.viewerTimestampMs}
                  delaySeconds={delaySeconds}
                  refreshState={chartRefreshState}
                  activityLabel={marketActivityLabel}
                  activityTone={marketActivityTone}
                />
              </Suspense>
            ) : (
              <PulseUpdate
                event={latestSportsEvent}
                reaction={latestMarketReaction}
                marketLabel={primaryMarketLabel}
              />
            )}
            <SportsActivityFeed
              events={sportsEvents}
              viewerTimestampMs={projection.viewerTimestampMs}
              frozen={projection.frozen}
              syncStatus={sportsSyncStatus}
              coverageLabel={sportsCoverageLabel}
              marketLabel={primaryMarketLabel}
              marketPoints={primaryMarketPoints}
              onSyncEvent={syncToSportsEvent}
            />
          </section>
        </section>

        <aside className="ms-sync-panel">
          <section className="ms-reference">
            <div className="ms-section-heading">
              <h2>Reference broadcast</h2>
              <div className="ms-reference-actions">
                <span
                  className={
                    sportsProjection.stale || (!activeIsDemo && sportsFeedStatus === 'limited')
                      ? 'warning'
                      : ''
                  }
                >
                  {sportsProjection.stale
                    ? 'Stale'
                    : sportsProjection.estimated
                      ? 'Estimated to the second'
                      : sportsState === null
                        ? sportsFeedStatus === 'limited'
                          ? 'Limited coverage'
                          : 'Connecting'
                        : 'Live reference'}
                </span>
                <button
                  type="button"
                  className="ms-reference-refresh"
                  onClick={() => void refreshSportsFeed()}
                  disabled={feedRefreshing}
                  title={feedRefreshLabel || 'Refresh clock, score, and play-by-play'}
                  aria-label="Refresh clock, score, and play-by-play"
                >
                  <span aria-hidden="true">↻</span>
                  {feedRefreshing ? 'Refreshing' : 'Refresh'}
                </button>
              </div>
            </div>
            <div className="ms-reference-grid">
              <span>{sportsState?.period ?? '—'}</span>
              {isBaseball ? null : <strong>{sportsProjection.displayClock ?? '—'}</strong>}
              <span>
                {sportsState?.homeScore ?? '—'} — {sportsState?.awayScore ?? '—'}
              </span>
            </div>
            <p>
              <i />
              {sportsSelection?.descriptor.label ??
                (activeIsDemo ? 'Demo sports feed' : sportsCoverageLabel)}{' '}
              ·{' '}
              {sportsProjection.updateAgeMs === null
                ? 'waiting'
                : formatAge(sportsProjection.updateAgeMs)}
            </p>
          </section>
          <section className="ms-sync-controls">
            <div className="ms-section-heading">
              <h2>Synchronization</h2>
              <label className="ms-toggle">
                Strict anti-spoiler
                <input
                  type="checkbox"
                  checked={strict}
                  onChange={(event) => {
                    setStrict(event.target.checked);
                    engineRef.current.setStrictAntiSpoiler(event.target.checked);
                    refresh();
                  }}
                />
                <span />
              </label>
            </div>
            <div className="ms-sync-modes" role="group" aria-label="Synchronization mode">
              {(
                [
                  ['auto', 'Auto sync'],
                  ['confirm', 'Confirm plays'],
                  ['manual', 'Manual'],
                ] as const
              ).map(([mode, label]) => (
                <button
                  key={mode}
                  type="button"
                  aria-pressed={syncMode === mode}
                  onClick={() => {
                    setSyncMode(mode);
                    if (mode !== 'confirm') setPendingVideoAnchor(null);
                  }}
                >
                  {label}
                </button>
              ))}
            </div>
            {lastAnchor === undefined ? (
              <div className="ms-sync-onboarding">
                <strong>Set your broadcast timing</strong>
                <span>
                  Choose a mode, then use program time, a confirmed play, or the delay slider.
                  Strict mode keeps every market field behind your screen.
                </span>
              </div>
            ) : null}
            {pendingVideoAnchor === null ? null : (
              <div className="ms-sync-candidate" role="status">
                <div>
                  <strong>{(pendingVideoAnchor.delayMs / 1_000).toFixed(1)}s timing found</strong>
                  <span>
                    Program time · {Math.round(pendingVideoAnchor.confidence * 100)}% confidence
                  </span>
                </div>
                <div>
                  <button type="button" onClick={applyPendingVideoAnchor}>
                    Apply this timing
                  </button>
                  <button type="button" onClick={() => setPendingVideoAnchor(null)}>
                    Dismiss
                  </button>
                </div>
              </div>
            )}
            {lastAdjustment === null ? null : (
              <button type="button" className="ms-undo-sync" onClick={undoLastAdjustment}>
                Undo last timing adjustment
              </button>
            )}
            <details className="ms-anchor-history">
              <summary>
                Recent timing anchors <span>{recentAnchors.length}</span>
              </summary>
              {recentAnchors.length === 0 ? (
                <p>No confirmed timing anchors yet.</p>
              ) : (
                <ul>
                  {recentAnchors.map((anchor) => {
                    const method = anchor.metadata['method'];
                    const smoothedDelayMs = anchor.metadata['smoothedDelayMs'];
                    return (
                      <li key={anchor.id}>
                        <div>
                          <strong>
                            {typeof method === 'string'
                              ? method.replaceAll('-', ' ')
                              : anchor.type.replaceAll('_', ' ')}
                          </strong>
                          <span>
                            {formatAge(
                              Math.max(0, clockRef.current.wallNowMs() - anchor.realTimestampMs),
                            )}
                          </span>
                        </div>
                        <span>
                          {(
                            (typeof smoothedDelayMs === 'number'
                              ? smoothedDelayMs
                              : anchor.estimatedDelayMs) / 1_000
                          ).toFixed(1)}
                          s · {Math.round(anchor.confidence * 100)}%
                        </span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </details>
            <div className="ms-summary">
              <div>
                <strong>{delaySeconds.toFixed(1)}s</strong>
                <span>delay</span>
              </div>
              <div>
                <strong>{Math.round(confidence * 100)}%</strong>
                <span>confidence</span>
              </div>
              <div>
                <strong>{qualityLabel}</strong>
                <span>quality</span>
              </div>
            </div>
            <label className="ms-range-label">
              Delay <output>{delaySeconds.toFixed(1)}s</output>
              <input
                aria-label="Viewer delay"
                type="range"
                min="0"
                max="180"
                step="0.25"
                value={delaySeconds}
                onChange={(event) => setDelay(Number(event.target.value))}
              />
            </label>
            <div className="ms-adjustments">
              {[-5, -1, -0.25, 0.25, 1, 5].map((value) => (
                <DelayButton key={value} value={value} onClick={adjustDelay} />
              ))}
            </div>
            <div className="ms-primary-controls">
              <button type="button" className="primary" onClick={togglePause}>
                {engineRef.current.timeline.snapshot().mode === 'playing'
                  ? 'Pause chart'
                  : 'Resume chart'}
              </button>
            </div>
            <div className="ms-guided-sync">
              <div>
                <strong>Guided score sync</strong>
                <span>Uses the next confirmed score without showing it early.</span>
              </div>
              {nextScoreAfterMs === null ? (
                <button type="button" onClick={armNextScore} disabled={sportsState === null}>
                  Sync on next score
                </button>
              ) : (
                <div className="ms-guided-sync-actions">
                  <button type="button" onClick={() => completeNextScore('home')}>
                    {homeLabel} scored
                  </button>
                  <button type="button" onClick={() => completeNextScore('away')}>
                    {awayLabel} scored
                  </button>
                  <button type="button" onClick={() => setNextScoreAfterMs(null)}>
                    Cancel
                  </button>
                </div>
              )}
            </div>
          </section>
          {isBaseball ? (
            <section className="ms-baseball-calibration">
              <div className="ms-section-heading">
                <div>
                  <h2>Match a play</h2>
                  <p>Baseball aligns to a unique scoreboard event, not a game clock.</p>
                </div>
              </div>
              <p className="ms-calibration-status" role="status" aria-live="polite">
                {calibrationStatus}
              </p>
              <div className="ms-calibration-form">
                <label>
                  Moment
                  <select
                    aria-label="Baseball moment"
                    value={baseballForm.moment}
                    onChange={(event) =>
                      setBaseballForm((current) => ({
                        ...current,
                        moment: event.target.value as BaseballMoment,
                      }))
                    }
                  >
                    <option value="scoreboard">Scoreboard state</option>
                    <option value="run">Run scored</option>
                    <option value="half-inning">Half-inning started</option>
                  </select>
                </label>
                <label>
                  Inning
                  <input
                    aria-label="Baseball inning"
                    type="number"
                    min="1"
                    max="30"
                    value={baseballForm.inning}
                    onChange={(event) =>
                      setBaseballForm((current) => ({
                        ...current,
                        inning: Math.max(1, Number(event.target.value)),
                      }))
                    }
                  />
                </label>
                <fieldset>
                  <legend>Half</legend>
                  <button
                    type="button"
                    className={baseballForm.half === 'top' ? 'active' : ''}
                    onClick={() => setBaseballForm((current) => ({ ...current, half: 'top' }))}
                  >
                    Top
                  </button>
                  <button
                    type="button"
                    className={baseballForm.half === 'bottom' ? 'active' : ''}
                    onClick={() => setBaseballForm((current) => ({ ...current, half: 'bottom' }))}
                  >
                    Bottom
                  </button>
                </fieldset>
                <div className="ms-score-inputs">
                  <label>
                    {homeLabel}
                    <input
                      aria-label={`${homeLabel} score`}
                      type="number"
                      min="0"
                      value={baseballForm.homeScore}
                      onChange={(event) =>
                        setBaseballForm((current) => ({
                          ...current,
                          homeScore: Math.max(0, Number(event.target.value)),
                        }))
                      }
                    />
                  </label>
                  <span>—</span>
                  <label>
                    {awayLabel}
                    <input
                      aria-label={`${awayLabel} score`}
                      type="number"
                      min="0"
                      value={baseballForm.awayScore}
                      onChange={(event) =>
                        setBaseballForm((current) => ({
                          ...current,
                          awayScore: Math.max(0, Number(event.target.value)),
                        }))
                      }
                    />
                  </label>
                </div>
                <fieldset>
                  <legend>Outs</legend>
                  {([0, 1, 2] as const).map((outs) => (
                    <button
                      key={outs}
                      type="button"
                      className={baseballForm.outs === outs ? 'active' : ''}
                      onClick={() => setBaseballForm((current) => ({ ...current, outs }))}
                    >
                      {outs}
                    </button>
                  ))}
                </fieldset>
                <label>
                  Count <span>optional</span>
                  <select
                    aria-label="Baseball count"
                    value={baseballForm.count}
                    onChange={(event) =>
                      setBaseballForm((current) => ({
                        ...current,
                        count: event.target.value,
                      }))
                    }
                  >
                    <option value="">Any count</option>
                    {[
                      '0-0',
                      '1-0',
                      '0-1',
                      '2-0',
                      '1-1',
                      '0-2',
                      '3-0',
                      '2-1',
                      '1-2',
                      '3-1',
                      '2-2',
                      '3-2',
                    ].map((count) => (
                      <option key={count}>{count}</option>
                    ))}
                  </select>
                </label>
              </div>
              <button type="button" className="ms-use-play" onClick={calibrateBaseballState}>
                Use this play
              </button>
              <div className="ms-next-run">
                <div>
                  <strong>Tap on next run</strong>
                  <span>Fast two-step alignment when the scoreboard state is unclear.</span>
                </div>
                {nextRunAfterMs === null ? (
                  <button type="button" onClick={armNextRun}>
                    Start next-run alignment
                  </button>
                ) : (
                  <div className="ms-run-buttons">
                    <button type="button" onClick={() => completeNextRun('home')}>
                      {homeLabel} scored
                    </button>
                    <button type="button" onClick={() => completeNextRun('away')}>
                      {awayLabel} scored
                    </button>
                    <button type="button" onClick={() => setNextRunAfterMs(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </div>
            </section>
          ) : null}
          <details className="ms-details">
            <summary>
              Connection quality <span>{health.connected ? 'Excellent' : 'Reconnecting'}</span>
            </summary>
            <dl>
              <div>
                <dt>Source</dt>
                <dd>{health.source}</dd>
              </div>
              <div>
                <dt>Visible price</dt>
                <dd>{activeIsDemo ? 'Replay' : formatAge(visibleUpdateAgeMs)}</dd>
              </div>
              <div>
                <dt>Transport</dt>
                <dd>{activeIsDemo ? 'Local' : formatAge(transportAgeMs)}</dd>
              </div>
              <div>
                <dt>Reconnects</dt>
                <dd>{health.reconnectCount}</dd>
              </div>
              <div>
                <dt>Invalid messages</dt>
                <dd>{health.invalidMessageCount}</dd>
              </div>
              <div>
                <dt>Sports source</dt>
                <dd>{sportsSelection?.descriptor.label ?? 'Waiting'}</dd>
              </div>
              <div>
                <dt>Source quality</dt>
                <dd>
                  {sportsSelection === null ? '—' : `${Math.round(sportsSelection.score * 100)}%`}
                </dd>
              </div>
            </dl>
          </details>
          <details className="ms-details">
            <summary>
              Research session <span>{researchSummary.observationCount} visible</span>
            </summary>
            <dl>
              <div>
                <dt>Sports provider p50</dt>
                <dd>{formatLatency(researchSummary.sportsProviderLatency.medianMs)}</dd>
              </div>
              <div>
                <dt>Market transport p50</dt>
                <dd>{formatLatency(researchSummary.marketTransportLatency.medianMs)}</dd>
              </div>
              <div>
                <dt>Viewer delay p50</dt>
                <dd>{formatLatency(researchSummary.viewerBroadcastDelay.medianMs)}</dd>
              </div>
              <div>
                <dt>Current drift</dt>
                <dd>{formatLatency(researchSummary.currentDriftMs)}</dd>
              </div>
              <div>
                <dt>Last anchor</dt>
                <dd>{lastAnchorAgeMs === null ? 'None yet' : formatAge(lastAnchorAgeMs)}</dd>
              </div>
              <div>
                <dt>Approximate timestamps</dt>
                <dd>{researchSummary.approximateSportsLatencySamples}</dd>
              </div>
            </dl>
            <div className="ms-research-export">
              <button type="button" onClick={exportResearchSession} disabled={!exportAllowed}>
                Export sanitized JSONL
              </button>
              <p role="status">
                {exportStatus ||
                  (exportAllowed
                    ? 'Bounded normalized timing only. No raw payloads or credentials.'
                    : 'Available after the live game ends to prevent spoilers.')}
              </p>
            </div>
          </details>
          {enableOverlayForActiveSite !== undefined ? (
            <section className="ms-overlay-control">
              <button
                type="button"
                onClick={async () => {
                  const result = await enableOverlayForActiveSite();
                  setOverlayStatus(
                    result === 'enabled'
                      ? 'Overlay enabled on the active site.'
                      : result === 'denied'
                        ? 'Site access was not granted.'
                        : 'No supported active page was found.',
                  );
                }}
              >
                Enable overlay on this site
              </button>
              {overlayStatus ? <p role="status">{overlayStatus}</p> : null}
            </section>
          ) : null}
        </aside>
      </div>

      {!compact ? (
        <footer className="ms-footer-tools">
          <details>
            <summary>Demo and companion tools</summary>
            <div className="ms-tool-row">
              <button
                type="button"
                onClick={toggleLowConfidence}
                className={lowConfidence ? 'danger' : ''}
              >
                Low confidence
              </button>
              <button type="button" onClick={togglePause}>
                {engineRef.current.timeline.snapshot().mode === 'playing'
                  ? 'Pause video'
                  : 'Resume video'}
              </button>
              <input
                aria-label="Room code"
                maxLength={6}
                placeholder="Room code"
                value={roomCode}
                onChange={(event) => setRoomCode(event.target.value.toUpperCase())}
              />
              <button type="button" onClick={joinRoom}>
                Join
              </button>
              <button type="button" onClick={() => void createRoom()}>
                Create
              </button>
              <span>{roomStatus}</span>
            </div>
          </details>
        </footer>
      ) : null}
    </main>
  );
};

const EventButton = ({
  event,
  selected,
  onClick,
}: {
  event: PolymarketEventSummary;
  selected: boolean;
  onClick: () => void;
}) => (
  <button type="button" className={`ms-event-row ${selected ? 'active' : ''}`} onClick={onClick}>
    <span>
      <strong>{event.title}</strong>
      <small>
        {event.league ?? event.sport} ·{' '}
        {event.live ? 'Live now' : formatStart(event.startTimestampMs)}
      </small>
    </span>
    <b>
      {event.markets.length} {event.markets.length === 1 ? 'contract' : 'contracts'}
    </b>
  </button>
);
