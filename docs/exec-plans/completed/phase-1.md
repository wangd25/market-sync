# Phase 1 vertical slice — completed

## Goal

Deliver a locally testable MarketSync prototype in which deterministic market ticks are visible only when the viewer timeline reaches them. The same framework-independent synchronization engine and projection power a Next.js companion app and a Manifest V3 WXT side panel. A lightweight gateway supplies development room state and a credential-safe mocked Kalshi boundary.

## Delivered

1. Strict TypeScript pnpm workspace with shared lint, format, unit, browser, benchmark, and build commands.
2. Explicit normalized domain types and documented wall-clock/monotonic timestamp semantics.
3. Piecewise viewer timeline, bounded ordered/deduplicated tick buffer, confidence transitions, strict atomic freeze, and sole delayed UI projection.
4. Deterministic soccer, basketball, tennis, and baseball fixtures plus continuous, stop-clock, discrete, and asynchronous strategy interfaces.
5. Shared React probability chart and synchronization dashboard based on the accepted MarketSync visual concept.
6. Responsive companion app, fixture simulator, diagnostics, room pairing with private per-viewer delay, and disabled camera-mode architecture.
7. WXT MV3 side panel, localhost Shadow DOM overlay, fullscreen reparenting, and accessible-video observer.
8. Validated read-only Polymarket/Kalshi public adapters, server-only Kalshi signing boundary, credential-free mock mode, provider quality model, and fixture benchmark.
9. Twenty-six deterministic unit/integration tests and four passing Chromium browser/extension tests.
10. Architecture, scenarios, synchronization, source, security, testing, deployment, limitations, and roadmap documentation.

## Verified commands

- `pnpm install` — passed
- `pnpm typecheck` — passed across all workspace projects
- `pnpm lint` — passed
- `pnpm test` — 26 passed
- `pnpm build` — gateway, Next app, and Chrome MV3 extension passed
- `pnpm test:e2e` — 4 passed
- `pnpm benchmark:providers -- --provider=fixture` — passed; sanitized ignored JSON output

## Invariants verified

- UI market fields are computed only by `projectDelayedMarket`; future price, bid, ask, volume, status, color, and ancillary fields remain hidden.
- Reference sports state is independently filtered to the viewer timestamp.
- Strict low-confidence mode returns the prior complete safe projection.
- Room state contains selection and revision, not personal delay.
- Browser code contains no signing, private-key, wallet, or order-placement implementation.

## Deferred by design

Production persistence, authentication, abuse controls, analytics, billing, full camera OCR, authoritative sports feeds, production Kalshi credentials, full live WebSocket UI orchestration, and any trading workflow remain outside Phase 1.
