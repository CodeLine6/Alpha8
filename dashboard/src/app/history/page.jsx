'use client';

import { useState, useCallback, useEffect } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, API_BASE } from '@/lib/utils';
import TradingChart from '@/components/TradingChart';

const CARD = 'rounded-2xl border border-slate-700/50 bg-slate-900';
const TH = 'py-3 px-4 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-500 border-b border-slate-700/40 whitespace-nowrap';
const TD = 'py-4 px-4 text-sm text-slate-300 whitespace-nowrap';

function Badge({ color, children }) {
    const cls = { green: 'bg-green-500/10 text-green-400 border-green-500/20', red: 'bg-red-500/10 text-red-400 border-red-500/20', yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20' }[color] ?? 'bg-white/5 text-slate-400 border-white/10';
    return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

const TYPE_CONFIG = {
    LONG_ENTRY: { label: 'L Entry', color: 'green' },
    LONG_EXIT: { label: 'L Exit', color: 'yellow' },
    SHORT_ENTRY: { label: 'S Entry', color: 'red' },
    SHORT_COVER: { label: 'S Cover', color: 'blue' },
};

export default function HistoryPage() {
    const [trades, setTrades] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('ALL');
    const [chartSymbol, setChartSymbol] = useState(null);
    const [filters, setFilters] = useState({ startDate: '', endDate: '', strategy: '', symbol: '', side: '', tradeType: '' });

    const fetchTrades = useCallback(async () => {
        setLoading(true);
        try {
            const p = new URLSearchParams();
            Object.entries(filters).forEach(([k, v]) => { if (v) p.set(k, v); });
            const r = await fetch(`${API_BASE}/api/trades?${p}`);
            const j = await r.json();
            setTrades(j.trades || []);
        } catch { /* ErrorBoundary */ }
        finally { setLoading(false); }
    }, [filters]);

    useEffect(() => { fetchTrades(); }, [fetchTrades]);

    const exportCSV = () => {
        if (!trades.length) return;
        const hdr = ['Date', 'Time', 'Symbol', 'Type', 'Side', 'Qty', 'Price', 'P&L', 'Capital Deployed', 'ROI %', 'Strategy', 'Status'];
        const rows = trades.map(t => [t.date, t.timestamp ? new Date(t.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }) : '', t.symbol, t.tradeType ?? '', t.side, t.quantity, t.price, t.pnl, t.capitalDeployed ?? '', t.tradeRoi != null ? t.tradeRoi.toFixed(4) : '', t.strategy, t.status]);
        const csv = [hdr.join(','), ...rows.map(r => r.join(','))].join('\n');
        const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })), download: `alpha8-trades-${new Date().toISOString().split('T')[0]}.csv` });
        a.click();
    };

    const visible = trades
        .filter(t => {
            const type = t.tradeType;
            if (filters.tradeType && type !== filters.tradeType) return false;
            if (activeTab === 'LONG' && type !== 'LONG_ENTRY' && type !== 'LONG_EXIT') return false;
            if (activeTab === 'SHORT' && type !== 'SHORT_ENTRY' && type !== 'SHORT_COVER') return false;
            return true;
        })
        .sort((a, b) => {
            // Oldest first so entries always appear above their covers
            const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
            const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
            return ta - tb;
        })
        .reverse();

    const INP = 'w-full rounded-xl border border-white/[0.08] bg-[#0d1117] px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition';
    const TABS = ['ALL', 'LONG', 'SHORT'];
    const TAB_LABELS = { ALL: 'All Orders', LONG: 'Long', SHORT: 'Short' };

    return (
        <div className="space-y-6">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Trade History</h1>
                    <p className="text-sm text-slate-500 mt-1">View and export past trades</p>
                </div>
                <button onClick={exportCSV} disabled={!trades.length}
                    className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-medium text-indigo-400 hover:bg-indigo-500/20 transition disabled:opacity-40">
                    📥 Export CSV
                </button>
            </div>

            {/* Tabs */}
            <div className="flex border-b border-white/[0.06]">
                {TABS.map(tab => (
                    <button key={tab} onClick={() => setActiveTab(tab)}
                        className={`px-5 pb-3 text-sm font-medium transition border-b-2 -mb-px ${activeTab === tab ? 'border-indigo-500 text-indigo-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}>
                        {TAB_LABELS[tab]}
                    </button>
                ))}
            </div>

            {/* Filters */}
            <div className={`${CARD} p-5`}>
                <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-6">
                    {[
                        { label: 'Start Date', key: 'startDate', type: 'date' },
                        { label: 'End Date', key: 'endDate', type: 'date' },
                    ].map(({ label, key, type }) => (
                        <div key={key}>
                            <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">{label}</label>
                            <input type={type} className={INP} value={filters[key]} onChange={e => setFilters(f => ({ ...f, [key]: e.target.value }))} />
                        </div>
                    ))}
                    <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">Strategy</label>
                        <select className={INP} value={filters.strategy} onChange={e => setFilters(f => ({ ...f, strategy: e.target.value }))}>
                            <option value="">All</option>
                            {['EMA_CROSSOVER', 'RSI_MEAN_REVERSION', 'VWAP_MOMENTUM', 'BREAKOUT_VOLUME', 'ORB', 'BAVI'].map(s => <option key={s} value={s}>{s}</option>)}
                        </select>
                    </div>
                    <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">Symbol</label>
                        <input type="text" className={INP} placeholder="e.g. RELIANCE" value={filters.symbol} onChange={e => setFilters(f => ({ ...f, symbol: e.target.value.toUpperCase() }))} />
                    </div>
                    <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">Side</label>
                        <select className={INP} value={filters.side} onChange={e => setFilters(f => ({ ...f, side: e.target.value }))}>
                            <option value="">All</option><option>BUY</option><option>SELL</option>
                        </select>
                    </div>
                    <div>
                        <label className="block text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-1.5">Type</label>
                        <select className={INP} value={filters.tradeType} onChange={e => setFilters(f => ({ ...f, tradeType: e.target.value }))}>
                            <option value="">All</option>
                            {Object.entries(TYPE_CONFIG).map(([v, c]) => <option key={v} value={v}>{c.label}</option>)}
                        </select>
                    </div>
                </div>
            </div>

            {/* Chart modal */}
            {chartSymbol && (
                <div onClick={() => setChartSymbol(null)} className="fixed inset-0 z-[60] flex items-center justify-center bg-black/85 backdrop-blur-md">
                    <div onClick={e => e.stopPropagation()} className="w-[92vw] max-w-[1050px] rounded-2xl border border-white/10 bg-[#0d1117] p-6 shadow-2xl">
                        <div className="flex items-center justify-between mb-5">
                            <h2 className="text-xl font-bold text-white">{chartSymbol.symbol}</h2>
                            <button onClick={() => setChartSymbol(null)} className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm text-slate-400 hover:text-white transition">✕</button>
                        </div>
                        <TradingChart symbol={chartSymbol.symbol} trades={chartSymbol.trades} endDate={chartSymbol.endDate} isLive={chartSymbol.isLive} />
                    </div>
                </div>
            )}

            {/* Table */}
            <ErrorBoundary>
                <div className={`${CARD} overflow-hidden`}>
                    {loading ? (
                        <div className="p-6 space-y-2">{[1, 2, 3, 4, 5].map(i => <div key={i} className="h-10 rounded-xl bg-white/[0.04] animate-pulse" />)}</div>
                    ) : visible.length === 0 ? (
                        <div className="py-16 text-center"><p className="text-3xl mb-3">📭</p><p className="text-sm text-slate-500">No trades found</p></div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full border-collapse">
                                <thead>
                                    <tr>{['Date', 'Symbol', 'Type', 'Qty', 'Price', 'P&L', 'Deployed', 'ROI', 'Strategy', 'Status', 'Chart'].map(h => <th key={h} className={TH}>{h}</th>)}</tr>
                                </thead>
                                <tbody>
                                    {visible.map((tr, i) => {
                                        const tc = TYPE_CONFIG[tr.tradeType] ?? { label: tr.side, color: tr.side === 'BUY' ? 'green' : 'red' };
                                        const statusColor = { FILLED: 'green', REJECTED: 'red' }[tr.status] ?? 'yellow';
                                        return (
                                            <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors">
                                                <td className={`${TD} tabular-nums`}>
                                                    <div>{tr.date}</div>
                                                    {tr.timestamp && <div className="text-[11px] text-slate-500 mt-0.5">{new Date(tr.timestamp).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })}</div>}
                                                </td>
                                                <td className={`${TD} font-semibold text-white`}>{tr.symbol}</td>
                                                <td className={TD}><Badge color={tc.color}>{tc.label}</Badge></td>
                                                <td className={`${TD} tabular-nums`}>{tr.quantity}</td>
                                                <td className={`${TD} tabular-nums`}>{formatINR(tr.price)}</td>
                                                <td className={`${TD} tabular-nums font-semibold ${(tr.pnl ?? 0) >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatINR(tr.pnl)}</td>
                                                <td className={`${TD} tabular-nums text-slate-400`}>{tr.capitalDeployed != null ? formatINR(tr.capitalDeployed) : '—'}</td>
                                                <td className={`${TD} tabular-nums font-medium ${tr.tradeRoi == null ? 'text-slate-600' : tr.tradeRoi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {tr.tradeRoi != null ? `${tr.tradeRoi >= 0 ? '+' : ''}${tr.tradeRoi.toFixed(2)}%` : '—'}
                                                </td>
                                                <td className={`${TD} text-slate-400`}>{tr.strategy}</td>
                                                <td className={TD}><Badge color={statusColor}>{tr.status}</Badge></td>
                                                <td className={TD}>
                                                    <button onClick={() => {
                                                        const tradeDate = tr.timestamp
                                                            ? new Date(tr.timestamp).toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
                                                            : undefined;
                                                        const todayIST = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' });
                                                        const isToday = tradeDate === todayIST;
                                                        setChartSymbol({ symbol: tr.symbol, trades: trades.filter(t => t.symbol === tr.symbol && t.date === tr.date), endDate: isToday ? undefined : tradeDate, isLive: isToday });
                                                    }} className="rounded-lg border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-medium text-blue-400 hover:bg-blue-500/20 transition">
                                                        📈 Chart
                                                    </button>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                            <p className="px-4 py-3 text-xs text-slate-600 border-t border-white/[0.04]">{trades.length} trades found</p>
                        </div>
                    )}
                </div>
            </ErrorBoundary>
        </div>
    );
}
