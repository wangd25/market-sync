import type { MarketSyncPublicSnapshot, VideoTimelineEvent } from '@marketsync/ui';
import { AccessibleVideoObserver } from '../lib/video-observer';

const OVERLAY_ID = 'marketsync-overlay-host';
const STORAGE_KEY = `marketsync:overlay:${location.hostname}`;
const SNAPSHOT_KEY = 'marketsync:public-snapshot';

interface Position {
  left: number;
  top: number;
  width: number;
  height: number;
}

const displayPercent = (value: number | null) =>
  value === null ? '—' : `${Math.round(value * 100)}%`;
const displayCents = (value: number | null) =>
  value === null ? '—' : `${Math.round(value * 100)}¢`;

const createOverlay = (): HTMLElement => {
  const existing = document.getElementById(OVERLAY_ID);
  if (existing !== null) return existing;
  const host = document.createElement('div');
  host.id = OVERLAY_ID;
  host.style.cssText =
    'position:fixed;left:24px;top:84px;width:330px;height:190px;z-index:2147483000;resize:both;overflow:hidden;min-width:250px;min-height:126px;';
  const shadow = host.attachShadow({ mode: 'open' });
  const panel = document.createElement('section');
  panel.innerHTML = `<style>:host{all:initial}.panel{height:100%;box-sizing:border-box;background:linear-gradient(145deg,rgba(7,17,32,.94),rgba(5,11,22,.96));backdrop-filter:blur(18px);color:#f4f7ff;border:1px solid rgba(125,165,218,.34);border-radius:16px;box-shadow:inset 0 1px #fff1,0 22px 60px #0009;font:13px Inter,system-ui;overflow:hidden}.head{height:42px;padding:0 11px;display:flex;align-items:center;gap:8px;background:#081426cc;border-bottom:1px solid rgba(125,165,218,.18);cursor:move}.dot{width:7px;height:7px;border-radius:50%;background:#5ce6b7}.brand{font-weight:750}.brand b{color:#8bb9ff}.head button{margin-left:auto;border:0;background:transparent;color:#94a3b8;font-size:18px;cursor:pointer}.head button+button{margin-left:0}.body{padding:14px}.title{white-space:nowrap;overflow:hidden;text-overflow:ellipsis;color:#cbd5e3}.prob{margin-top:4px;font-size:42px;line-height:1;color:#60d9f5;font-weight:760;letter-spacing:-.055em}.meta{display:flex;gap:17px;margin-top:8px;color:#94a3b8}.sync{margin-top:13px;padding-top:10px;border-top:1px solid rgba(125,165,218,.18);display:flex;justify-content:space-between;color:#b6c5d8}.compact .meta,.compact .sync{display:none}</style><div class="panel"><div class="head"><span class="dot"></span><span class="brand">Market<b>Sync</b></span><button class="mode" title="Compact mode">−</button><button class="hide" title="Hide overlay">×</button></div><div class="body"><div class="title">Waiting for side panel…</div><div class="prob">—</div><div class="meta"><span class="bid">Bid —</span><span class="ask">Ask —</span></div><div class="sync"><span class="delay">— delay</span><span class="aligned">Connecting</span></div></div></div>`;
  shadow.append(panel);
  const update = (snapshot: MarketSyncPublicSnapshot | undefined) => {
    if (snapshot === undefined) return;
    panel.querySelector('.title')!.textContent = `${snapshot.title} · ${snapshot.provider}`;
    panel.querySelector('.prob')!.textContent = displayPercent(snapshot.probability);
    panel.querySelector('.bid')!.textContent = `Bid ${displayCents(snapshot.bestBid)}`;
    panel.querySelector('.ask')!.textContent = `Ask ${displayCents(snapshot.bestAsk)}`;
    panel.querySelector('.delay')!.textContent = `${snapshot.delaySeconds.toFixed(1)}s delay`;
    panel.querySelector('.aligned')!.textContent = snapshot.frozen
      ? 'Frozen for safety'
      : 'Aligned';
  };
  void browser.storage.local
    .get(SNAPSHOT_KEY)
    .then((value) => update(value[SNAPSHOT_KEY] as MarketSyncPublicSnapshot | undefined));
  browser.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[SNAPSHOT_KEY] !== undefined)
      update(changes[SNAPSHOT_KEY]?.newValue as MarketSyncPublicSnapshot | undefined);
  });
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved !== null) {
    try {
      const position = JSON.parse(saved) as Position;
      host.style.left = `${Math.max(0, position.left)}px`;
      host.style.top = `${Math.max(0, position.top)}px`;
      host.style.width = `${position.width}px`;
      host.style.height = `${position.height}px`;
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  panel.querySelector('.hide')?.addEventListener('click', () => host.remove());
  panel
    .querySelector('.mode')
    ?.addEventListener('click', () => panel.querySelector('.panel')?.classList.toggle('compact'));
  let dragging = false,
    startX = 0,
    startY = 0,
    startLeft = 0,
    startTop = 0;
  const header = panel.querySelector<HTMLElement>('.head');
  header?.addEventListener('pointerdown', (event) => {
    if ((event.target as HTMLElement).tagName === 'BUTTON') return;
    dragging = true;
    startX = event.clientX;
    startY = event.clientY;
    startLeft = host.offsetLeft;
    startTop = host.offsetTop;
    header.setPointerCapture(event.pointerId);
  });
  header?.addEventListener('pointermove', (event) => {
    if (!dragging) return;
    host.style.left = `${Math.max(0, startLeft + event.clientX - startX)}px`;
    host.style.top = `${Math.max(0, startTop + event.clientY - startY)}px`;
  });
  header?.addEventListener('pointerup', () => {
    dragging = false;
    localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify({
        left: host.offsetLeft,
        top: host.offsetTop,
        width: host.offsetWidth,
        height: host.offsetHeight,
      } satisfies Position),
    );
  });
  document.documentElement.append(host);
  return host;
};

const sendVideoEvent = (event: VideoTimelineEvent) =>
  void browser.runtime.sendMessage({ type: 'MARKETSYNC_VIDEO_EVENT', event });

export default defineContentScript({
  matches: ['http://localhost/*', 'http://127.0.0.1/*'],
  main() {
    if (document.documentElement.getAttribute('data-marketsync-enable') !== 'true') return;
    let host = createOverlay();
    const moveForFullscreen = () => {
      const parent = document.fullscreenElement ?? document.documentElement;
      if (!host.isConnected) host = createOverlay();
      parent.append(host);
    };
    document.addEventListener('fullscreenchange', moveForFullscreen);
    const observer = new AccessibleVideoObserver({
      onState(state) {
        if (state.kind === 'unavailable')
          sendVideoEvent({ kind: 'unavailable', reason: state.reason });
      },
      onPause() {
        sendVideoEvent({ kind: 'pause' });
      },
      onResume() {
        sendVideoEvent({ kind: 'resume' });
      },
      onBuffering() {
        sendVideoEvent({ kind: 'buffering' });
      },
      onSeek(deltaSeconds) {
        sendVideoEvent({ kind: 'seek', deltaMs: deltaSeconds * 1_000 });
      },
      onPlaybackRate(rate) {
        sendVideoEvent({ kind: 'playback-rate', rate });
      },
      onLatencyEstimate(delayMs, confidence, method) {
        sendVideoEvent({ kind: 'latency-estimate', delayMs, confidence, method });
      },
    });
    observer.start();
  },
});
