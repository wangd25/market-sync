# Architecture

MarketSync uses a pnpm workspace with three trust layers:

```text
untrusted providers -> strict schemas -> normalized observations -> source orchestrator
                                                                  |
viewer/video/anchors -> piecewise viewer timeline -> delayed projection -> UI
                                    |                             |
                                    +-> bounded research recorder <-+
server credentials -> gateway only (never browser) -> normalized read-only observations
```

`@marketsync/core` owns the viewer timeline, tick ordering/deduplication/pruning, confidence transitions, delayed market projection, and viewer-time sports projection. It has no React or framework dependency. `@marketsync/ui` owns session orchestration but renders only `DelayedMarketProjection` and delayed sports state; its chart, labels, colors, status, notifications, and overlay snapshots never read a raw provider store.

Demo sessions create a `FakeClock` engine and deterministic fixture stream. Live selections create a new `systemClock` engine, bootstrap normalized public history, and start one scoped market/sports WebSocket session. Cleanup closes sockets and timers; a market switch creates a fresh engine so old ticks cannot enter the next projection. Bounded IndexedDB recovery is keyed by provider and market.

The companion app and extension share the same dashboard/session code. The side panel publishes only a typed delayed public snapshot to extension storage; the overlay consumes that projection and reports accessible video lifecycle events back through typed runtime messages. The local gateway holds only shared room selection and revision in memory. Personal delay is absent from the room schema.

Provider adapters are isolated by reliability domain. A receiver-safe fetch wrapper preserves the browser `globalThis` binding while retaining injected test fetchers. Polymarket references distinguish events from markets, runtime-validate nested contracts, and classify invalid reference, permission, HTTP, validation, network, and internal failures. Market and sports WebSocket payloads are separately validated. Every sports update carries source authority, capabilities, provider event ID, revision, timestamp quality, receipt time, and monotonic receipt time.

`SportsSourceOrchestrator` selects a source deterministically from authority, capabilities, freshness, and validation history. It deduplicates provider IDs, replaces revisions, rejects unmarked score, period, and clock rollback, and fails over when the preferred feed is stale. A switch margin and hold period prevent source flapping; capability-specific selection allows scoreboard and play-by-play evaluation to diverge. Corrections become viewer-visible no earlier than their client receipt time. Cross-source score disagreement is surfaced as a projection threat rather than silently resolved.

`ProviderNeutralSportsGateway` is the server-owned contract for future licensed and public providers. Provider implementations resolve canonical events, subscribe, and replay normalized observations while keeping credentials and raw vendor responses inside the server trust boundary. The Kalshi signing boundary imports Node crypto and filesystem modules only in `services/gateway`.

`ResearchSessionRecorder` records only runtime-validated normalized observations, anchors, broadcast taps, and health. It is bounded by count and age, reports provider, market-transport, and viewer-delay distributions separately, and can export sanitized JSONL after a demo or completed event. Dashboard diagnostics use the viewer cutoff, so their counts and metrics cannot reveal observations from ahead of the broadcast.

The provider benchmark parser revalidates every JSONL line and caps imports. Reports split scoreboard, clock, and play-by-play; true timestamp latency never includes receipt approximations. Missing events, duplicates, corrections, ordering, disconnects, replay recovery, score agreement, market reaction, and viewer drift remain explicitly session-scoped.

The charting library is loaded as a separate client chunk. Wheel zoom changes only the visible time range; the delayed data boundary is unchanged. Batched research persistence reduces IndexedDB transactions and dashboard diagnostic renders during active feeds.

The Phase 2 interface uses an original deep-ink liquid-glass system with cyan/blue accents, luminous fine borders, restrained blur, accessible focus states, reduced-motion support, and a narrow-first hierarchy. It does not copy Polymarket branding or assets.
