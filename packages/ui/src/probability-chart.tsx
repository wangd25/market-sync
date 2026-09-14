'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import {
  createChart,
  LineSeries,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from 'lightweight-charts';
import type { DelayedChartPoint } from '@marketsync/core';

export interface ChartOutcome {
  label: string;
  points: readonly DelayedChartPoint[];
  color: string;
  price: number | null;
}

export interface ProbabilityChartProps {
  dataKey: string;
  outcomes: readonly ChartOutcome[];
  viewerTimestampMs: number;
  delaySeconds: number;
  refreshState?: ChartRefreshState | null;
  activityLabel?: string;
  activityTone?: 'live' | 'quiet' | 'warning';
}

export interface ChartRefreshState {
  id: number;
  fromDelaySeconds: number;
  toDelaySeconds: number;
}

interface BeaconPosition {
  key: string;
  x: number;
  y: number;
  color: string;
}

const chartData = (points: readonly DelayedChartPoint[]) => {
  const pointsBySecond = new Map<number, number>();
  for (const point of points)
    pointsBySecond.set(Math.floor(point.timestampMs / 1_000), point.probability);
  return [...pointsBySecond.entries()]
    .toSorted(([left], [right]) => left - right)
    .map(([time, value]) => ({ time: time as UTCTimestamp, value }));
};

export const ProbabilityChart = ({
  dataKey,
  outcomes,
  viewerTimestampMs,
  delaySeconds,
  refreshState = null,
  activityLabel,
  activityTone = 'live',
}: ProbabilityChartProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Line'>[]>([]);
  const retainedDataRef = useRef(new Map<string, ReturnType<typeof chartData>>());
  const updateBeaconsRef = useRef<() => void>(() => undefined);
  const userZoomedRef = useRef(false);
  const [beacons, setBeacons] = useState<readonly BeaconPosition[]>([]);
  const [hasData, setHasData] = useState(false);
  const [userZoomed, setUserZoomed] = useState(false);

  useEffect(() => {
    const container = containerRef.current;
    if (container === null) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { color: 'transparent' },
        textColor: '#8a94a3',
        attributionLogo: false,
        fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
        fontSize: 11,
      },
      grid: {
        vertLines: { visible: false },
        horzLines: { color: '#e8ebf0', style: 2 },
      },
      rightPriceScale: {
        borderVisible: false,
        scaleMargins: { top: 0.1, bottom: 0.1 },
      },
      timeScale: {
        borderColor: '#e4e7ec',
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 2,
      },
      handleScale: {
        mouseWheel: true,
        pinch: true,
        axisPressedMouseMove: { time: true, price: false },
      },
      handleScroll: {
        mouseWheel: false,
        pressedMouseMove: true,
        horzTouchDrag: true,
        vertTouchDrag: false,
      },
      crosshair: {
        vertLine: { color: '#98a2b3', width: 1, style: 3 },
        horzLine: { visible: false, labelVisible: false },
      },
    });
    chartRef.current = chart;
    const handleWheel = (event: WheelEvent) => {
      event.preventDefault();
      userZoomedRef.current = true;
      setUserZoomed(true);
      window.requestAnimationFrame(() => updateBeaconsRef.current());
    };
    container.addEventListener('wheel', handleWheel, { passive: false });
    const observer = new ResizeObserver(() => {
      if (!userZoomedRef.current) chart.timeScale().fitContent();
      window.requestAnimationFrame(() => updateBeaconsRef.current());
    });
    observer.observe(container);
    return () => {
      observer.disconnect();
      container.removeEventListener('wheel', handleWheel);
      chart.remove();
      chartRef.current = null;
      seriesRef.current = [];
      updateBeaconsRef.current = () => undefined;
    };
  }, []);

  useEffect(() => {
    userZoomedRef.current = false;
    setUserZoomed(false);
    retainedDataRef.current.clear();
    for (const series of seriesRef.current) series.setData([]);
    setBeacons([]);
    setHasData(false);
  }, [dataKey]);

  useEffect(() => {
    const chart = chartRef.current;
    if (chart === null) return;
    const visibleOutcomes = outcomes.slice(0, 2);
    while (seriesRef.current.length > visibleOutcomes.length) {
      const series = seriesRef.current.pop();
      if (series !== undefined) chart.removeSeries(series);
    }
    const visibleData = visibleOutcomes.map((outcome) => {
      const incoming = chartData(outcome.points);
      if (incoming.length > 0) {
        retainedDataRef.current.set(outcome.label, incoming);
        return incoming;
      }
      return retainedDataRef.current.get(outcome.label) ?? [];
    });
    setHasData(visibleData.some((data) => data.length > 0));
    visibleOutcomes.forEach((outcome, index) => {
      const series =
        seriesRef.current[index] ??
        chart.addSeries(LineSeries, {
          lineWidth: 2,
          priceLineVisible: false,
          lastValueVisible: true,
          crosshairMarkerRadius: 4,
          priceFormat: {
            type: 'custom',
            minMove: 0.001,
            formatter: (value: number) => `${Math.round(value * 100)}¢`,
          },
        });
      if (seriesRef.current[index] === undefined) seriesRef.current[index] = series;
      series.applyOptions({
        color: outcome.color,
        crosshairMarkerBackgroundColor: outcome.color,
      });
      series.setData(visibleData[index] ?? []);
    });
    if (!userZoomedRef.current) chart.timeScale().fitContent();
    updateBeaconsRef.current = () => {
      const nextBeacons = visibleOutcomes.flatMap((outcome, index) => {
        const series = seriesRef.current[index];
        const lastPoint = visibleData[index]?.at(-1);
        if (series === undefined || lastPoint === undefined) return [];
        const x = chart.timeScale().timeToCoordinate(lastPoint.time);
        const y = series.priceToCoordinate(lastPoint.value);
        return x === null || y === null ? [] : [{ key: outcome.label, x, y, color: outcome.color }];
      });
      setBeacons(nextBeacons);
    };
    const frame = window.requestAnimationFrame(() => updateBeaconsRef.current());
    return () => window.cancelAnimationFrame(frame);
  }, [dataKey, outcomes]);

  const resetZoom = () => {
    const chart = chartRef.current;
    if (chart === null) return;
    userZoomedRef.current = false;
    setUserZoomed(false);
    chart.timeScale().fitContent();
    window.requestAnimationFrame(() => updateBeaconsRef.current());
  };

  const refreshDelta =
    refreshState === null ? 0 : refreshState.toDelaySeconds - refreshState.fromDelaySeconds;
  const refreshDirection = refreshDelta >= 0 ? 'back' : 'forward';

  return (
    <div className="ms-chart-wrap" data-chart-zoom={userZoomed ? 'custom' : 'fit'}>
      <div className="ms-chart-head">
        <div>
          <strong>Broadcast-aligned price</strong>
          <div className="ms-chart-legend">
            {outcomes.slice(0, 2).map((outcome) => (
              <span key={outcome.label}>
                <i style={{ background: outcome.color }} />
                {outcome.label}{' '}
                {outcome.price === null ? '—' : `${Math.round(outcome.price * 100)}¢`}
              </span>
            ))}
          </div>
        </div>
        <div className="ms-cutoff-copy">
          <strong>Broadcast now</strong>
          <span>{delaySeconds.toFixed(1)}s delay</span>
          {activityLabel === undefined ? null : (
            <span className={`ms-market-activity ${activityTone}`}>
              <i aria-hidden="true" />
              {activityLabel}
            </span>
          )}
        </div>
      </div>
      <div className="ms-chart-navigation" aria-label="Chart navigation">
        <span>Scroll over chart to zoom</span>
        <button type="button" onClick={resetZoom} disabled={!userZoomed}>
          Reset zoom
        </button>
      </div>
      <div
        className={`ms-chart-stage ${refreshState === null ? '' : `is-refreshing shift-${refreshDirection}`}`}
      >
        <div ref={containerRef} className="ms-chart" aria-label="Delayed two-outcome price chart" />
        {hasData ? null : (
          <div className="ms-chart-empty" role="status">
            <i aria-hidden="true" />
            <strong>Connecting price history</strong>
            <span>The chart will appear after the first validated delayed price.</span>
          </div>
        )}
        <div className="ms-chart-beacons" aria-hidden="true">
          {beacons.map((beacon) => (
            <i
              key={beacon.key}
              className="ms-chart-beacon"
              style={
                {
                  left: beacon.x,
                  top: beacon.y,
                  '--ms-beacon-color': beacon.color,
                } as CSSProperties
              }
            />
          ))}
        </div>
        <div className="ms-viewer-cutoff" aria-hidden="true" />
        {refreshState === null ? null : (
          <div key={refreshState.id} className="ms-chart-refresh" role="status" aria-live="polite">
            <span className="ms-chart-refresh-icon" aria-hidden="true">
              <i />
            </span>
            <span>
              <strong>Updating timeline</strong>
              <small>
                Moving broadcast window {refreshDirection} ·{' '}
                {refreshState.toDelaySeconds.toFixed(1)}s behind live
              </small>
            </span>
          </div>
        )}
      </div>
      <div className="ms-chart-foot">
        <span>Your time {new Date(viewerTimestampMs).toLocaleTimeString()}</span>
        <a href="https://www.tradingview.com/lightweight-charts/" target="_blank" rel="noreferrer">
          Lightweight Charts™
        </a>
      </div>
    </div>
  );
};
