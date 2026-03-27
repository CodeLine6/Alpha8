'use client';

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createChart, LineStyle } from 'lightweight-charts';
import { API_BASE } from '@/lib/utils';

// ── helpers ────────────────────────────────────────────────────────────────────
function fmtVol(v) {
  if (!v && v !== 0) return '—';
  if (v >= 1e7) return (v / 1e7).toFixed(2) + ' Cr';
  if (v >= 1e5) return (v / 1e5).toFixed(2) + ' L';
  if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
  return v.toString();
}

const TYPE_CFG = {
  LONG_ENTRY:  { text: 'L.Entry', color: '#10b981', position: 'belowBar' },
  LONG_EXIT:   { text: 'L.Exit',  color: '#eab308', position: 'aboveBar' },
  SHORT_ENTRY: { text: 'S.Entry', color: '#ef4444', position: 'aboveBar' },
  SHORT_COVER: { text: 'S.Cover', color: '#3b82f6', position: 'belowBar' },
};

function parseTradeTime(t) {
  if (t.timestamp) {
    return typeof t.timestamp === 'string'
      ? Math.floor(new Date(t.timestamp).getTime() / 1000)
      : Math.floor(t.timestamp / 1000);
  }
  if (t.time && t.date) {
    try { const d = new Date(`${t.date} ${t.time}`); if (!isNaN(d)) return Math.floor(d.getTime() / 1000); } catch { /**/ }
  }
  return 0;
}

// ─────────────────────────────────────────────────────────────────────────────
/**
 * @param {object} props
 * @param {string}  props.symbol
 * @param {Array}   props.trades      — trade/position objects to plot as markers
 * @param {string}  [props.interval]
 * @param {number}  [props.days]
 * @param {string}  [props.endDate]
 * @param {boolean} [props.isLive]    — enables real-time tick polling & price lines
 * @param {object}  [props.liveData]  — { currentPrice, entryPrice, stopLoss, targetPrice, trailingStop }
 */
export default function TradingChart({
  symbol,
  trades = [],
  interval = '5minute',
  days = 2,
  endDate,
  isLive = false,
  liveData = {},
}) {
  const containerRef = useRef();
  const chartRef     = useRef();
  const candleRef    = useRef();
  const volRef       = useRef();
  const priceLinesRef = useRef({});    // keyed by label
  const lastCandleRef = useRef(null);  // last full candle for live update
  const markerMetaRef = useRef([]);    // always-current marker metadata for tooltip
  const entryLineCreatedRef = useRef(false); // true when a trade marker created the entry price line

  const [loading, setLoading]  = useState(true);
  const [error, setError]      = useState(null);
  const [legend, setLegend]    = useState(null);
  const [tooltip, setTooltip]  = useState(null);
  const [livePrice, setLivePrice] = useState(liveData.currentPrice ?? null);

  // ── 1. Build / refresh price level lines ─────────────────────────────────
  const refreshPriceLines = useCallback((data) => {
    const series = candleRef.current;
    if (!series) return;

    const lines = {
      // 'entry' removed — entry price lines are now created from LONG_ENTRY/SHORT_ENTRY
      // trade markers so they carry the correct direction label (L.Entry / S.Entry).
      // Fallback: if no entry trade marker created the line, show a generic 'Entry'.
      ...(!entryLineCreatedRef.current && data.entryPrice
        ? { entry: { price: data.entryPrice, color: '#e2e8f0', title: '  Entry', lineStyle: LineStyle.Solid, lineWidth: 1 } }
        : {}),
      stopLoss:      { price: data.stopLoss,       color: '#ef4444', title: '  Stop Loss',     lineStyle: LineStyle.Dashed,  lineWidth: 1 },
      trailingStop:  { price: data.trailingStop,   color: '#f97316', title: '  Trail Stop',    lineStyle: LineStyle.Dotted,  lineWidth: 1 },
      target:        { price: data.targetPrice,    color: '#10b981', title: '  Target',         lineStyle: LineStyle.Dashed,  lineWidth: 1 },
    };

    for (const [key, cfg] of Object.entries(lines)) {
      if (!cfg.price) { 
        // Remove old line if price disappeared
        if (priceLinesRef.current[key]) {
          try { series.removePriceLine(priceLinesRef.current[key]); } catch { /**/ }
          delete priceLinesRef.current[key];
        }
        continue;
      }
      if (priceLinesRef.current[key]) {
        // Update existing — lightweight-charts doesn't support in-place update, remove + recreate
        try { series.removePriceLine(priceLinesRef.current[key]); } catch { /**/ }
      }
      priceLinesRef.current[key] = series.createPriceLine({
        price: cfg.price,
        color: cfg.color,
        lineWidth: cfg.lineWidth,
        lineStyle: cfg.lineStyle,
        axisLabelVisible: true,
        title: cfg.title,
      });
    }
  }, []);

  // ── 2. Main chart init (runs once on mount / when symbol/interval changes) ──
  useEffect(() => {
    if (!symbol || !containerRef.current) return;

    let destroyed = false;
    priceLinesRef.current = {};
    lastCandleRef.current = null;
    markerMetaRef.current = [];  // clear stale markers from previous symbol
    entryLineCreatedRef.current = false;  // reset so refreshPriceLines can add fallback if needed

    async function init() {
      try {
        setLoading(true);
        setError(null);

        const url = `${API_BASE}/api/candles?symbol=${symbol}&interval=${interval}&days=${days}${endDate ? `&endDate=${endDate}` : ''}`;
        const res  = await fetch(url);
        if (!res.ok) throw new Error('Failed to fetch chart data');
        const data = await res.json();
        if (data.error) throw new Error(data.error);
        if (!data.candles?.length) throw new Error('No candle data for ' + symbol);

        if (destroyed) return;

        const chart = createChart(containerRef.current, {
          layout:    { background: { color: 'transparent' }, textColor: '#9ca3af' },
          grid:      { vertLines: { color: 'rgba(31,41,55,0.45)' }, horzLines: { color: 'rgba(31,41,55,0.45)' } },
          crosshair: {
            mode: 1,
            vertLine: { color: '#6b7280', width: 1, style: 1, labelBackgroundColor: '#374151' },
            horzLine: { color: '#6b7280', width: 1, style: 1, labelBackgroundColor: '#374151' },
          },
          timeScale:       { timeVisible: true, secondsVisible: false, borderColor: 'rgba(55,65,81,0.6)' },
          rightPriceScale: { borderColor: 'rgba(55,65,81,0.6)' },
        });
        chartRef.current  = chart;

        // Candlestick series
        const candleSeries = chart.addCandlestickSeries({
          upColor: '#10b981', downColor: '#ef4444',
          borderVisible: false,
          wickUpColor: '#10b981', wickDownColor: '#ef4444',
        });
        candleRef.current = candleSeries;
        candleSeries.setData(data.candles);
        lastCandleRef.current = data.candles[data.candles.length - 1];

        // Volume histogram
        const volSeries = chart.addHistogramSeries({ priceFormat: { type: 'volume' }, priceScaleId: 'vol' });
        volRef.current  = volSeries;
        volSeries.priceScale().applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, drawTicks: false, borderVisible: false });
        volSeries.setData(data.candles.map(c => ({
          time: c.time, value: c.volume || 0,
          color: c.close >= c.open ? 'rgba(16,185,129,0.35)' : 'rgba(239,68,68,0.35)',
        })));

        // Markers
        const markerMeta = [];
        if (trades.length > 0) {
          // Build a sorted list of candle times for snapping
          const candleTimes = data.candles.map(c => c.time).sort((a, b) => a - b);

          // Snap a raw unix-second timestamp to the nearest candle bar time
          const snapToCandle = (rawTime) => {
            if (!rawTime || candleTimes.length === 0) return candleTimes[candleTimes.length - 1] ?? rawTime;
            // Find the candle bar that contains or immediately precedes rawTime
            let snapped = candleTimes[0];
            for (const ct of candleTimes) {
              if (ct <= rawTime) snapped = ct;
              else break;
            }
            return snapped;
          };

          const rawM = [];
          for (const t of trades) {
            const rawTime = parseTradeTime(t);
            // Snap to the candle bar that was open at entry time
            const time = rawTime > 0 ? snapToCandle(rawTime) : candleTimes[candleTimes.length - 1];

            const cfg = TYPE_CFG[t.tradeType] ?? {
              text: t.side === 'BUY' ? 'Buy' : 'Sell',
              color: t.side === 'BUY' ? '#10b981' : '#ef4444',
              position: t.side === 'BUY' ? 'belowBar' : 'aboveBar',
            };

            const lbl = t.strategy === 'PARTIAL_EXIT' ? 'P.' + cfg.text.split('.')[1] : cfg.text;

            // ── Option B: Entry trades → price line at exact fill price ──────
            // LONG_ENTRY / SHORT_ENTRY: a horizontal price line at the fill price
            // gives pixel-perfect alignment on the axis. We still push a small
            // directional arrow at the candle time so the time is visible.
            const isEntryTrade = t.tradeType === 'LONG_ENTRY' || t.tradeType === 'SHORT_ENTRY';
            const fillPrice = t.entryPrice ?? t.price ?? 0;

            if (isEntryTrade && fillPrice > 0) {
              // Price line at exact fill price, styled like the other level lines
              candleSeries.createPriceLine({
                price: fillPrice,
                color: cfg.color,
                lineWidth: 1,
                lineStyle: LineStyle.Solid,
                axisLabelVisible: true,
                title: `  ${lbl}`,   // e.g. "  L.Entry" / "  S.Entry"
              });
              entryLineCreatedRef.current = true; // suppress generic 'Entry' fallback
              // Small arrow at the candle time — gives temporal reference without
              // the visual price mismatch of belowBar/aboveBar circle markers
              if (time > 0) rawM.push({
                time,
                trade: t,
                color: cfg.color,
                position: cfg.position,
                text: '',          // no label — the price line carries the label
                shape: t.tradeType === 'LONG_ENTRY' ? 'arrowUp' : 'arrowDown',
              });
            } else {
              if (time > 0) rawM.push({ time, trade: t, ...cfg, text: lbl, shape: 'circle' });
            }
          }

          rawM.sort((a, b) => a.time - b.time);
          let lastT = 0;
          for (const m of rawM) {
            if (m.time <= lastT) m.time = lastT + 1;
            markerMetaRef.current.push({
              time: m.time,
              trade: m.trade,
              color: m.color,
              position: m.position, // Important for distance scoring
            });
            lastT = m.time;
          }
          candleSeries.setMarkers(rawM.map(({ trade: _t, ...rest }) => rest));
        }


        // If live, draw price lines now
        if (isLive) refreshPriceLines(liveData);

        // Crosshair subscription
        chart.subscribeCrosshairMove(param => {
          if (!param.point || !param.time || param.point.x < 0 || param.point.y < 0) {
            setLegend(null); setTooltip(null); return;
          }
          const candle = param.seriesData.get(candleSeries);
          const vol    = param.seriesData.get(volSeries);
          if (candle) setLegend({ ...candle, volume: vol?.value });

          if (!candle) { setTooltip(null); return; }

          // Find markers within a small time window (e.g., +/- 1 candle)
          const timeWindow = interval === '1minute' ? 60 : interval === '5minute' ? 300 : interval === '15minute' ? 900 : 300;
          const candidates = markerMetaRef.current.filter(m => Math.abs(m.time - param.time) < timeWindow * 1.5);

          if (candidates.length === 0) {
            setTooltip(null);
          } else {
            // Find vertically closest marker
            const highY = candleSeries.priceToCoordinate(candle.high);
            const lowY = candleSeries.priceToCoordinate(candle.low);
            const mouseY = param.point.y;

            let best = null;
            let minDiv = Infinity;

            for (const m of candidates) {
              const markerY = m.position === 'aboveBar' ? highY : lowY;
              const div = Math.abs(mouseY - markerY);
              if (div < minDiv) {
                minDiv = div;
                best = m;
              }
            }

            // Only show if reasonably close to the marker's vertical area (tolerance: 40px)
            if (minDiv < 40) {
              setTooltip({ trade: best.trade, color: best.color, x: param.point.x, y: param.point.y });
            } else {
              setTooltip(null);
            }
          }
        });

        chart.timeScale().fitContent();
        setLoading(false);
      } catch (err) {
        if (!destroyed) { setError(err.message); setLoading(false); }
      }
    }

    init();

    const onResize = () => { if (chartRef.current && containerRef.current) chartRef.current.applyOptions({ width: containerRef.current.clientWidth }); };
    window.addEventListener('resize', onResize);
    return () => {
      destroyed = true;
      window.removeEventListener('resize', onResize);
      chartRef.current?.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
    };
  }, [symbol, interval, days, endDate]); // eslint-disable-line

  // ── 3. Keep markerMeta trade data live — runs every time trades polls ──────
  // The chart useEffect only runs on symbol/interval changes (no re-init flash).
  // This effect patches only the trade payload inside each markerMeta entry so
  // peakPnl, pnl, quantity etc. always reflect the latest API response.
  useEffect(() => {
    if (!trades?.length || !markerMetaRef.current.length) return;
    // Build a lookup: entryTimestamp (unix-s) → trade object
    const byTime = new Map();
    for (const t of trades) {
      const rawTime = parseTradeTime(t);
      if (rawTime > 0) byTime.set(rawTime, t);
      // Also index by symbol in case timestamps don't align perfectly
      if (t.symbol) byTime.set(t.symbol, t);
    }
    for (const meta of markerMetaRef.current) {
      const fresh = byTime.get(meta.time) ?? byTime.get(meta.trade?.symbol);
      if (fresh) meta.trade = fresh; // mutate in-place — crosshair closure reads ref
    }
  }, [trades]);

  // ── 4. Update price lines when liveData prop changes (from parent polling) ──
  useEffect(() => {
    if (isLive && candleRef.current) refreshPriceLines(liveData);
  }, [isLive, liveData, refreshPriceLines]);

  // ── 4. Real-time last-candle update via /api/live-price polling ────────────
  useEffect(() => {
    if (!isLive || !symbol) return;

    const poll = async () => {
      try {
        const r = await fetch(`${API_BASE}/api/live-price?symbol=${symbol}`);
        if (!r.ok) return;
        const d = await r.json();
        if (!d.ltp) return;

        setLivePrice(d.ltp);

        // Update the last candle's close / high / low in the chart
        if (candleRef.current && lastCandleRef.current) {
          const now  = Math.floor(Date.now() / 1000);
          const last = lastCandleRef.current;

          // Snap to 5-minute candle bucket
          const bucketSize = interval === '5minute' ? 300 : interval === '1minute' ? 60 : interval === '15minute' ? 900 : 300;
          const bucket = Math.floor(now / bucketSize) * bucketSize;

          if (bucket > last.time) {
            // New candle started
            const newCandle = { time: bucket, open: d.ltp, high: d.ltp, low: d.ltp, close: d.ltp };
            candleRef.current.update(newCandle);
            volRef.current?.update({ time: bucket, value: 0, color: 'rgba(107,114,128,0.3)' });
            lastCandleRef.current = newCandle;
          } else {
            // Same candle — update its close / high / low
            const updated = {
              time:  last.time,
              open:  last.open,
              high:  Math.max(last.high, d.ltp),
              low:   Math.min(last.low,  d.ltp),
              close: d.ltp,
            };
            candleRef.current.update(updated);
            lastCandleRef.current = updated;
          }
        }
      } catch { /**/ }
    };

    // Poll every 2 seconds when chart is live
    poll();
    const id = setInterval(poll, 2000);
    return () => clearInterval(id);
  }, [isLive, symbol, interval]);

  // ── Render ─────────────────────────────────────────────────────────────────
  const isUp = legend && legend.close >= legend.open;
  const clr   = isUp ? 'text-green-400' : 'text-red-400';

  return (
    <div style={{ height: 520 }} className="w-full relative bg-[#161b27] rounded-lg overflow-hidden border border-gray-800/70 flex flex-col">

      {/* Top OHLCV bar */}
      <div className="flex-none px-3 py-1.5 flex items-center gap-3 border-b border-gray-800/60 bg-[#161b27] text-xs text-gray-400 z-10">
        <span className="font-bold text-white mr-1">{symbol}</span>

        {/* Live badge + price */}
        {isLive && (
          <span className="flex items-center gap-1.5 bg-green-900/30 text-green-400 border border-green-500/30 px-2 py-0.5 rounded-full text-[10px] font-semibold">
            <span className="w-1.5 h-1.5 rounded-full bg-green-400 animate-pulse" />
            LIVE {livePrice ? `₹${livePrice.toFixed(2)}` : ''}
          </span>
        )}

        {legend ? (
          <>
            <span>O:<span className={`${clr} ml-1`}>{legend.open.toFixed(2)}</span></span>
            <span>H:<span className={`${clr} ml-1`}>{legend.high.toFixed(2)}</span></span>
            <span>L:<span className={`${clr} ml-1`}>{legend.low.toFixed(2)}</span></span>
            <span>C:<span className={`${clr} ml-1`}>{legend.close.toFixed(2)}</span></span>
            <span className="text-gray-500">Vol:<span className="text-gray-300 ml-1">{fmtVol(legend.volume)}</span></span>
            <span className={`ml-auto font-medium ${clr}`}>
              {isUp ? '▲' : '▼'} {Math.abs(legend.close - legend.open).toFixed(2)}
              {' '}({Math.abs(((legend.close - legend.open) / legend.open) * 100).toFixed(2)}%)
            </span>
          </>
        ) : (
          <span className="text-gray-600 italic ml-2">Hover over a candle for OHLCV</span>
        )}
      </div>

      {/* Chart pane */}
      <div className="flex-1 relative">
        {loading && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20 backdrop-blur-sm">
            <div className="flex bg-gray-900 border border-gray-700 rounded-full px-4 py-2 text-sm text-gray-300">
              <span className="animate-spin mr-2">⏳</span> Loading chart...
            </div>
          </div>
        )}
        {error && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/60 z-20 backdrop-blur-sm">
            <div className="text-red-400 bg-red-900/20 px-4 py-3 rounded border border-red-500/30 text-sm max-w-sm text-center">{error}</div>
          </div>
        )}

        <div ref={containerRef} className="absolute inset-0" />

        {/* Marker hover tooltip */}
        {tooltip && (() => {
          const t = tooltip.trade;
          const pnl = t.pnl ?? null;
          const pnlColor = pnl == null ? 'text-gray-400' : pnl >= 0 ? 'text-green-400' : 'text-red-400';
          const flipX = tooltip.x > 520;

          return (
            <div className="pointer-events-none absolute z-30" style={{ left: flipX ? tooltip.x - 224 : tooltip.x + 18, top: Math.max(10, tooltip.y - 30), minWidth: 208 }}>
              <div className="rounded-lg text-xs shadow-xl" style={{ background: 'rgba(15,20,30,0.97)', border: `1px solid ${tooltip.color}44`, borderLeft: `3px solid ${tooltip.color}`, padding: '10px 14px' }}>
                <div className="flex items-center gap-2 mb-2.5">
                  <span className="w-2 h-2 rounded-full flex-none" style={{ background: tooltip.color }} />
                  <span className="font-bold text-white text-sm">{t.symbol}</span>
                  <span className="ml-auto font-semibold text-[11px]" style={{ color: tooltip.color }}>{t.tradeType?.replace('_', ' ') ?? t.side}</span>
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-gray-400">
                  <span>Price</span>
                  <span className="text-white font-medium text-right">₹{(t.price ?? t.entryPrice ?? 0).toFixed ? (t.price ?? t.entryPrice ?? 0).toFixed(2) : '—'}</span>
                  <span>Qty</span>
                  <span className="text-white font-medium text-right">{t.quantity ?? '—'}</span>
                  {pnl != null && <><span>P&amp;L</span><span className={`font-medium text-right ${pnlColor}`}>{pnl >= 0 ? '+' : ''}₹{pnl.toFixed(2)}</span></>}
                  {t.peakPnl != null && <><span>Peak P&amp;L</span><span className="font-medium text-right text-emerald-400">+₹{Math.abs(t.peakPnl).toFixed(2)}</span></>}
                  {t.capitalDeployed != null && <><span>Deployed</span><span className="text-gray-300 text-right">₹{Math.round(t.capitalDeployed).toLocaleString('en-IN')}</span></>}
                  {t.strategy && <><span>Strategy</span><span className="text-gray-300 text-right truncate max-w-[100px]" title={t.strategy}>{t.strategy.replace(/_/g, ' ')}</span></>}
                  <span>Date</span>
                  <span className="text-gray-300 text-right">{t.date ?? '—'}</span>
                </div>
              </div>
            </div>
          );
        })()}
      </div>

      {/* Bottom legend bar */}
      <div className="flex-none px-3 py-1.5 flex items-center gap-4 border-t border-gray-800/60 bg-[#161b27] text-xs z-10">
        <span style={{ color: '#10b981' }} className="font-medium">● L.Entry</span>
        <span style={{ color: '#eab308' }} className="font-medium">● L.Exit</span>
        <span style={{ color: '#ef4444' }} className="font-medium">● S.Entry</span>
        <span style={{ color: '#3b82f6' }} className="font-medium">● S.Cover</span>
        {isLive && (
          <>
            <span style={{ color: '#e2e8f0' }}>— Entry</span>
            <span style={{ color: '#10b981' }}>- - Target</span>
            <span style={{ color: '#ef4444' }}>- - SL</span>
            <span style={{ color: '#f97316' }}>··· Trail</span>
          </>
        )}
        <span className="text-gray-500 ml-auto">{trades.length} execution{trades.length !== 1 ? 's' : ''} plotted</span>
      </div>
    </div>
  );
}
