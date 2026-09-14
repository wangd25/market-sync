export type VideoObserverState =
  | { kind: 'unavailable'; reason: string }
  | {
      kind: 'bound';
      paused: boolean;
      waiting: boolean;
      seeking: boolean;
      playbackRate: number;
      currentTime: number;
      pictureInPicture: boolean;
    };

export interface VideoObserverCallbacks {
  onState(state: VideoObserverState): void;
  onPause(): void;
  onResume(): void;
  onBuffering(): void;
  onSeek(deltaSeconds: number): void;
  onPlaybackRate(rate: number): void;
  onLatencyEstimate?(delayMs: number, confidence: number, method: 'program-date-time'): void;
}

type ProgramDateVideo = HTMLVideoElement & { getStartDate?: () => Date };

export const programDateTimeDelayMs = (
  video: Pick<HTMLVideoElement, 'currentTime'> & { getStartDate?: () => Date },
  nowMs = Date.now(),
): number | null => {
  if (typeof video.getStartDate !== 'function' || !Number.isFinite(video.currentTime)) return null;
  try {
    const start = video.getStartDate().getTime();
    const delayMs = nowMs - (start + video.currentTime * 1_000);
    return Number.isFinite(delayMs) && delayMs >= 0 && delayMs <= 6 * 60 * 60 * 1_000
      ? delayMs
      : null;
  } catch {
    return null;
  }
};

export class AccessibleVideoObserver {
  private video: ProgramDateVideo | null = null;
  private previousTime = 0;
  private seekStartedAt = 0;
  private waiting = false;
  private mutationObserver: MutationObserver | null = null;
  private readonly teardownCallbacks: Array<() => void> = [];
  private readonly latencySamples: number[] = [];
  private lastLatencyEstimateMs: number | null = null;

  public constructor(private readonly callbacks: VideoObserverCallbacks) {}

  public start(root: Document | ShadowRoot = document): void {
    this.bindBestVideo(root);
    this.mutationObserver = new MutationObserver(() => {
      if (this.video?.isConnected !== true) this.bindBestVideo(root);
    });
    this.mutationObserver.observe(root, { childList: true, subtree: true });
  }

  public stop(): void {
    this.mutationObserver?.disconnect();
    this.mutationObserver = null;
    this.unbind();
  }

  private bindBestVideo(root: Document | ShadowRoot): void {
    const videos = [...root.querySelectorAll('video')];
    const video = videos.sort(
      (a, b) => b.clientWidth * b.clientHeight - a.clientWidth * a.clientHeight,
    )[0];
    if (video === undefined) {
      this.callbacks.onState({
        kind: 'unavailable',
        reason: 'No accessible HTML video element. Side-panel synchronization remains available.',
      });
      return;
    }
    this.unbind();
    this.video = video;
    this.previousTime = video.currentTime;
    const listen = (event: keyof HTMLMediaElementEventMap, handler: () => void) => {
      video.addEventListener(event, handler);
      this.teardownCallbacks.push(() => video.removeEventListener(event, handler));
    };
    listen('pause', () => {
      this.callbacks.onPause();
      this.emit();
    });
    listen('play', () => {
      this.callbacks.onResume();
      this.emit();
    });
    listen('waiting', () => {
      this.waiting = true;
      this.callbacks.onBuffering();
      this.emit();
    });
    listen('playing', () => {
      const recoveredFromBuffering = this.waiting;
      this.waiting = false;
      if (recoveredFromBuffering && !video.paused) this.callbacks.onResume();
      this.sampleLatency();
      this.emit();
    });
    listen('timeupdate', () => {
      if (!video.seeking) this.previousTime = video.currentTime;
      this.sampleLatency();
    });
    listen('seeking', () => {
      this.seekStartedAt = this.previousTime;
      this.emit();
    });
    listen('seeked', () => {
      const delta = video.currentTime - this.seekStartedAt;
      if (Math.abs(delta) >= 0.1) this.callbacks.onSeek(delta);
      this.previousTime = video.currentTime;
      this.emit();
    });
    listen('ratechange', () => {
      this.callbacks.onPlaybackRate(video.playbackRate);
      this.emit();
    });
    listen('loadedmetadata', () => this.sampleLatency());
    this.sampleLatency();
    this.emit();
  }

  private sampleLatency(): void {
    const video = this.video;
    if (video === null) return;
    const sample = programDateTimeDelayMs(video);
    if (sample === null) return;
    this.latencySamples.push(sample);
    if (this.latencySamples.length > 9) this.latencySamples.shift();
    if (this.latencySamples.length < 3) return;
    const ordered = [...this.latencySamples].sort((left, right) => left - right);
    const median = ordered[Math.floor(ordered.length / 2)];
    if (median === undefined) return;
    if (this.lastLatencyEstimateMs !== null && Math.abs(median - this.lastLatencyEstimateMs) < 750)
      return;
    this.lastLatencyEstimateMs = median;
    this.callbacks.onLatencyEstimate?.(median, 0.9, 'program-date-time');
  }

  private emit(): void {
    const video = this.video;
    if (video === null) return;
    this.callbacks.onState({
      kind: 'bound',
      paused: video.paused,
      waiting: this.waiting,
      seeking: video.seeking,
      playbackRate: video.playbackRate,
      currentTime: video.currentTime,
      pictureInPicture: document.pictureInPictureElement === video,
    });
  }

  private unbind(): void {
    for (const teardown of this.teardownCallbacks.splice(0)) teardown();
    this.video = null;
    this.latencySamples.length = 0;
    this.lastLatencyEstimateMs = null;
  }
}
