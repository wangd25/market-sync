# Roadmap

## Phase 2

Implemented in this milestone: live/upcoming Polymarket sports discovery, robust event/market URL resolution, multi-contract selection, receiver-safe fetch, bounded history bootstrap, public market/sports WebSockets, heartbeat/reconnect/stale health, system-clock live sessions, delayed sports projection, durable bounded local recovery, explicit provider and per-site permission UX, synchronized overlay, accessible video lifecycle events, expanded demos, and the liquid-glass responsive UI.

Follow-up hardening: broaden recorded sports-message variants, add optional scheduled live smoke coverage, improve sport/league metadata coverage, and validate explicit active-site grants in a headed Chrome extension harness in addition to the deterministic denial/content-script paths.

Synchronization hardening completed after Phase 2: two-second structured play confirmation,
source-ordered sparse-state merging, explicit ESPN play scores, spoiler-blind next-score calibration,
rolling-median anchors, HLS program-time auto-calibration, buffering recovery, effective pause/rate
delay tracking, and wall-clock live-edge clamping.

Research milestone completed: strict sports-observation provenance, provider-neutral quality selection,
stale-source failover, revision/correction handling, bounded normalized research capture, sanitized
completed-session export, separate latency distributions, drift/anchor diagnostics, and Auto/Confirm/
Manual synchronization controls. The current public sources remain prototype-grade; these mechanisms
make them measurable and replaceable rather than asserting production latency or accuracy.

Production-evaluation foundation completed: strict sanitized benchmark import and per-signal reports,
canonical event resolution, gateway provider/replay contracts, capability selection, source hysteresis,
period/clock regression and disagreement safety, persisted confirmation modes with undo and anchor
history, batched research writes, lazy chart loading, and persistent wheel zoom. Fixture results verify
the pipeline only; real same-game provider captures remain required.

## Phase 3

Introduce authenticated expiring rooms, durable shared event selection, abuse controls, production observability with redaction, and horizontally scalable fan-out. Run the documented same-game provider benchmark, negotiate a licensed primary play-by-play source, and move source ingestion/failover behind the server gateway.

The provider evaluation and synchronization design are detailed in [live sports data strategy](live-sports-data-strategy.md). The sports-model registry now selects and fails over between normalized sources without weakening the delayed projection boundary; production work moves that proven contract to the gateway rather than changing the client projection.

## Phase 4

Prototype explicit-permission local camera sampling and user-confirmed scoreboard regions. Evaluate OCR accuracy per sport without uploading or retaining raw frames by default.

Trading, wallets, stream access, DRM workarounds, and unauthorized content discovery are permanently out of scope.
