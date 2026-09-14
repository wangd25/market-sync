# Synchronization model

Every `sourceTimestampMs` and `receivedTimestampMs` is Unix epoch wall-clock milliseconds. `monotonicReceivedMs` comes from a local monotonic clock and is only for durations, gaps, and ordering observations inside one process; it cannot align machines.

The viewer mapping is piecewise. Each pause, resume, delay change, seek, playback-rate change, confidence transition, or anchor creates a new segment with real and viewer anchor times. While playing:

```text
viewerNow = anchorViewer + (realNow - anchorReal) × playbackRate
```

Paused, seeking, and uncertain modes freeze the segment’s viewer anchor. A delay change reanchors to `realNow - delay`; pause/resume never reuses elapsed paused wall time. Seeks move viewer time and preserve the current pause/play state.

Ticks are inserted by source time, sequence, then ID. Duplicate IDs are rejected. The buffer is capped by age and item count. The projection filters all ticks at `sourceTimestampMs <= viewerNow` before deriving any field. This one projection owns chart points, price, bid, ask, spread, volume, status, halt state, notification inputs, color direction, related summaries, comparisons, and consensus.

Contradictory anchors lower confidence. Buffering and reconnects also lower confidence. Below the configured threshold, strict anti-spoiler mode returns the previous complete safe projection and marks it frozen. It never selectively updates a “harmless” field.

Sport strategies use period/clock/score plus sport-specific state. A clock alone is not unique for stop-clock sports. Discrete sports use ordered events. Asynchronous coverage reports that exact sync is unavailable and uses conservative approximation only.

Sparse play-by-play states are merged in source-timestamp order before score transitions are derived. A commentary row without a score cannot erase the last validated scoreboard, and an explicit play is emitted only from the raw update that introduced it. When a provider includes home/away scores on a timestamped play, that play time is preferred to the later scoreboard-poll receipt time.

Sports observations are selected independently of the market feed. The source registry prefers fresh, authoritative play-by-play with wall-clock timestamps and replay recovery, then fails over to a validated scoreboard. Odds movement may corroborate quality diagnostics but never generates a score, play, or anchor. Provider event IDs and revisions are deduplicated; a later correction replaces the prior revision and is timestamped at `max(original source time, correction receipt time)` for viewer projection. A newer score decrease without a correction marker is invalid.

Guided score sync is spoiler blind: arming records a source-time baseline, and the viewer reports only which team made the next score when it reaches the broadcast. The client matches the first validated team-specific increase after the baseline. Recent event, state, and video anchors are fused with a rolling median of up to nine samples; raw samples remain in anchor metadata for diagnostics.

Accessible video with a valid `getStartDate()` program-time anchor is sampled locally. A rolling nine-sample median maps `start date + currentTime` to wall time and creates a high-confidence video anchor. Invalid, future, negative, and more-than-six-hour estimates are rejected. Live-edge distance without program time is not treated as exact end-to-end delay.

The product exposes three persisted control modes. Auto applies valid program-time video anchors and exposes one-step undo. Confirm retains a pending candidate with its confidence and requires an explicit **Apply this timing** action. Manual ignores automatic video anchors and retains direct delay and guided-event controls. Recent anchor history shows method, age, applied delay, and confidence without revealing sports state. Contradictory anchors more than five seconds from the recent median preserve the current delay and lower trust; once at least two consistent high-confidence anchors exist, a recalibration changes the applied delay by at most two seconds per anchor.

Source changes use hysteresis: a healthy incumbent is retained until a challenger exceeds its quality by the configured margin for the hold interval. Stale incumbents fail over immediately. Matching source timestamps or period/clock states with conflicting scores are treated as disagreement; strict mode lowers confidence below the safe threshold and atomically holds the previous delayed projection.

The effective delay is recalculated while paused or playing at a non-1× rate. Forward seeks are capped at wall-clock live so the projection cannot enter future time. A `playing` event after `waiting` resumes a timeline that was frozen for buffering.

Baseball calibration uses validated discrete state. A user-entered inning, half, score, outs, optional count, and moment type is matched against provider observations without displaying the undelayed feed. A unique match creates a `state_match` anchor with `estimatedDelayMs = observedAtMs - sourceTimestampMs`. Multiple matches, missing provider detail, negative delay, and matches beyond the bounded calibration window are rejected. The next-run flow records a source-time baseline, then matches the first team-specific score increase after that baseline when the viewer reports seeing it.

Latency is not represented by one blended number. Diagnostics keep sports-provider transport latency (`sports received - provider source`), market transport latency (`market received - market source`), and viewer broadcast delay (`broadcast observed - matched sports source`) as separate median, p95, and worst-case distributions. Receipt-approximated sports timestamps are counted but excluded from provider-latency percentiles.
