'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import TradingChart from '@/components/TradingChart';
import { API_BASE } from '@/lib/utils';

// ── helpers ───────────────────────────────────────────────────────────────────
const fmt2   = (n) => n != null ? n.toFixed(2) : '—';
const fmtCr  = (n) => n != null ? (n >= 100 ? `₹${n.toFixed(0)} Cr` : `₹${n.toFixed(1)} Cr`) : '—';
const pctFmt = (v) => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
const pctCls = (v) => v == null ? 'text-gray-500' : v > 0 ? 'text-emerald-400' : v < 0 ? 'text-red-400' : 'text-gray-400';

const scoreGradient = (s) =>
  s >= 70 ? 'from-emerald-500 to-green-400' :
  s >= 50 ? 'from-yellow-500 to-amber-400' :
  s >= 35 ? 'from-orange-500 to-orange-400' :
             'from-red-500 to-red-400';

const scoreFg = (s) =>
  s >= 70 ? 'text-emerald-400' : s >= 50 ? 'text-yellow-400' : s >= 35 ? 'text-orange-400' : 'text-red-400';

const REGIME_STYLES = {
  BULLISH: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25 ring-1 ring-emerald-500/10',
  BEARISH: 'bg-red-500/10 text-red-400 border-red-500/25 ring-1 ring-red-500/10',
  NEUTRAL: 'bg-blue-500/10 text-blue-400 border-blue-500/25 ring-1 ring-blue-500/10',
};
const REGIME_LABELS = { BULLISH: '▲ Bullish', BEARISH: '▼ Bearish', NEUTRAL: '● Neutral' };
const regimeStyle = (r) => REGIME_STYLES[r] ?? 'bg-gray-800/50 text-gray-500 border-gray-700/30';
const regimeLabel = (r) => REGIME_LABELS[r] ?? 'N/A';

const SORTS = {
  score:    (a, b) => b.score - a.score,
  price:    (a, b) => (b.price ?? 0) - (a.price ?? 0),
  turnover: (a, b) => (b.breakdown?.liquidity?.turnoverCr ?? 0) - (a.breakdown?.liquidity?.turnoverCr ?? 0),
  ret10d:   (a, b) => (b.breakdown?.momentum?.ret10d ?? -999) - (a.breakdown?.momentum?.ret10d ?? -999),
  ret20d:   (a, b) => (b.breakdown?.momentum?.ret20d ?? -999) - (a.breakdown?.momentum?.ret20d ?? -999),
  atr:      (a, b) => (b.breakdown?.volatility?.atrPct ?? 0) - (a.breakdown?.volatility?.atrPct ?? 0),
  symbol:   (a, b) => a.symbol.localeCompare(b.symbol),
};

// ── Sub-components ────────────────────────────────────────────────────────────
function StatCard({ icon, label, value, sub, valueClass = 'text-white' }) {
  return (
    <div className="relative overflow-hidden rounded-2xl border border-white/[0.06] bg-white/[0.03] p-5 backdrop-blur-sm">
      <div className="flex items-start justify-between">
        <div>
          <p className="text-xs font-medium uppercase tracking-widest text-gray-500">{label}</p>
          <p className={`mt-1.5 text-3xl font-bold tracking-tight ${valueClass}`}>{value}</p>
          {sub && <p className="mt-1 text-xs text-gray-600">{sub}</p>}
        </div>
        <span className="text-2xl opacity-60">{icon}</span>
      </div>
    </div>
  );
}

function ScoreBar({ score }) {
  return (
    <div className="flex items-center gap-3 min-w-[120px]">
      <span className={`w-7 text-right text-sm font-bold tabular-nums ${scoreFg(score)}`}>{score}</span>
      <div className="relative flex-1 h-2 rounded-full bg-white/5 overflow-hidden">
        <div
          className={`absolute inset-y-0 left-0 rounded-full bg-gradient-to-r ${scoreGradient(score)} transition-all duration-700`}
          style={{ width: `${score}%` }}
        />
      </div>
      <span className="text-[10px] text-gray-700 tabular-nums">/100</span>
    </div>
  );
}

function FilterSelect({ label, value, onChange, children }) {
  return (
    <label className="flex items-center gap-2">
      <span className="text-xs font-medium text-gray-500 whitespace-nowrap">{label}</span>
      <select
        value={value}
        onChange={e => onChange(e.target.value)}
        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1.5 text-xs text-gray-200 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/20 cursor-pointer"
      >
        {children}
      </select>
    </label>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────
export default function ScreenerPage() {
  const [results,     setResults]     = useState([]);
  const [loading,     setLoading]     = useState(false);
  const [scannedAt,   setScannedAt]   = useState(null);
  const [fromCache,   setFromCache]   = useState(false);
  const [scanned,     setScanned]     = useState(0);
  const [error,       setError]       = useState(null);
  const [chartSymbol, setChartSymbol] = useState(null);

  const [minScore,    setMinScore]    = useState(0);
  const [regime,      setRegime]      = useState('ALL');
  const [minTurnover, setMinTurnover] = useState(0);
  const [sortKey,     setSortKey]     = useState('score');
  const [search,      setSearch]      = useState('');

  const didFetch = useRef(false);

  const loadScreener = useCallback(async (refresh = false) => {
    if (didFetch.current && !refresh) return;
    setLoading(true); setError(null);
    try {
      const r = await fetch(`${API_BASE}/api/screener?limit=300${refresh ? '&refresh=1' : ''}`);
      if (!r.ok) throw new Error('Screener fetch failed');
      const d = await r.json();
      if (d.error) throw new Error(d.error);
      setResults(d.results || []);
      setScanned(d.scanned || d.results?.length || 0);
      setFromCache(d.fromCache);
      setScannedAt(d.scannedAt);
      didFetch.current = true;
    } catch (e) { setError(e.message); }
    finally     { setLoading(false); }
  }, []);

  useEffect(() => { loadScreener(); }, [loadScreener]);

  const displayed = results
    .filter(r => {
      if (minScore > 0     && r.score < minScore)                                   return false;
      if (regime !== 'ALL' && r.regime !== regime)                                  return false;
      if (minTurnover > 0  && (r.breakdown?.liquidity?.turnoverCr ?? 0) < minTurnover) return false;
      if (search && !r.symbol.includes(search.toUpperCase()))                        return false;
      return true;
    })
    .sort(SORTS[sortKey] ?? SORTS.score);

  const bullish    = results.filter(r => r.regime === 'BULLISH').length;
  const topScore   = results[0]?.score ?? 0;
  const avgTurnover = results.length
    ? results.reduce((s, r) => s + (r.breakdown?.liquidity?.turnoverCr ?? 0), 0) / results.length
    : 0;

  const headerTs = scannedAt ? new Date(scannedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : null;

  return (
    <div className="space-y-7 pb-12">

      {/* ── Page header ───────────────────────────────────────────── */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight text-white">Stock Screener</h1>
          <p className="mt-1 text-sm text-gray-500">
            {fromCache
              ? <>Cached · {scanned} symbols{headerTs ? ` · refreshed at ${headerTs}` : ''}</>
              : <>Live scan · {scanned} NSE symbols · 5 scoring dimensions</>
            }
          </p>
        </div>
        <button
          onClick={() => loadScreener(true)}
          disabled={loading}
          className="flex shrink-0 items-center gap-2 rounded-xl border border-blue-500/30 bg-blue-500/10 px-4 py-2 text-sm font-medium text-blue-400 transition hover:bg-blue-500/20 disabled:opacity-40"
        >
          {loading ? <span className="animate-spin">⏳</span> : '🔄'}
          {loading ? 'Scanning…' : 'Refresh Scan'}
        </button>
      </div>

      {/* ── Loading bar ───────────────────────────────────────────── */}
      {loading && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] p-4">
          <p className="flex items-center gap-2 text-sm text-gray-400 mb-3">
            <span className="animate-spin">⏳</span>
            Fetching 70 days of candles per symbol and scoring…
            <span className="ml-auto text-gray-600 text-xs">~30–60s</span>
          </p>
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-white/5">
            <div className="h-full w-3/5 animate-pulse rounded-full bg-gradient-to-r from-blue-500 via-purple-500 to-blue-500 bg-[length:200%_100%]" />
          </div>
        </div>
      )}

      {error && (
        <div className="rounded-xl border border-red-500/30 bg-red-500/5 px-4 py-4 text-sm text-red-400">
          ⚠️ {error}
        </div>
      )}

      {/* ── Summary cards ─────────────────────────────────────────── */}
      {results.length > 0 && (
        <div className="grid grid-cols-2 gap-5 lg:grid-cols-4">
          <StatCard icon="📡" label="Scanned" value={scanned} sub="NSE equities" />
          <StatCard icon="📈" label="Bullish" value={bullish}
            sub={`${((bullish / Math.max(scanned, 1)) * 100).toFixed(0)}% of universe`}
            valueClass="text-emerald-400" />
          <StatCard icon="🏆" label="Top Score" value={topScore}
            sub="out of 100"
            valueClass={scoreFg(topScore)} />
          <StatCard icon="💧" label="Avg Turnover" value={fmtCr(avgTurnover)} sub="last 20 trading days" />
        </div>
      )}

      {/* ── Filter bar ────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-4 rounded-2xl border border-white/6 bg-white/2 px-5 py-4">
        {/* Search */}
        <div className="relative">
          <span className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-gray-500 text-xs">🔍</span>
          <input
            type="text"
            placeholder="e.g. RELIANCE"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="rounded-lg border border-white/10 bg-white/5 py-1.5 pl-7 pr-3 text-xs text-gray-200 placeholder-gray-600 focus:border-blue-500/50 focus:outline-none focus:ring-1 focus:ring-blue-500/20 w-32"
          />
        </div>

        {/* Min score */}
        <label className="flex items-center gap-2">
          <span className="text-xs font-medium text-gray-500 whitespace-nowrap">Min Score</span>
          <input
            type="range" min="0" max="90" step="5" value={minScore}
            onChange={e => setMinScore(+e.target.value)}
            className="w-24 accent-blue-500 cursor-pointer"
          />
          <span className="w-7 text-right text-xs font-bold text-gray-300">{minScore || '—'}</span>
        </label>

        <FilterSelect label="Regime" value={regime} onChange={setRegime}>
          <option value="ALL">All Regimes</option>
          <option value="BULLISH">▲ Bullish</option>
          <option value="NEUTRAL">● Neutral</option>
          <option value="BEARISH">▼ Bearish</option>
        </FilterSelect>

        <FilterSelect label="Min Turnover" value={minTurnover} onChange={v => setMinTurnover(+v)}>
          <option value={0}>Any</option>
          <option value={5}>₹5 Cr+</option>
          <option value={25}>₹25 Cr+</option>
          <option value={100}>₹100 Cr+</option>
          <option value={500}>₹500 Cr+</option>
        </FilterSelect>

        <FilterSelect label="Sort by" value={sortKey} onChange={setSortKey}>
          <option value="score">Score</option>
          <option value="ret10d">10d Return</option>
          <option value="ret20d">20d Return</option>
          <option value="turnover">Turnover</option>
          <option value="atr">ATR %</option>
          <option value="symbol">Symbol A–Z</option>
        </FilterSelect>

        <span className="ml-auto text-xs text-gray-600 tabular-nums">
          {displayed.length} / {results.length} symbols
        </span>
      </div>

      {/* ── Table ─────────────────────────────────────────────────── */}
      {displayed.length > 0 && (
        <div className="rounded-2xl border border-white/[0.06] bg-white/[0.02] overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-sm">
              <thead>
                <tr className="border-b border-white/[0.06]">
                  {[
                    ['#  Symbol',  'text-left pl-5 pr-4'],
                    ['Price',      'text-right px-4'],
                    ['Regime',     'text-center px-4'],
                    ['Score',      'text-left px-4 min-w-[160px]'],
                    ['Liquidity',  'text-center px-3'],
                    ['Trend',      'text-center px-3'],
                    ['Vol Fit',    'text-center px-3'],
                    ['Momentum',   'text-center px-3'],
                    ['Turnover',   'text-right px-4'],
                    ['10d Ret',    'text-right px-4'],
                    ['20d Ret',    'text-right px-4'],
                    ['ATR %',      'text-right px-3'],
                    ['',           'px-4'],
                  ].map(([label, cls]) => (
                    <th key={label} className={`py-4 text-[10px] uppercase tracking-widest font-semibold text-gray-500 whitespace-nowrap ${cls}`}>
                      {label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {displayed.map((r, i) => {
                  const bd  = r.breakdown;
                  const liq = bd?.liquidity;
                  const mom = bd?.momentum;
                  const vol = bd?.volatility;
                  const tr  = bd?.trend;
                  return (
                    <tr
                      key={r.symbol}
                      className="border-b border-white/[0.03] transition-colors hover:bg-white/[0.025]"
                    >
                      {/* # Symbol */}
                      <td className="pl-5 pr-4 py-4 font-bold text-white whitespace-nowrap">
                        <div className="flex items-center gap-2.5">
                          <span className="w-5 text-right text-xs text-gray-600 tabular-nums">{i + 1}</span>
                          <span className="tracking-wide">{r.symbol}</span>
                        </div>
                      </td>

                      {/* Price */}
                      <td className="px-4 py-4 text-right font-mono text-gray-200 whitespace-nowrap">
                        ₹{fmt2(r.price)}
                      </td>

                      {/* Regime */}
                      <td className="px-4 py-4 text-center">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[10px] font-semibold whitespace-nowrap ${regimeStyle(r.regime)}`}>
                          {regimeLabel(r.regime)}
                        </span>
                      </td>

                      {/* Score bar */}
                      <td className="px-4 py-4">
                        <ScoreBar score={r.score} />
                      </td>

                      {/* Sub-scores */}
                      {[
                        [liq?.score, 25],
                        [tr?.score,  25],
                        [vol?.score, 20],
                        [mom?.score, 20],
                      ].map(([s, max], idx) => (
                        <td key={idx} className="px-3 py-4 text-center whitespace-nowrap tabular-nums">
                          <span className={`text-xs font-semibold ${scoreFg(s != null ? (s / max) * 100 : 0)}`}>{s ?? '—'}</span>
                          <span className="text-[10px] text-gray-700">/{max}</span>
                        </td>
                      ))}

                      {/* Turnover */}
                      <td className="px-4 py-4 text-right text-xs text-gray-300 whitespace-nowrap tabular-nums">
                        {fmtCr(liq?.turnoverCr)}
                      </td>

                      {/* 10d / 20d return */}
                      <td className={`px-4 py-4 text-right text-xs font-semibold whitespace-nowrap tabular-nums ${pctCls(mom?.ret10d)}`}>
                        {pctFmt(mom?.ret10d)}
                      </td>
                      <td className={`px-4 py-4 text-right text-xs font-semibold whitespace-nowrap tabular-nums ${pctCls(mom?.ret20d)}`}>
                        {pctFmt(mom?.ret20d)}
                      </td>

                      {/* ATR% */}
                      <td className="px-3 py-4 text-right text-xs text-gray-400 whitespace-nowrap tabular-nums">
                        {vol?.atrPct != null ? `${vol.atrPct.toFixed(2)}%` : '—'}
                      </td>

                      {/* Chart button */}
                      <td className="px-4 py-4">
                        <button
                          onClick={() => setChartSymbol(r.symbol)}
                          className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400 transition hover:bg-blue-500/20 whitespace-nowrap"
                        >
                          📈 Chart
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Empty state */}
      {!loading && !error && results.length === 0 && (
        <div className="flex flex-col items-center justify-center rounded-2xl border border-white/[0.06] bg-white/[0.02] py-16 text-center">
          <span className="text-5xl mb-4">🔍</span>
          <p className="text-base font-semibold text-gray-300">No results yet</p>
          <p className="mt-1 text-sm text-gray-600">Click <span className="text-blue-400">Refresh Scan</span> to score the NSE universe</p>
        </div>
      )}

      {/* ── Chart modal ───────────────────────────────────────────── */}
      {chartSymbol && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-md"
          onClick={() => setChartSymbol(null)}
        >
          <div
            className="relative w-[92vw] max-w-[1050px] rounded-2xl border border-white/10 bg-gray-950 p-6 shadow-2xl"
            onClick={e => e.stopPropagation()}
          >
            <div className="flex items-center justify-between mb-5">
              <div>
                <h2 className="text-xl font-bold text-white">{chartSymbol}</h2>
                <p className="text-xs text-gray-500 mt-0.5">5-day intraday · 5-minute candles</p>
              </div>
              <button
                onClick={() => setChartSymbol(null)}
                className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-gray-400 hover:text-white transition"
              >
                ✕ Close
              </button>
            </div>
            <TradingChart symbol={chartSymbol} trades={[]} days={5} />
          </div>
        </div>
      )}
    </div>
  );
}


