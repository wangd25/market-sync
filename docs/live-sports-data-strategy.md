# Live sports data and broadcast synchronization strategy

MarketSync needs two different truths:

1. A fast, ordered description of the real game: score, period, clock, possession, and plays.
2. A measurement of what the viewer is seeing: the same state after broadcaster, CDN, device, pause, and buffering delays.

No scoreboard API alone can provide the second truth. The target architecture combines a sports
feed with one or more broadcast-side observations, then creates timeline anchors only from unique,
validated matches.

## Provider candidates

| Candidate                                                                                                                    | Useful signals                                                                           | Best role                                      | Main concern                                                                            |
| ---------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------- |
| [Sportradar NBA](https://developer.sportradar.com/basketball/docs/nba-ig-push)                                               | Push events, push clock, REST play-by-play recovery, wall-clock and ordered event fields | Primary NBA production source                  | Realtime push is a licensed add-on                                                      |
| [SportsDataIO NBA](https://sportsdata.io/developers/workflow-guide/nba)                                                      | Score, quarter, time remaining, possession, players, delta play-by-play                  | Integration prototype and REST fallback        | Documents roughly 15–20 seconds behind TV for live data                                 |
| [Genius Sports](https://developer.geniussports.com/)                                                                         | Licensed basketball live match data, push feeds, event matching                          | Official/enterprise and FIBA-oriented coverage | Commercial access and feed-specific rights                                              |
| [Stats Perform Opta](https://www.statsperform.com/products/opta-data-feeds/)                                                 | Real-time event data across many sports, detailed context, momentum products             | Multi-sport enterprise source                  | Commercial access; validate league-level latency and redistribution rights              |
| [BALLDONTLIE](https://docs.balldontlie.io/)                                                                                  | NBA live box scores and play-by-play; webhooks include player scoring                    | Fast proof of concept and secondary validation | Benchmark latency and corrections before using as an anchor source                      |
| [Data Sports Group](https://datasportsgroup.com/coverage/basketball/)                                                        | NBA and global basketball score, play-by-play and player data                            | Broad league coverage and secondary feed       | Commercial source; verify exact competition-level SLAs                                  |
| [Goalserve](https://www.goalserve.com/en/sport-data-feeds/nba-api/description)                                               | Live score, timer, player stats and play-by-play; advertised 3–5 second updates          | Affordable polling fallback                    | Validate event timestamps, corrections and NBA rights                                   |
| [Enetpulse](https://enetpulse.com/basketball-data/)                                                                          | Broad live scores and stats with API/XML delivery                                        | International breadth and failover             | Coverage detail varies by competition                                                   |
| [API-Sports Basketball](https://api-sports.io/documentation/basketball/v1)                                                   | Live game status, score and quarter state                                                | Lightweight scoreboard fallback                | Less suitable for rich NBA play-by-play                                                 |
| [FIBA LiveStats interface](https://gdap-portal.fiba.basketball/content/FIBA%20OVR%20Livestats%20Interface%20description.pdf) | Official timing, score, statistics and game actions                                      | FIBA competitions and venue integrations       | Access normally flows through FIBA/Genius commercial relationships                      |
| NBA.com live-data JSON                                                                                                       | Scoreboard, box score and play-by-play used by NBA web properties                        | Development-only experiment                    | Undocumented, can change or block access; do not make it the sole production dependency |
| Current Polymarket sports feed                                                                                               | Coarse score/period/status updates                                                       | Free last-resort corroboration                 | Sparse, may omit events, and lacks NBA player-level play-by-play                        |
| ESPN site Gamecast                                                                                                           | Public scoreboard plus timestamped commentary/play descriptions                          | Credential-free best-effort prototype          | Undocumented response contract; validate every response and retain provider fallback    |

## Broadcast-side synchronization signals

Ranked from strongest to weakest:

1. **HLS program date-time.** If the player exposes its media manifest, map the current video
   segment to Unix time using `EXT-X-PROGRAM-DATE-TIME`. Apple requires it in live media playlists
   and says it should align with airtime. This can produce a direct broadcast wall-clock anchor.
2. **DASH availability and presentation time.** Map the active media period/segment timestamp to
   `availabilityStartTime`, while accounting for ad periods and discontinuities.
3. **Timed metadata.** Read HLS `EXT-X-DATERANGE`, ID3, DASH `emsg`, SCTE-35, or broadcaster-specific
   metadata that identifies periods, ad breaks, or game events.
4. **Video element telemetry.** Observe `currentTime`, pause, seek, playback rate, waiting, and
   buffered ranges. This preserves a previously established anchor through local playback changes.
5. **On-device scoreboard recognition.** With explicit permission, let the user select the TV
   scoreboard region and locally recognize score, period, and clock. Use digit templates before
   general OCR, temporal voting across frames, and retain only normalized observations.
6. **Audio fingerprinting.** Match a short microphone or tab-audio sample against a legal reference
   broadcast. ACRCloud explicitly supports live-channel detection and second-screen triggering.
7. **Audio event matching.** Detect whistles, horns, buzzer patterns, or commentator/crowd peaks and
   use them only to narrow the candidate window, never as a sole exact anchor.
8. **Caption matching.** When captions mention a scorer or score, match the phrase to a play-by-play
   event. Captions are delayed and editorial, so confidence must remain moderate.
9. **Score-change matching.** A unique transition such as 92–91 to 94–91 is a strong stop-clock
   anchor even if the displayed game clock repeats.
10. **Ordered event matching.** Match a sequence of two or three visible events rather than one
    ambiguous clock value: foul, free throw, substitution, possession change.
11. **Market-reaction cross-correlation.** Use odds jumps only as a diagnostic corroborator. Never
    derive the sports state or expose future information from the raw market feed.
12. **Manual one-tap anchor.** Let the viewer tap a delayed notification when it appears on screen.
    This remains the most universal fallback and requires no stream access.

The beta implements two of these paths locally: accessible HLS program time through
`HTMLMediaElement.getStartDate()` when the player exposes it, and a spoiler-blind guided next-score
tap for any sport with validated team score transitions. The latter records a baseline first and
never displays the undelayed scoring event during calibration.

Official HLS references: [Apple HLS authoring](https://developer.apple.com/documentation/http-live-streaming/hls-authoring-specification-for-apple-devices/) and [AWS live-source timing](https://docs.aws.amazon.com/mediatailor/latest/ug/channel-assembly-working-live-sources.html). Audio reference: [ACRCloud live-channel detection](https://docs.acrcloud.com/service-usage).

## Recommended implementation

### Phase A: benchmark before committing

- Trial Sportradar, BALLDONTLIE, SportsDataIO, Goalserve, and one broad multi-sport provider against
  the same recorded NBA games.
- Record provider receive time, provider wall-clock time, game clock, sequence ID, correction count,
  missing-play count, and time relative to the television frame.
- Measure median, p95 and worst-case latency separately for score, clock, and play-by-play.
- Confirm browser redistribution, derived-notification, caching, and betting-adjacent licensing terms.

The beta now includes the normalized recorder needed for this trial. Each export identifies timestamp
quality and source provenance and reports sports-provider, market-transport, and viewer-delay latency
separately. Receipt-approximated timestamps are never silently mixed into provider-latency
percentiles. Live export remains gated until the event is complete.

`pnpm benchmark:providers -- --input=/absolute/path/session.jsonl` now produces strict machine-readable
JSON and a compact Markdown comparison. Imports are bounded and revalidated. Reports include missing,
duplicate, correction, ordering, disconnect, replay-recovery, score-agreement, market-reaction, and
viewer-drift measures, but must be interpreted only for the supplied games.

### Phase B: provider-neutral gateway

- Keep credentials server-side and expose only normalized `SportsState` observations.
- Give every source a capability descriptor: scoreboard, clock, play-by-play, player attribution,
  wall-clock timestamp, ordered sequence, push delivery, and replay recovery.
- Score live source quality from freshness, validation failures and capabilities.
- Prefer push for speed, but always keep a REST replay endpoint to recover missed events.
- Deduplicate by provider event ID plus revision; treat corrections as revisions, not new plays.
- Poll the best-effort ESPN confirmation path every two seconds while preventing overlapping
  requests; retain the Polymarket sports socket and scoreboard poller as independent fallbacks.
- Map vendor game IDs through a canonical event resolver using league, teams, start time, and venue.
- Store only a bounded normalized timeline; never persist credentials or unrestricted raw payloads.

The source descriptor, observation schema, deterministic selector, stale failover, revision
replacement, correction timing, rollback rejection, and bounded client recorder are implemented.
ESPN remains the best-effort detailed prototype and Polymarket sports state remains an independent
coarse corroborator. A production provider and its keys still belong behind the gateway.

The gateway now defines the credential-free normalization boundary, canonical resolver, replay
contract, capability-specific selection, and anti-flapping hysteresis. No commercial adapter is
claimed until licensing and same-game measurements are available.

### Phase C: synchronization engine

- Convert all provider wall-clock timestamps to Unix milliseconds; use monotonic time only for local
  gaps and duration measurements.
- Maintain separate estimates for provider latency and viewer broadcast delay.
- Generate candidate anchors from unique score/period/clock/event combinations.
- Fuse candidates with robust weighting: stream timestamp > unique OCR state > ordered event tap >
  clock-only observation.
- Reject negative delay, impossible clock movement, score rollback without a correction marker, and
  anchors outside the bounded calibration window.
- Detect drift continuously. Re-anchor gradually when confidence is high; freeze strict mode when
  sources conflict.
- Display provenance and confidence: `Official play-by-play`, `Scoreboard backup`, `Local match`, or
  `Manual sync`.

### Phase D: product experience

- Deliver concise notifications: player, action, score, period/clock, and delayed market reaction.
- Let users filter to scoring plays, lead changes, possession, fouls, or all plays.
- Add a small sync-confidence timeline showing the most recent anchor and drift estimate.
- Offer `Auto sync`, `Confirm plays`, and `Manual` privacy/control modes.
- Show provider degradation without disrupting the chart: source switched, clock estimated, or plays
  temporarily unavailable.

## Recommendation

Start the first real NBA evaluation with **Sportradar REST play-by-play plus Push Events/Push Clock**
if licensing is feasible. It has the strongest combination of official source status, detailed plays,
clock updates, timestamps, push delivery, and REST recovery. In parallel, benchmark **BALLDONTLIE** as
the quickest prototype and **SportsDataIO** as an operationally simple fallback, while recognizing
that SportsDataIO's documented 15–20 second live delay is too large to serve as the sole low-latency
reference.

Do not expose any commercial API key in the extension. The gateway should ingest providers, validate
and normalize observations, and send only bounded data to the client. The client must continue to
route every sports state and market reaction through the viewer-time cutoff.
