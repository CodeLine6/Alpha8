'use client';

import { useState, useEffect, useCallback } from 'react';
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

function StrategyCard({ strategy: s }) {
    return (
        <div className={`${CARD} p-6`}>
            <div className="flex items-center justify-between mb-5">
                <h3 className="font-semibold text-white">{s.name}</h3>
                <Badge color={s.winRate >= 50 ? 'green' : 'red'}>{s.winRate?.toFixed(1)}% WR</Badge>
            </div>
            <div className="grid grid-cols-2 gap-4">
                <StatRow label="Avg Return"   value={formatPct(s.avgReturn)}           valueClass={s.avgReturn >= 0 ? 'text-green-400' : 'text-red-400'} />
                <StatRow label="Total P&L"    value={formatINR(s.totalPnl)}            valueClass={s.totalPnl >= 0 ? 'text-green-400' : 'text-red-400'} />
                <StatRow label="Sharpe Ratio" value={s.sharpe?.toFixed(2) ?? 'N/A'}    valueClass={s.sharpe >= 1 ? 'text-green-400' : 'text-yellow-400'} />
                <StatRow label="Max Drawdown" value={`${s.maxDrawdown?.toFixed(2) ?? '0.00'}%`} valueClass="text-red-400" />
            </div>
            <p className="mt-5 text-xs text-slate-600">{s.tradeCount ?? 0} trades · W: {s.wins ?? 0} / L: {s.losses ?? 0}</p>
        </div>
    );
}

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

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-white">Strategy Performance</h1>
                <p className="text-sm text-slate-500 mt-1">Per-strategy metrics and signal log</p>
            </div>

            <ErrorBoundary>
                {loading ? (
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {[1,2,3].map(i => <div key={i} className="h-44 rounded-2xl bg-[#141922] border border-white/[0.07] animate-pulse" />)}
                    </div>
                ) : strategies.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 text-sm">No strategy data available</div>
                ) : (
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {strategies.map(s => <StrategyCard key={s.name} strategy={s} />)}
                    </div>
                )}
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
