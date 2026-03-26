'use client';

import React, { useEffect, useRef, useState } from 'react';
import { createChart } from 'lightweight-charts';
import { API_BASE } from '@/lib/utils';

export default function TradingChart({ symbol, trades = [], interval = '5minute', days = 5 }) {
  const chartContainerRef = useRef();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!symbol || !chartContainerRef.current) return;

    let chart;
    let candlestickSeries;

    async function fetchData() {
      try {
        setLoading(true);
        setError(null);

        const res = await fetch(`${API_BASE}/api/candles?symbol=${symbol}&interval=${interval}&days=${days}`);
        if (!res.ok) throw new Error('Failed to fetch chart data');
        const data = await res.json();
        
        if (data.error) throw new Error(data.error);
        if (!data.candles || data.candles.length === 0) {
          throw new Error('No candle data available for ' + symbol);
        }

        chart = createChart(chartContainerRef.current, {
          layout: {
            background: { color: 'transparent' },
            textColor: '#9ca3af',
          },
          grid: {
            vertLines: { color: 'rgba(31, 41, 55, 0.5)' },
            horzLines: { color: 'rgba(31, 41, 55, 0.5)' },
          },
          crosshair: {
            mode: 1,
            vertLine: {
                color: '#6b7280',
                width: 1,
                style: 1,
                labelBackgroundColor: '#374151',
            },
            horzLine: {
                color: '#6b7280',
                width: 1,
                style: 1,
                labelBackgroundColor: '#374151',
            },
          },
          timeScale: {
            timeVisible: true,
            secondsVisible: false,
            borderColor: 'rgba(31, 41, 55, 0.5)',
          },
          rightPriceScale: {
            borderColor: 'rgba(31, 41, 55, 0.5)',
          },
        });

        candlestickSeries = chart.addCandlestickSeries({
          upColor: '#10b981',
          downColor: '#ef4444',
          borderVisible: false,
          wickUpColor: '#10b981',
          wickDownColor: '#ef4444',
        });

        candlestickSeries.setData(data.candles);

        if (trades && trades.length > 0) {
            const markers = [];
            for (const t of trades) {
                let tradeTime;
                
                // Parse timestamp correctly depending on if it's from history page or active position
                if (t.timestamp) {
                    tradeTime = typeof t.timestamp === 'string' ? Math.floor(new Date(t.timestamp).getTime() / 1000) : Math.floor(t.timestamp / 1000);
                } else if (t.time && t.date) {
                    try {
                         const d = new Date(`${t.date} ${t.time}`);
                         if (!isNaN(d)) tradeTime = Math.floor(d.getTime() / 1000);
                    } catch {}
                }
                
                if (!tradeTime) {
                    tradeTime = data.candles[data.candles.length - 1].time; 
                } 

                const isBuy = t.side === 'BUY';
                
                if (tradeTime > 0) {
                    markers.push({
                        time: tradeTime,
                        position: isBuy ? 'belowBar' : 'aboveBar',
                        color: isBuy ? '#10b981' : '#ef4444',
                        shape: isBuy ? 'arrowUp' : 'arrowDown',
                        text: isBuy ? 'BUY' : 'SELL',
                        size: 2,
                    });
                }
            }

            markers.sort((a,b) => a.time - b.time);

            // Deduplicate exact timestamps
            const deduped = [];
            let lastT = 0;
            for (const m of markers) {
                if (m.time === lastT) m.time += 1;
                deduped.push(m);
                lastT = m.time;
            }

            if (deduped.length > 0) {
                candlestickSeries.setMarkers(deduped);
            }
        }

        chart.timeScale().fitContent();
        setLoading(false);
      } catch (err) {
        setError(err.message);
        setLoading(false);
      }
    }

    fetchData();

    const handleResize = () => {
      if (chart && chartContainerRef.current) {
        chart.applyOptions({ width: chartContainerRef.current.clientWidth });
      }
    };

    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      if (chart) chart.remove();
    };
  }, [symbol, interval, days, trades]);

  return (
    <div className="w-full relative bg-[#1e222d] rounded-lg overflow-hidden border border-gray-800" style={{ height: '400px' }}>
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 backdrop-blur-sm">
          <div className="flex bg-gray-900 border border-gray-700 rounded-full px-4 py-2 text-sm text-gray-300">
             <span className="animate-spin mr-2">⏳</span> Loading chart...
          </div>
        </div>
      )}
      {error && (
        <div className="absolute inset-0 flex items-center justify-center bg-black/50 z-10 backdrop-blur-sm">
          <div className="text-red-400 bg-red-900/20 px-4 py-3 rounded border border-red-500/30">
            {error}
          </div>
        </div>
      )}
      <div ref={chartContainerRef} className="w-full h-full" />
    </div>
  );
}
