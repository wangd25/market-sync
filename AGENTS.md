# MarketSync project map

MarketSync delays read-only prediction-market information to a viewer-controlled broadcast timeline.

## Map

- `apps/web`: Next.js companion app and simulator.
- `apps/extension`: WXT Manifest V3 side panel, local-page overlay, and video observer.
- `packages/core`: framework-independent piecewise timeline, tick buffer, fake clock, and delayed projection.
- `packages/shared-types`: normalized types and runtime schemas.
- `packages/market-adapters`: read-only provider parsing, validation, health, and quality scoring.
- `packages/sports-models`: sport synchronization strategy registry and camera interfaces.
- `packages/fixtures`: deterministic soccer, basketball, tennis, and baseball simulations.
- `packages/ui`: shared React chart/dashboard and bounded IndexedDB abstraction.
- `services/gateway`: in-memory rooms and server-only mocked/live Kalshi boundary.
- `docs`: architecture, product, security, testing, deployment, limitations, scenarios, and roadmap.

## Commands

Use Node 24 and pnpm 11. Run `pnpm install`, `pnpm dev`, `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, and `pnpm test:e2e` from the root. See [README.md](README.md) for surface-specific commands.

## Invariants

1. UI code reads market data only from `projectDelayedMarket`; never expose a raw provider store.
2. Strict mode freezes every market-derived field atomically below the confidence threshold.
3. Wall-clock Unix milliseconds align systems; monotonic milliseconds measure local durations.
4. This repository never contains trades, wallet code, private keys, credentials, or remote extension scripts.
5. Validate every external payload at runtime and keep browser history bounded.

Never commit `.env`, `.env.local`, `.key`, `.pem`, wallet material, raw auth headers, camera frames, or provider payloads containing user data. Tests must be deterministic and not depend on a live event. Read [docs/security.md](docs/security.md), [docs/synchronization.md](docs/synchronization.md), and [docs/testing.md](docs/testing.md) before changing trust boundaries or timeline logic.
