'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, formatPct, API_BASE } from '@/lib/utils';
import TradingChart from '@/components/TradingChart';

// ── Shared Tailwind class strings ────────────────────────────
const CARD  = 'rounded-2xl border border-slate-700/50 bg-slate-900 p-6';
const LABEL = 'text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2';
const MUTED = 'text-xs text-slate-500';

// ── Polling hook ─────────────────────────────────────────────
function usePolling(url, ms = 5000) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetch_ = useCallback(async () => {
        try {
            const r = await fetch(url);
            if (!r.ok) throw new Error(`${r.status}`);
            setData(await r.json()); setError(null);
        } catch (e) { setError(e.message); }
        finally { setLoading(false); }
    }, [url]);

    useEffect(() => { fetch_(); const id = setInterval(fetch_, ms); return () => clearInterval(id); }, [fetch_, ms]);
    return { data, loading, error, refetch: fetch_ };
}

// ── Skeletons ────────────────────────────────────────────────
const SkeletonCard = () => (
    <div className="rounded-2xl border border-white/[0.07] bg-[#141922] p-6 h-28 animate-pulse" />
);
const SkeletonRow = () => (
    <div className="h-10 rounded-lg bg-white/[0.04] animate-pulse mb-2" />
);

// ── Stat card ────────────────────────────────────────────────
function StatCard({ label, value, sub, pulse }) {
    return (
        <div className={`${CARD} ${pulse === 'green' ? 'pulse-green' : pulse === 'red' ? 'pulse-red' : ''}`}>
            <p className={LABEL}>{label}</p>
            <p className="text-3xl font-bold tracking-tight tabular-nums">{value}</p>
            {sub && <p className={`${MUTED} mt-2`}>{sub}</p>}
        </div>
    );
}

// ── Badge ─────────────────────────────────────────────────────
function Badge({ color, children }) {
    const cls = {
        green:  'bg-green-500/10 text-green-400 border-green-500/20',
        red:    'bg-red-500/10 text-red-400 border-red-500/20',
        yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
        blue:   'bg-blue-500/10 text-blue-400 border-blue-500/20',
    }[color] ?? 'bg-white/5 text-slate-400 border-white/10';
    return (
        <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
            {children}
        </span>
    );
}

// ════════════════════════════════════════════════════════════
export default function DashboardPage() {
    const summary   = usePolling(`${API_BASE}/api/summary`, 5000);
    const positions = usePolling(`${API_BASE}/api/positions`, 5000);
    const health    = usePolling(`${API_BASE}/api/health`, 10000);
    const market    = usePolling(`${API_BASE}/api/market-overview`, 30000); // slower polling for overview

    return (
        <div className="space-y-8">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Dashboard</h1>
                    <p className="text-sm text-slate-500 mt-1">Real-time trading overview</p>
                </div>
                <div className="flex items-center gap-3">
                    {summary.data?.paperMode !== undefined && (
                        <Badge color={summary.data.paperMode ? 'yellow' : 'red'}>
                            {summary.data.paperMode ? '📝 Paper Mode' : '🔴 LIVE'}
                        </Badge>
                    )}
                    <span className="text-xs text-slate-600 tabular-nums">
                        {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', year: 'numeric' })}
                    </span>
                </div>
            </div>

            {/* Stat cards */}
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-5">
                <ErrorBoundary><PnLCard      data={summary.data} loading={summary.loading} /></ErrorBoundary>
                <ErrorBoundary><DailyRoiCard data={summary.data} loading={summary.loading} /></ErrorBoundary>
                <ErrorBoundary><TradesCard   data={summary.data} loading={summary.loading} /></ErrorBoundary>
                <ErrorBoundary><WinRateCard  data={summary.data} loading={summary.loading} /></ErrorBoundary>
                <ErrorBoundary><DrawdownCard data={summary.data} loading={summary.loading} /></ErrorBoundary>
            </div>

            {/* Health + killswitch */}
            <div className="grid grid-cols-1 gap-5 xl:grid-cols-2">
                <ErrorBoundary><HealthWidget      data={health.data}  loading={health.loading}   /></ErrorBoundary>
                <ErrorBoundary><KillSwitchWidget  data={summary.data} loading={summary.loading}  /></ErrorBoundary>
            </div>

            {/* Market Overview */}
            <ErrorBoundary>
                <MarketOverview 
                    data={market.data} 
                    loading={market.loading} 
                    watchlist={summary.data?.watchlist}
                    dynamicWatchlist={summary.data?.dynamicWatchlist}
                    onSummaryRefetch={summary.refetch}
                />
            </ErrorBoundary>

            {/* Positions */}
            <ErrorBoundary>
                <PositionsTable data={positions.data} loading={positions.loading} />
            </ErrorBoundary>
        </div>
    );
}

// ── Stat cards ────────────────────────────────────────────────
function PnLCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const pnl = data?.pnl ?? 0;
    return (
        <div className={`${CARD} ${pnl >= 0 ? 'pulse-green' : 'pulse-red'}`}>
            <p className={LABEL}>Daily P&L</p>
            <p className={`text-3xl font-bold tracking-tight tabular-nums ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {formatINR(pnl)}
            </p>
            <p className={`${MUTED} mt-2 ${pnl >= 0 ? 'text-green-500' : 'text-red-500'}`}>{formatPct(data?.pnlPct)}</p>
        </div>
    );
}

function DailyRoiCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const roi = data?.dailyRoi ?? 0;
    const deployed = data?.totalCashRequired ?? 0;
    return (
        <div className={`${CARD} ${roi >= 0 ? 'pulse-green' : 'pulse-red'}`}>
            <p className={LABEL}>Daily ROI</p>
            <p className={`text-3xl font-bold tracking-tight tabular-nums ${roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
            </p>
            <p className={`${MUTED} mt-2`}>on {formatINR(deployed)}</p>
        </div>
    );
}

function TradesCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    return (
        <div className={CARD}>
            <p className={LABEL}>Trades Today</p>
            <p className="text-3xl font-bold tracking-tight tabular-nums text-white">{data?.tradeCount ?? 0}</p>
            <p className={`${MUTED} mt-2`}>{data?.filled ?? 0} filled · {data?.rejected ?? 0} rejected</p>
        </div>
    );
}

function WinRateCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const wr = data?.tradeCount ? ((data.winCount || 0) / data.tradeCount * 100) : 0;
    return (
        <div className={CARD}>
            <p className={LABEL}>Win Rate</p>
            <p className={`text-3xl font-bold tracking-tight tabular-nums ${wr >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                {wr.toFixed(1)}%
            </p>
            <p className={`${MUTED} mt-2`}>{data?.winCount ?? 0}W / {data?.lossCount ?? 0}L</p>
        </div>
    );
}

function DrawdownCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const dd = data?.drawdownPct ?? 0;
    return (
        <div className={CARD}>
            <p className={LABEL}>Max Drawdown</p>
            <p className={`text-3xl font-bold tracking-tight tabular-nums ${dd > 3 ? 'text-red-400' : dd > 1 ? 'text-yellow-400' : 'text-green-400'}`}>
                {dd.toFixed(2)}%
            </p>
            <p className={`${MUTED} mt-2`}>Capital: {formatINR(data?.capital)}</p>
        </div>
    );
}

// ── Health widget ─────────────────────────────────────────────
function HealthWidget({ data, loading }) {
    const services = [
        { name: 'Broker API',   key: 'broker',           icon: '🔗' },
        { name: 'Broker Token', key: 'brokerTokenValid',  icon: '🔑' },
        { name: 'Redis',        key: 'redis',             icon: '🗄️' },
        { name: 'Database',     key: 'db',                icon: '💾' },
        { name: 'Data Feed',    key: 'dataFeed',          icon: '📡' },
        { name: 'Telegram',     key: 'telegram',          icon: '📱' },
    ];
    const allOk = services.every(s => data?.[s.key] !== false);

    return (
        <div className={`${CARD} ${!allOk ? 'border-red-500/30' : ''}`}>
            <div className="flex items-center justify-between mb-5">
                <p className={LABEL}>System Health</p>
                <Badge color={allOk ? 'green' : 'red'}>{allOk ? '✅ All Systems Go' : '⚠️ Degraded'}</Badge>
            </div>
            {loading ? (
                <div className="space-y-2"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div>
            ) : (
                <div className="space-y-0.5">
                    {services.map(s => {
                        const ok  = data?.[s.key] !== false;
                        const na  = data?.[s.key] == null;
                        const dotColor = na ? 'bg-yellow-400' : ok ? 'bg-green-400' : 'bg-red-400';
                        const dotGlow  = na ? '' : ok ? 'shadow-[0_0_6px_#22c55e]' : 'shadow-[0_0_6px_#ef4444]';
                        const textColor = na ? 'text-yellow-400' : ok ? 'text-green-400' : 'text-red-400';
                        const label = s.key === 'brokerTokenValid'
                            ? (na ? 'Not checked' : ok ? 'Valid' : 'EXPIRED')
                            : (ok ? 'Connected' : 'DOWN');
                        return (
                            <div key={s.key} className="flex items-center justify-between rounded-xl px-3 py-2 hover:bg-white/[0.04] transition-colors">
                                <div className="flex items-center gap-2.5">
                                    <span>{s.icon}</span>
                                    <span className="text-sm text-slate-300">{s.name}</span>
                                </div>
                                <div className="flex items-center gap-2">
                                    <span className={`w-2 h-2 rounded-full ${dotColor} ${dotGlow}`} />
                                    <span className={`text-xs font-semibold ${textColor}`}>{label}</span>
                                </div>
                            </div>
                        );
                    })}
                </div>
            )}
            {data?.lastCheck && (
                <p className={`${MUTED} mt-4`}>
                    Last check: {new Date(data.lastCheck).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
                </p>
            )}
        </div>
    );
}

// ── Kill switch ───────────────────────────────────────────────
function KillSwitchWidget({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const engaged = data?.killSwitchEngaged;
    return (
        <div className={`${CARD} ${engaged ? 'border-red-500/40 pulse-red' : ''}`}>
            <div className="flex items-center justify-between mb-4">
                <p className={LABEL}>Kill Switch</p>
                <Badge color={engaged ? 'red' : 'green'}>{engaged ? '🛑 ENGAGED' : '✅ Normal'}</Badge>
            </div>
            {engaged ? (
                <div>
                    <p className="text-red-400 text-sm mb-2">All new orders are <strong>BLOCKED</strong></p>
                    {data?.killSwitchReason && <p className={MUTED}>Reason: {data.killSwitchReason}</p>}
                </div>
            ) : (
                <p className="text-sm text-slate-400">
                    Trading is active. Kill switch can be engaged from{' '}
                    <a href="/settings" className="text-indigo-400 hover:underline">Settings</a>.
                </p>
            )}
        </div>
    );
}

// ── Market Overview ───────────────────────────────────────────
function MarketOverview({ data, loading, watchlist, dynamicWatchlist, onSummaryRefetch }) {
    const [activeTab, setActiveTab] = useState('NSE');

    const toggleWatchlist = async (symbol, listType) => {
        try {
            const key = process.env.NEXT_PUBLIC_API_KEY || '';
            const r = await fetch(`${API_BASE}/api/settings/watchlist`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Api-Key': key } : {}) },
                body: JSON.stringify({ action: 'toggle', symbol, list: listType }),
            });
            if (r.ok && onSummaryRefetch) onSummaryRefetch();
        } catch (e) {
            console.error('Failed to toggle watchlist', e);
        }
    };

    if (loading && !data) return (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            <SkeletonCard />
            <SkeletonCard />
            <SkeletonCard />
        </div>
    );

    const indices = (data?.indices || []).slice(0, 3);
    const gold = data?.gold;
    const movers = activeTab === 'NSE' ? data?.nse : data?.bse;
    const gainers = movers?.gainers || [];
    const losers = movers?.losers || [];

    const TH = 'py-2 px-3 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-500 border-b border-white/5';
    const TD = 'py-2 px-3 text-sm text-slate-300';
    
    return (
        <div className="grid grid-cols-1 gap-5 lg:grid-cols-3">
            {/* Indices & Gold */}
            <div className="space-y-5">
                <div className={CARD}>
                    <p className={LABEL}>Market Indices</p>
                    <div className="space-y-4">
                        {indices.map(idx => (
                            <div key={idx.name} className="flex items-center justify-between">
                                <div>
                                    <p className="text-sm font-medium text-slate-300">{idx.name}</p>
                                    <p className="text-xl font-bold text-white tabular-nums">{formatINR(idx.ltp)}</p>
                                </div>
                                <div className="text-right">
                                    <p className={`text-sm font-semibold ${idx.change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                        {idx.change >= 0 ? '+' : ''}{idx.change.toFixed(2)}
                                    </p>
                                    <p className={`text-xs ${idx.change >= 0 ? 'text-green-500/80' : 'text-red-500/80'}`}>
                                        {idx.changePct.toFixed(2)}%
                                    </p>
                                </div>
                            </div>
                        ))}
                        {gold && (
                            <div className="pt-4 border-t border-slate-700/40">
                                <div className="flex items-center justify-between">
                                    <div className="flex items-center gap-2">
                                        <span className="text-xl">🟡</span>
                                        <div>
                                            <p className="text-sm font-medium text-slate-300">{gold.name}</p>
                                            <p className="text-lg font-bold text-white tabular-nums">{formatINR(gold.ltp)}</p>
                                        </div>
                                    </div>
                                    <div className="text-right">
                                        <p className={`text-sm font-semibold ${gold.change >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                            {gold.change >= 0 ? '+' : ''}{gold.change.toFixed(2)}
                                        </p>
                                        <p className={`text-xs ${gold.change >= 0 ? 'text-green-500/80' : 'text-red-500/80'}`}>
                                            {gold.changePct.toFixed(2)}%
                                        </p>
                                    </div>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            {/* Top Gainers */}
            <div className={CARD}>
                <div className="flex items-center justify-between mb-4">
                    <p className={LABEL}>Top Gainers</p>
                    <div className="flex items-center bg-slate-800/80 p-0.5 rounded-lg border border-white/5 shrink-0 scale-90 origin-right">
                        <button 
                            onClick={(e) => { e.stopPropagation(); setActiveTab('NSE'); }} 
                            className={`px-2 py-0.5 text-[9px] font-bold rounded-md transition-all ${activeTab === 'NSE' ? 'bg-blue-500/30 text-blue-400 border border-blue-500/40' : 'text-slate-500 hover:text-slate-300'}`}
                        >NSE</button>
                        <button 
                            onClick={(e) => { e.stopPropagation(); setActiveTab('BSE'); }} 
                            className={`px-2 py-0.5 text-[9px] font-bold rounded-md transition-all ${activeTab === 'BSE' ? 'bg-blue-500/30 text-blue-400 border border-blue-500/40' : 'text-slate-500 hover:text-slate-300'}`}
                        >BSE</button>
                    </div>
                </div>
                <div className="overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr>
                                <th className={TH}>Symbol</th>
                                <th className={TH}>LTP</th>
                                <th className={`${TH} text-right`}>Change</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/4">
                            {gainers.map((s, i) => {
                                const isPinned = watchlist?.includes(s.symbol);
                                const isDynamic = dynamicWatchlist?.includes(s.symbol);
                                return (
                                <tr key={`${s.symbol}-${i}`} className="hover:bg-white/2 transition-colors group">
                                    <td className={TD}>
                                        <div className="flex items-center justify-between">
                                            <span className="font-semibold text-white">{s.symbol}</span>
                                            <div className="flex opacity-0 group-hover:opacity-100 transition-opacity items-center gap-1 scale-90 origin-right">
                                                <button onClick={(e) => { e.stopPropagation(); toggleWatchlist(s.symbol, 'pinned'); }} className={`px-1.5 py-0.5 rounded transition ${isPinned ? 'opacity-100 ring-1 ring-blue-500/50 bg-blue-500/20' : 'opacity-40 hover:opacity-100 bg-white/5'} flex items-center shrink-0`} title="Toggle Pinned"><span className="text-[10px]">📌</span></button>
                                                <button onClick={(e) => { e.stopPropagation(); toggleWatchlist(s.symbol, 'dynamic'); }} className={`px-1.5 py-0.5 rounded transition ${isDynamic ? 'opacity-100 ring-1 ring-purple-500/50 bg-purple-500/20' : 'opacity-40 hover:opacity-100 bg-white/5'} flex items-center shrink-0`} title="Toggle Dynamic"><span className="text-[10px]">⚡</span></button>
                                            </div>
                                        </div>
                                    </td>
                                    <td className={`${TD} tabular-nums`}>{s.price?.toFixed(2)}</td>
                                    <td className={`${TD} text-right font-semibold text-green-400 tabular-nums`}>+{(s.changePct ?? 0).toFixed(2)}%</td>
                                </tr>
                                );
                            })}
                            {gainers.length === 0 && <tr><td colSpan="3" className="py-8 text-center text-xs text-slate-500 italic">No gainers in {activeTab} universe</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* Top Losers */}
            <div className={CARD}>
                <div className="flex items-center justify-between mb-4">
                    <p className={LABEL}>Top Losers</p>
                    <div className="flex items-center bg-slate-800/80 p-0.5 rounded-lg border border-white/5 shrink-0 scale-90 origin-right">
                        <button 
                            onClick={(e) => { e.stopPropagation(); setActiveTab('NSE'); }} 
                            className={`px-2 py-0.5 text-[9px] font-bold rounded-md transition-all ${activeTab === 'NSE' ? 'bg-blue-500/30 text-blue-400 border border-blue-500/40' : 'text-slate-500 hover:text-slate-300'}`}
                        >NSE</button>
                        <button 
                            onClick={(e) => { e.stopPropagation(); setActiveTab('BSE'); }} 
                            className={`px-2 py-0.5 text-[9px] font-bold rounded-md transition-all ${activeTab === 'BSE' ? 'bg-blue-500/30 text-blue-400 border border-blue-500/40' : 'text-slate-500 hover:text-slate-300'}`}
                        >BSE</button>
                    </div>
                </div>
                <div className="overflow-hidden">
                    <table className="w-full">
                        <thead>
                            <tr>
                                <th className={TH}>Symbol</th>
                                <th className={TH}>LTP</th>
                                <th className={`${TH} text-right`}>Change</th>
                            </tr>
                        </thead>
                        <tbody className="divide-y divide-white/4">
                            {losers.map((s, i) => {
                                const isPinned = watchlist?.includes(s.symbol);
                                const isDynamic = dynamicWatchlist?.includes(s.symbol);
                                return (
                                <tr key={`${s.symbol}-${i}`} className="hover:bg-white/2 transition-colors group">
                                    <td className={TD}>
                                        <div className="flex items-center justify-between">
                                            <span className="font-semibold text-white">{s.symbol}</span>
                                            <div className="flex opacity-0 group-hover:opacity-100 transition-opacity items-center gap-1 scale-90 origin-right">
                                                <button onClick={(e) => { e.stopPropagation(); toggleWatchlist(s.symbol, 'pinned'); }} className={`px-1.5 py-0.5 rounded transition ${isPinned ? 'opacity-100 ring-1 ring-blue-500/50 bg-blue-500/20' : 'opacity-40 hover:opacity-100 bg-white/5'} flex items-center shrink-0`} title="Toggle Pinned"><span className="text-[10px]">📌</span></button>
                                                <button onClick={(e) => { e.stopPropagation(); toggleWatchlist(s.symbol, 'dynamic'); }} className={`px-1.5 py-0.5 rounded transition ${isDynamic ? 'opacity-100 ring-1 ring-purple-500/50 bg-purple-500/20' : 'opacity-40 hover:opacity-100 bg-white/5'} flex items-center shrink-0`} title="Toggle Dynamic"><span className="text-[10px]">⚡</span></button>
                                            </div>
                                        </div>
                                    </td>
                                    <td className={`${TD} tabular-nums`}>{s.price?.toFixed(2)}</td>
                                    <td className={`${TD} text-right font-semibold text-red-400 tabular-nums`}>{(s.changePct ?? 0).toFixed(2)}%</td>
                                </tr>
                                );
                            })}
                            {losers.length === 0 && <tr><td colSpan="3" className="py-8 text-center text-xs text-slate-500 italic">No losers in {activeTab} universe</td></tr>}
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    );
}

// ── Positions table ───────────────────────────────────────────
function PositionsTable({ data, loading }) {
    const [confirm, setConfirm]       = useState(null);
    const [exiting, setExiting]       = useState(null);
    const [exitMsg, setExitMsg]       = useState(null);
    const [chartSymbol, setChartSymbol] = useState(null);

    const handleExitClick = (pos) => { setExitMsg(null); setConfirm({ symbol: pos.symbol, entryPrice: pos.entryPrice, qty: pos.quantity, side: pos.side }); };

    const handleExitConfirm = async () => {
        if (!confirm) return;
        const sym = confirm.symbol;
        setExiting(sym); setConfirm(null);
        try {
            const key = process.env.NEXT_PUBLIC_API_KEY || '';
            const r = await fetch(`${API_BASE}/api/positions/exit`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...(key ? { 'X-Api-Key': key } : {}) },
                body: JSON.stringify({ symbol: sym }),
            });
            const res = await r.json();
            if (!r.ok) throw new Error(res.error || 'Exit failed');
            const s = (res.pnl ?? 0) >= 0 ? '+' : '';
            setExitMsg({ ok: true, text: `✅ ${sym} exited @ ₹${res.exitPrice?.toFixed(2)} · P&L ${s}₹${(res.pnl ?? 0).toFixed(2)}` });
        } catch (e) { setExitMsg({ ok: false, text: `❌ ${e.message}` }); }
        finally { setExiting(null); }
    };

    const positions = data?.positions || [];

    const TH = 'py-3 px-4 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-500 border-b border-white/[0.06] whitespace-nowrap';
    const TD = 'py-4 px-4 text-sm text-slate-300 whitespace-nowrap';

    return (
        <>
            {/* Confirm modal */}
            {confirm && (
                <div onClick={() => setConfirm(null)} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                    <div onClick={e => e.stopPropagation()} className="w-80 rounded-2xl border border-white/[0.08] bg-[#141922] p-6 shadow-2xl">
                        <p className="text-base font-bold text-white mb-1">🔴 Exit position?</p>
                        <p className="text-sm text-slate-400 mb-4 leading-relaxed">
                            <strong className="text-white">{confirm.symbol}</strong> &nbsp;
                            <Badge color={confirm.side === 'BUY' ? 'green' : 'red'}>{confirm.side}</Badge>
                            <br />Qty: {confirm.qty} · Entry: ₹{confirm.entryPrice?.toFixed(2)}
                            <br /><span className="text-xs text-slate-600">Exits at current market price.</span>
                        </p>
                        <div className="flex gap-3">
                            <button onClick={handleExitConfirm}
                                className="flex-1 rounded-xl bg-red-500/15 border border-red-500/30 text-red-400 py-2 text-sm font-semibold hover:bg-red-500/25 transition">
                                Exit Now
                            </button>
                            <button onClick={() => setConfirm(null)}
                                className="flex-1 rounded-xl bg-white/5 border border-white/10 text-slate-400 py-2 text-sm font-semibold hover:bg-white/10 transition">
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Chart modal */}
            {chartSymbol && (
                <div onClick={() => setChartSymbol(null)} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md">
                    <div onClick={e => e.stopPropagation()} className="w-[92vw] max-w-[1050px] rounded-2xl border border-white/10 bg-[#0d1117] p-6 shadow-2xl">
                        <div className="flex items-center justify-between mb-5">
                            <div>
                                <h2 className="text-xl font-bold text-white">{chartSymbol.symbol}</h2>
                                <p className="text-xs text-slate-500 mt-0.5">Live · 5-minute candles</p>
                            </div>
                            <button onClick={() => setChartSymbol(null)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-400 hover:text-white transition">✕</button>
                        </div>
                        <TradingChart symbol={chartSymbol.symbol} trades={chartSymbol.trades} isLive={chartSymbol.isLive} liveData={chartSymbol.liveData ?? {}} />
                    </div>
                </div>
            )}

            {/* Table card */}
            <div className="rounded-2xl border border-slate-700/50 bg-slate-900 overflow-hidden">
                <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/40">
                    <p className="text-sm font-semibold text-white">Open Positions</p>
                    <Badge color="blue">{positions.length} active</Badge>
                </div>

                {exitMsg && (
                    <div className={`mx-6 mt-4 rounded-xl border px-4 py-2.5 text-sm ${exitMsg.ok ? 'bg-green-500/10 border-green-500/25 text-green-400' : 'bg-red-500/10 border-red-500/25 text-red-400'}`}>
                        {exitMsg.text}
                    </div>
                )}

                {loading ? (
                    <div className="p-6 space-y-2"><SkeletonRow /><SkeletonRow /><SkeletonRow /></div>
                ) : positions.length === 0 ? (
                    <div className="py-16 text-center">
                        <p className="text-3xl mb-3">📭</p>
                        <p className="text-sm text-slate-500">No open positions</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="w-full border-collapse">
                            <thead>
                                <tr>
                                    {['Symbol','Side','Qty','Avg Price','Entry','Current','P&L','Target','Stop Loss','Chart',''].map(h => (
                                        <th key={h} className={TH}>{h}</th>
                                    ))}
                                </tr>
                            </thead>
                            <tbody>
                                {positions.map((pos, i) => {
                                    const pnl = pos.unrealisedPnL ?? 0;
                                    const isExiting = exiting === pos.symbol;
                                    return (
                                        <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors">
                                            <td className={`${TD} font-semibold text-white`}>{pos.symbol}</td>
                                            <td className={TD}><Badge color={pos.side === 'BUY' ? 'green' : 'red'}>{pos.side}</Badge></td>
                                            <td className={`${TD} tabular-nums`}>{pos.quantity}</td>
                                            <td className={`${TD} tabular-nums`}>{formatINR(pos.avgPrice)}</td>
                                            <td className={`${TD} tabular-nums`}>{formatINR(pos.entryPrice)}</td>
                                            <td className={`${TD} tabular-nums font-medium text-white`}>{formatINR(pos.currentPrice)}</td>
                                            <td className={`${TD} tabular-nums font-semibold ${pnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatINR(pnl)}</td>
                                            <td className={`${TD} tabular-nums text-blue-400`}>{pos.targetPrice ? formatINR(pos.targetPrice) : '—'}</td>
                                            <td className={`${TD} tabular-nums text-yellow-400`}>{pos.stopLoss ? formatINR(pos.stopLoss) : '—'}</td>
                                            <td className={TD}>
                                                <button
                                                    onClick={() => setChartSymbol({
                                                        symbol: pos.symbol,
                                                        trades: [{
                                                            ...pos, price: pos.entryPrice, pnl: pos.unrealisedPnL ?? null,
                                                            tradeType: pos.side === 'BUY' ? 'LONG_ENTRY' : 'SHORT_ENTRY',
                                                            timestamp: pos.entryTimestamp ?? null,  // FIX: use actual entry time for marker
                                                            date: pos.entryTimestamp ? new Date(pos.entryTimestamp).toLocaleDateString('en-IN') : new Date().toLocaleDateString('en-IN'),
                                                            peakPnl: pos.peakUnrealizedPnl ?? null,  // FIX: use real peak PnL from backend
                                                        }],
                                                        isLive: true,
                                                        liveData: { currentPrice: pos.currentPrice, entryPrice: pos.entryPrice, stopLoss: pos.stopLoss ?? null, targetPrice: pos.targetPrice ?? null, trailingStop: pos.trailStopPrice ?? null },
                                                    })}
                                                    className="rounded-lg border border-emerald-500/25 bg-emerald-500/10 px-3 py-1 text-xs font-medium text-emerald-400 hover:bg-emerald-500/20 transition">
                                                    📈 Live
                                                </button>
                                            </td>
                                            <td className={TD}>
                                                <button
                                                    id={`exit-btn-${pos.symbol}`}
                                                    onClick={() => handleExitClick(pos)}
                                                    disabled={isExiting}
                                                    className="rounded-lg border border-red-500/25 bg-red-500/10 px-3 py-1 text-xs font-medium text-red-400 hover:bg-red-500/20 transition disabled:opacity-40">
                                                    {isExiting ? '⏳ …' : '🔴 Exit'}
                                                </button>
                                            </td>
                                        </tr>
                                    );
                                })}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </>
    );
}
