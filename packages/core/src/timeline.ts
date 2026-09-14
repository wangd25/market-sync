import type { SyncAnchor, ViewerTimelineState, WallClockMs } from '@marketsync/shared-types';
import type { Clock } from './clock';

export interface TimelineSegment extends ViewerTimelineState {
  createdAtMs: WallClockMs;
  reason: string;
}

export interface TimelineOptions {
  initialDelayMs?: number;
  initialConfidence?: number;
  maxDelayMs?: number;
}

const clampConfidence = (value: number): number => Math.max(0, Math.min(1, value));

export class ViewerTimeline {
  private state: ViewerTimelineState;
  private readonly segments: TimelineSegment[] = [];
  private readonly anchors: SyncAnchor[] = [];
  private readonly maxDelayMs: number;

  public constructor(
    private readonly clock: Clock,
    options: TimelineOptions = {},
  ) {
    const delay = options.initialDelayMs ?? 20_000;
    this.maxDelayMs = options.maxDelayMs ?? 6 * 60 * 60 * 1000;
    this.assertDelay(delay);
    const now = clock.wallNowMs();
    this.state = {
      mode: 'playing',
      anchorRealTimestampMs: now,
      anchorViewerTimestampMs: now - delay,
      playbackRate: 1,
      estimatedDelayMs: delay,
      confidence: clampConfidence(options.initialConfidence ?? 0.92),
    };
    this.record('initial');
  }

  public snapshot(): ViewerTimelineState {
    return {
      ...this.state,
      estimatedDelayMs: Math.max(0, this.clock.wallNowMs() - this.virtualNowMs()),
    };
  }

  public virtualNowMs(atRealMs = this.clock.wallNowMs()): WallClockMs {
    if (this.state.mode !== 'playing') return this.state.anchorViewerTimestampMs;
    return Math.min(
      atRealMs,
      this.state.anchorViewerTimestampMs +
        (atRealMs - this.state.anchorRealTimestampMs) * this.state.playbackRate,
    );
  }

  public pause(reason = 'manual_pause'): void {
    this.reanchor('paused', this.virtualNowMs(), reason);
  }

  public resume(reason = 'manual_resume'): void {
    this.reanchor('playing', this.virtualNowMs(), reason);
  }

  public seekBy(deltaMs: number): void {
    if (!Number.isFinite(deltaMs)) throw new RangeError('Seek delta must be finite');
    // A forward seek may catch up to live, but it must never move the viewer
    // timeline into future wall-clock time and reveal provider clock skew.
    const target = Math.min(this.clock.wallNowMs(), this.virtualNowMs() + deltaMs);
    const resultingDelay = this.clock.wallNowMs() - target;
    this.assertDelay(resultingDelay);
    const mode = this.state.mode === 'paused' ? 'paused' : 'playing';
    this.state.estimatedDelayMs = resultingDelay;
    this.reanchor(mode, target, deltaMs < 0 ? 'rewind' : 'seek_forward');
  }

  public setPlaybackRate(rate: number): void {
    if (!Number.isFinite(rate) || rate <= 0 || rate > 4) {
      throw new RangeError('Playback rate must be greater than 0 and at most 4');
    }
    const viewerNow = this.virtualNowMs();
    this.state.playbackRate = rate;
    this.reanchor(this.state.mode, viewerNow, 'playback_rate');
  }

  public setEstimatedDelay(delayMs: number): void {
    this.assertDelay(delayMs);
    this.state.estimatedDelayMs = delayMs;
    this.reanchor(
      this.state.mode === 'paused' ? 'paused' : 'playing',
      this.clock.wallNowMs() - delayMs,
      'delay',
    );
  }

  public returnToEstimatedLive(): void {
    this.setEstimatedDelay(this.state.estimatedDelayMs);
  }

  public reduceConfidence(amount: number, reason: string): void {
    if (!Number.isFinite(amount) || amount < 0)
      throw new RangeError('Confidence reduction must be non-negative');
    this.state.confidence = clampConfidence(this.state.confidence - amount);
    if (this.state.confidence < 0.35) this.reanchor('uncertain', this.virtualNowMs(), reason);
    else this.record(reason);
  }

  public restoreConfidence(value: number): void {
    this.state.confidence = clampConfidence(value);
    if (this.state.mode === 'uncertain' && this.state.confidence >= 0.35)
      this.resume('confidence_restored');
    else this.record('confidence_restored');
  }

  public addAnchor(anchor: SyncAnchor): void {
    const expectedDelay = this.clock.wallNowMs() - this.virtualNowMs();
    const contradictionMs = Math.abs(anchor.estimatedDelayMs - expectedDelay);
    this.anchors.push({ ...anchor });
    if (contradictionMs > 5_000) {
      this.reduceConfidence(Math.min(0.5, contradictionMs / 60_000), 'contradictory_anchor');
      return;
    }
    this.state.confidence = clampConfidence((this.state.confidence + anchor.confidence) / 2);
    this.setEstimatedDelay(anchor.estimatedDelayMs);
  }

  public getSegments(): readonly TimelineSegment[] {
    return this.segments.map((segment) => ({ ...segment }));
  }

  public getAnchors(): readonly SyncAnchor[] {
    return this.anchors.map((anchor) => ({ ...anchor, metadata: { ...anchor.metadata } }));
  }

  public reset(delayMs = 20_000): void {
    this.assertDelay(delayMs);
    const now = this.clock.wallNowMs();
    this.state = {
      mode: 'playing',
      anchorRealTimestampMs: now,
      anchorViewerTimestampMs: now - delayMs,
      playbackRate: 1,
      estimatedDelayMs: delayMs,
      confidence: 0.92,
    };
    this.anchors.length = 0;
    this.record('reset');
  }

  private reanchor(mode: ViewerTimelineState['mode'], viewerMs: WallClockMs, reason: string): void {
    const now = this.clock.wallNowMs();
    this.state = {
      ...this.state,
      mode,
      anchorRealTimestampMs: now,
      anchorViewerTimestampMs: viewerMs,
      estimatedDelayMs: Math.max(0, now - viewerMs),
    };
    this.record(reason);
  }

  private record(reason: string): void {
    this.segments.push({ ...this.state, createdAtMs: this.clock.wallNowMs(), reason });
  }

  private assertDelay(delayMs: number): void {
    if (!Number.isFinite(delayMs) || delayMs < 0 || delayMs > this.maxDelayMs) {
      throw new RangeError(`Delay must be between 0 and ${this.maxDelayMs}ms`);
    }
  }
}
