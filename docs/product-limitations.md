# Product limitations

MarketSync reduces spoiler risk; it cannot guarantee exact spoiler prevention.

- Off-camera events and editorial replay packages can make the broadcast timeline diverge from the game timeline.
- Golf, Olympics, cycling, and multi-car/multi-event coverage may switch subjects asynchronously; only conservative approximation is responsible.
- Reference feeds can be late, wrong, corrected, or absent. They are synchronization aids, not settlement sources.
- CDN and player latency varies over time, especially after buffering, quality changes, ad insertion, or device handoff.
- DRM, cross-origin frames, native players, casting, picture-in-picture, and mobile operating systems may hide player state. Manual/source-agnostic synchronization remains the fallback.
- Matching clocks repeat in stop-clock sports; clock-only calibration is ambiguous.
- Contract wording, settlement rules, outcome scope, and event identity can differ across providers. Consensus is blocked below the equivalence threshold.
- Illiquid markets may be stale, wide, or derived. A market price is not an official sports clock and can move for unrelated reasons.
- Public Polymarket APIs can change, rate-limit, omit sports identifiers, expose sparse history, or reject browser access. MarketSync reports these failures and preserves Demo mode; it does not promise provider uptime.
- Discovery is intentionally bounded and may not list every future event. Search and filters operate on the fetched catalog, not an exhaustive global sports database.
- Public sports messages may omit a clock or arrive only at transitions. MarketSync shows unavailable or last reported state rather than inventing unsupported precision; a second-level soccer clock derived from a whole-minute report is explicitly marked estimated and freezes when stale.
- ESPN Gamecast responses are credential-free but not a documented developer API contract. Coverage, fields, CORS behavior, or availability can change; MarketSync treats this layer as optional and retains the validated Polymarket scoreboard path.
- Chrome can suspend extension contexts, and accessible video events are unavailable for many cross-origin, DRM, native, cast, picture-in-picture, and mobile players. Manual synchronization remains required there.
- Provider disconnects, clock skew, out-of-order data, or contradictory anchors reduce confidence; strict mode freezes instead of guessing.
- Benchmark results describe only supplied completed sessions. Fixture metrics validate calculations but are not evidence of public or licensed provider speed, accuracy, or uptime.
- Canonical event resolution and gateway provider contracts are production-evaluation infrastructure; no licensed primary source is bundled, and the current browser public sources remain prototype fallbacks.
- Exact synchronization cannot be promised for cable/OTA latency, DVR editorial behavior, inaccessible native apps, or unofficial source-independent viewing.
