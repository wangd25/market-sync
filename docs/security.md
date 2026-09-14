# Security and privacy

## Trust boundaries

- External JSON is untrusted and runtime validated before normalization.
- Browser UI and overlay receive delayed projections, not raw live stores.
- Extension scripts are bundled locally under Manifest V3 CSP; no eval, remote scripts, or runtime code download.
- Kalshi keys and RSA private-key files are read only by the Node gateway. Headers are never logged; the only log is a redacted availability statement.
- There is no order placement, wallet integration, auth token, DRM access, stream discovery, or privileged video extraction.

## Permissions

The extension requests `activeTab`, side-panel, storage, and scripting capabilities. It does not install with `<all_urls>`. Live mode explains and explicitly requests only the four public Polymarket origins and the credential-free ESPN site API origin used for best-effort play-by-play. Denial is distinct from provider HTTP, validation, CORS/offline, and internal failures. Overlay injection requires a separate per-site action; localhost matches exist only to support deterministic extension tests. The overlay uses Shadow DOM, controlled z-index, text-only insertion, immediate hide, persisted per-site geometry, compact mode, and fullscreen reparenting.

## Storage

Local settings include selected provider/event/contract, strict-mode preference, recent delay, and per-site overlay position. IndexedDB stores only bounded normalized ticks, normalized research observations, and anchors. Research capture is limited to 5,000 observations or six hours per in-memory session, and browser pruning applies the same six-hour horizon. Extension storage contains the current delayed public snapshot for overlay recovery. Never persist camera frames, unrestricted raw provider payloads, secrets, unrelated browsing history, or PII.

Research export is disabled during an unfinished live event. Demo and completed-event exports contain normalized JSONL only. Sports `discreteState` is reduced to a documented allowlist of event, description, play/team/possession/sequence, baseball state, player, and tennis score fields; unknown provider-specific keys are removed. The export contains no headers, credentials, browser URLs, camera data, or raw responses.

Benchmark imports use the same strict research schema, reject malformed lines atomically, and enforce an item cap before analysis. Reports inherit no raw payload fields. Gateway sports-provider implementations receive credentials only through server configuration and may emit only normalized `SportsObservation` values to orchestration.

## Camera placeholder

Camera sync is disabled behind a public development flag. Future use requires an explicit permission action, user-selected region, local processing where practical, retention of normalized clock/score only, no raw upload by default, and an immediate stop control.

The local room gateway has no authentication and must not be exposed publicly. Production needs authenticated membership, TTLs, rate limiting, input size limits, origin controls, encryption in transit, and abuse monitoring.
