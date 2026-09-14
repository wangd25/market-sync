# Deployment

Phase 1 is local-first. The Next app may later deploy to a Node-compatible host. The gateway must deploy separately with TLS, server-only secrets, origin restrictions, authenticated rooms, rate limits, durable expiring room state, observability with redaction, and horizontal fan-out (for example a managed message bus and durable store). In-memory rooms are not multi-instance safe.

Build the extension with `pnpm --filter @marketsync/extension build`, inspect `.output/chrome-mv3`, and load it unpacked. Store release review must confirm permissions, MV3 CSP, bundled licenses/attribution, privacy disclosures, and optional host-permission UX.

Never set private environment variables with a `NEXT_PUBLIC_` prefix. `KALSHI_API_KEY_ID` and `KALSHI_PRIVATE_KEY_PATH` belong only to the gateway runtime.
