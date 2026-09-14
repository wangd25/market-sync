# Data sources

## Fixtures

Deterministic soccer, basketball, tennis, and baseball fixtures are the explicit offline demo. Odds contain hundreds of bounded ticks and sports observations progress throughout a normal session. Fixtures include running/stop clocks, discrete state, buffering controls, pause/seek/rate changes, reconnect, out-of-order messages, duplicates, and confidence contradictions.

## Polymarket

Configuration uses the official Gamma API for bounded active-sports discovery and event/market resolution, CLOB API for history and on-demand current book snapshots, unauthenticated public market WebSocket, and public sports WebSocket. Runtime Zod schemas validate event metadata, nested contracts, history, book snapshots, price changes, best-bid/ask, last trades, and sports messages before normalization. The client handles heartbeat, capped exponential reconnect with jitter, stale detection, message ordering, and subscription cleanup. No user channel, authentication, SDK trading method, wallet, bridge, or order endpoint is used.

Official references: [API overview](https://docs.polymarket.com/api-reference/introduction), [market WebSocket](https://docs.polymarket.com/market-data/websocket/market-channel).

## Public play-by-play

The extension can correlate a selected game by league, UTC date, and ordered home/away teams with the credential-free ESPN site scoreboard, then poll its Gamecast summary every four seconds for a fresh score/period/clock state and timestamped play descriptions. Responses are runtime validated; duplicate provider IDs and semantically identical descriptions at the same game clock are discarded. Normalized observations remain bounded and pass through the viewer-time cutoff. This is a best-effort, unofficial response contract: failure never replaces or disables the Polymarket score socket, and the feed is never settlement authority. The extension requests the narrow `site.api.espn.com` origin only as part of the same explicit live-data permission action.

Market-price movement labels use a one-percentage-point noise floor and progressively stronger visual tiers. Sport-specific event text is always labeled as an unconfirmed possibility; it is never substituted for provider play-by-play or used as synchronization truth.

## Kalshi

The public REST adapter supports market metadata/search, public order-book snapshots, and candlesticks using current fixed-point response fields. Official production/demo hosts are centralized. Live WebSocket authentication, when explicitly enabled, is signed in the gateway; missing server credentials prevent live startup. Phase 1 uses `MockKalshiLiveGateway` and displays its unavailable reason.

Official references: [order books](https://docs.kalshi.com/getting_started/orderbook_responses), [WebSocket quick start](https://docs.kalshi.com/getting_started/quick_start_websockets).

Sports state is an independent synchronization aid, not authoritative settlement data. Gamma metadata can provide the initial reported state; public sports messages are correlated by reliable game/event identifiers. Only observations at or before viewer time are displayed. Interpolation is limited to defensible running-clock states and is labeled estimated; breaks, completion, uncertainty, and stale feeds freeze at the last report. When a source reports only a whole soccer minute, the seconds display is an estimate from the provider wall-clock timestamp; Gamecast plays with an exact elapsed value replace that estimate when available.
