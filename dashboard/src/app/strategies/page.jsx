'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, formatPct, API_BASE } from '@/lib/utils';

const CARD = 'rounded-2xl border border-slate-700/50 bg-slate-900';
const TH = 'py-3 px-4 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-500 border-b border-slate-700/40 whitespace-nowrap';
const TD = 'py-4 px-4 text-sm text-slate-300 whitespace-nowrap';

function Badge({ color, children }) {
    const cls = { green: 'bg-green-500/10 text-green-400 border-green-500/20', red: 'bg-red-500/10 text-red-400 border-red-500/20', yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20' }[color] ?? 'bg-white/5 text-slate-400 border-white/10';
    return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

function StatRow({ label, value, valueClass = 'text-white' }) {
    return (
        <div>
            <p className="text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-0.5">{label}</p>
            <p className={`text-sm font-semibold ${valueClass}`}>{value}</p>
        </div>
    );
}

// Main Hub Page
export default function StrategiesPage() {
    const [strategies, setStrategies] = useState([]);
    const [signals,    setSignals]    = useState([]);
    const [loading,    setLoading]    = useState(true);

    const fetchData = useCallback(async () => {
        try {
            const [sr, sigr] = await Promise.all([
                fetch(`${API_BASE}/api/strategies/performance`),
                fetch(`${API_BASE}/api/strategies/signals?limit=50`),
            ]);
            setStrategies((await sr.json()).strategies || []);
            setSignals((await sigr.json()).signals || []);
        } catch { /* ErrorBoundary */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    const sigColor = (s) => s === 'BUY' ? 'green' : s === 'SELL' ? 'red' : 'yellow';

    const summaryTable = (
        <div className={`${CARD} overflow-hidden mb-6`}>
            <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
                <p className="text-sm font-semibold text-white">Strategy Summary</p>
                <Link href="/strategies/performance" className="text-[10px] font-bold uppercase tracking-wider text-blue-400 hover:text-blue-300 transition-colors pointer-events-auto">
                    View Detailed Metrics →
                </Link>
            </div>
            {loading ? (
                <div className="p-6 space-y-2">{[1, 2].map(i => <div key={i} className="h-8 rounded-lg bg-white/[0.04] animate-pulse" />)}</div>
            ) : strategies.length === 0 ? (
                <div className="py-8 text-center text-slate-500 text-xs italic">No performance data available</div>
            ) : (
                <div className="overflow-x-auto">
                    <table className="w-full border-collapse">
                        <thead><tr>{['Strategy', 'Win Rate', 'Total P&L', 'Trades'].map(h => <th key={h} className={TH}>{h}</th>)}</tr></thead>
                        <tbody>
                            {strategies.slice(0, 5).map((s, i) => (
                                <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.02] transition-colors">
                                    <td className={`${TD} font-medium text-white max-w-[200px] truncate`} title={s.name}>{s.name}</td>
                                    <td className={TD}><Badge color={s.winRate >= 50 ? 'green' : 'red'}>{s.winRate?.toFixed(1)}%</Badge></td>
                                    <td className={`${TD} ${s.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'}`}>{formatINR(s.totalPnl)}</td>
                                    <td className={`${TD} text-slate-500`}>{s.tradeCount}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                </div>
            )}
        </div>
    );

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Strategy Hub</h1>
                    <p className="text-sm text-slate-500 mt-1">Live signal log and performance overview</p>
                </div>
                <Link href="/strategies/performance" className="hidden sm:inline-flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-500 text-white rounded-xl text-xs font-semibold transition-all shadow-lg shadow-blue-500/20">
                    📊 Detailed Performance
                </Link>
            </div>

            <ErrorBoundary>
                {summaryTable}
            </ErrorBoundary>

            <ErrorBoundary>
                <div className={`${CARD} overflow-hidden`}>
                    <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.06]">
                        <p className="text-sm font-semibold text-white">Signal Log</p>
                        <span className="text-xs text-slate-500">Last 50 signals</span>
                    </div>
                    {loading ? (
                        <div className="p-6 space-y-2">{[1,2,3].map(i => <div key={i} className="h-10 rounded-xl bg-white/[0.04] animate-pulse" />)}</div>
                    ) : signals.length === 0 ? (
                        <div className="py-16 text-center"><p className="text-3xl mb-3">📡</p><p className="text-sm text-slate-500">No signals recorded yet</p></div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="w-full border-collapse">
                                <thead><tr>{['Time','Strategy','Symbol','Signal','Confidence','Acted On'].map(h => <th key={h} className={TH}>{h}</th>)}</tr></thead>
                                <tbody>
                                    {signals.map((sig, i) => (
                                        <tr key={i} className="border-b border-white/[0.04] hover:bg-white/[0.025] transition-colors">
                                            <td className={`${TD} text-xs`}>
                                                <div>{sig.date ?? sig.timestamp}</div>
                                                <div className="text-slate-600">{sig.time}</div>
                                            </td>
                                            <td className={`${TD} text-xs text-slate-400`}>{sig.strategy}</td>
                                            <td className={`${TD} font-semibold text-white`}>{sig.symbol}</td>
                                            <td className={TD}><Badge color={sigColor(sig.signal)}>{sig.signal}</Badge></td>
                                            <td className={TD}>
                                                <div className="flex items-center gap-2">
                                                    <div className="w-16 h-1.5 rounded-full bg-white/10 overflow-hidden">
                                                        <div className={`h-full rounded-full ${sig.confidence >= 70 ? 'bg-green-400' : sig.confidence >= 40 ? 'bg-yellow-400' : 'bg-red-400'}`} style={{ width: `${sig.confidence}%` }} />
                                                    </div>
                                                    <span className="text-xs text-slate-500 tabular-nums">{sig.confidence}%</span>
                                                </div>
                                            </td>
                                            <td className={TD}>
                                                <span className={`inline-block w-2 h-2 rounded-full ${sig.actedOn ? 'bg-green-400 shadow-[0_0_6px_#22c55e]' : 'bg-slate-700'}`} title={sig.actedOn ? 'Traded' : 'No action'} />
                                            </td>
                                        </tr>
                                    ))}
                                </tbody>
                            </table>
                        </div>
                    )}
                </div>
            </ErrorBoundary>
        </div>
    );
}
