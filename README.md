# MarketSync

MarketSync is a locally testable anti-spoiler synchronization layer for read-only prediction-market information. It buffers normalized market ticks and reveals them only when a viewer-controlled virtual broadcast timeline reaches each tick. It never places trades or requests wallet credentials.

The Phase 2 milestone includes a Next.js companion app, a WXT Chrome side panel, an explicitly activated Shadow DOM overlay, deterministic multi-sport demos, live Polymarket sports discovery, contract selection, public history and WebSocket updates, conservative delayed sports state, a framework-independent synchronization core, in-memory room pairing, and a credential-safe mocked Kalshi boundary.

## Prerequisites

- Node.js 24 (`nvm use` reads `.nvmrc`)
- pnpm 11 (`corepack enable` if `pnpm` is unavailable)
- Chromium installed for Playwright: `pnpm exec playwright install chromium`

## Install and verify

```bash
pnpm install
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Provider benchmark output is sanitized and written to ignored `diagnostics/`:

```bash
pnpm benchmark:providers -- --provider=fixture

# Analyze one or more completed sanitized research exports
pnpm benchmark:providers -- --input=/absolute/path/to/session.jsonl
```

## Run locally

Start the companion app and gateway together:

```bash
pnpm dev
```

Open [http://localhost:3000](http://localhost:3000). Demo mode begins with a 20-second personal delay. A market tick sourced at time T is revealed at viewer wall time T + 20 seconds. Pause freezes the virtual timeline; **I just saw an event** adds an alignment anchor; **Low confidence** under the progressively disclosed demo tools demonstrates strict atomic freeze.

Move the pointer over the probability chart and use the scroll wheel to zoom its time range. New delayed points do not reset a user-selected zoom; **Reset zoom** returns to the full visible history. This changes presentation only and never moves the viewer cutoff.

Individual services:

```bash
pnpm dev:web
pnpm dev:gateway
pnpm dev:extension
```

## Load the unpacked Chrome extension

1. Run `pnpm build` or `pnpm --filter @marketsync/extension build`.
2. Open `chrome://extensions` in Chrome.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the absolute directory `apps/extension/.output/chrome-mv3` inside this repository.
6. Pin MarketSync if desired, then click its toolbar icon. Chrome opens the MarketSync side panel.
7. Open a supported page and choose **Enable overlay on this site** in the side panel. MarketSync checks the active HTTP(S) page, uses the user-granted `activeTab` capability, and never installs with `<all_urls>`. The local development hosts are statically permitted only for deterministic E2E coverage. Use the overlay's `×` button to hide it immediately.

## Open the companion app on another device

1. Connect both devices to the same trusted local network.
2. Run `pnpm dev` on the development computer. Both servers bind to `0.0.0.0`.
3. Find the computer’s LAN address (for example `192.168.1.24`).
4. On the phone/tablet, open `http://<LAN-IP>:3000`.
5. If the OS firewall asks, allow Node only on the trusted private network.
6. Create a room on one client and enter its six-character code on the other. The selected event is shared; each client’s delay remains local.

Do not expose the Phase 1 gateway directly to the public internet: it has no authentication or abuse controls.

## Polymarket Live

Choose **Polymarket Live**, approve the narrowly scoped Polymarket host request, and browse or search active sports events. Live events sort ahead of upcoming games. Event pages can contain multiple contracts, so MarketSync asks for a contract rather than choosing silently. Pasted event URLs, market URLs/slugs, query strings, fragments, and identifiers are resolved deliberately; fragments never enter provider requests.

After selection, MarketSync creates a fresh system-clock session, bootstraps bounded public price history for both binary assets, and subscribes to public market and sports WebSockets. Validated ticks enter `@marketsync/core`; React and the overlay receive only `projectDelayedMarket` output. Binary contracts render two complementary delayed prices and chart lines. Connection age, spread, reconnect count, and stale state are exposed. Reopening the panel restores bounded local history and preferences gracefully.

Baseball is calibrated by discrete plays rather than a fictional game clock. **Match a play** accepts inning, half, score, outs, optional count, and the kind of moment; it changes the delay only when the validated feed contains one unique match. **Tap on next run** arms a two-step team-specific score-change match. Ambiguous or absent states are rejected instead of guessed.

Demo remains an explicitly labeled offline fallback and uses an expanded deterministic stream that continues moving through a normal test session. Kalshi public REST still supports metadata, order books, and candlesticks, but is not selectable in the Phase 2 primary UI.

Kalshi WebSocket signing is server-only. Without `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH`, the gateway deliberately reports **Kalshi live unavailable** and stays in mocked mode. No sample key is included. MarketSync never requests a wallet, trading credential, order permission, or private user channel.

See [architecture](docs/architecture.md), [synchronization](docs/synchronization.md), [scenario matrix](docs/scenario-matrix.md), [security](docs/security.md), and [limitations](docs/product-limitations.md).

Lightweight Charts™ is used under its open-source license; attribution links are rendered beside every chart. TradingView has no affiliation with MarketSync.
