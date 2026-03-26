'use client';

import { useState, useEffect, useCallback } from 'react';
import Link from 'next/link';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, formatPct, API_BASE } from '@/lib/utils';

const CARD = 'rounded-2xl border border-slate-700/50 bg-slate-900';

function Badge({ color, children }) {
    const cls = { 
        green: 'bg-green-500/10 text-green-400 border-green-500/20', 
        red: 'bg-red-500/10 text-red-400 border-red-500/20', 
        yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', 
        blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20' 
    }[color] ?? 'bg-white/5 text-slate-400 border-white/10';
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
                <h3 className="font-semibold text-white truncate max-w-[200px]" title={s.name}>{s.name}</h3>
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

export default function PerformancePage() {
    const [strategies, setStrategies] = useState([]);
    const [loading,    setLoading]    = useState(true);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/strategies/performance`);
            const data = await res.json();
            setStrategies(data.strategies || []);
        } catch { /**/ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    return (
        <div className="space-y-6">
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Detailed Strategy Performance</h1>
                    <p className="text-sm text-slate-500 mt-1">Deep-dive metrics for each deployed strategy</p>
                </div>
                <Link href="/strategies" className="text-xs font-semibold text-slate-400 hover:text-white transition-colors bg-slate-800/50 border border-slate-700/50 px-4 py-2 rounded-xl">
                    ← Back to Signal Log
                </Link>
            </div>

            <ErrorBoundary>
                {loading ? (
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {[1,2,3,4,5,6].map(i => <div key={i} className="h-44 rounded-2xl bg-[#141922] border border-white/[0.07] animate-pulse" />)}
                    </div>
                ) : strategies.length === 0 ? (
                    <div className="py-12 text-center text-slate-500 text-sm">No strategy data available</div>
                ) : (
                    <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3">
                        {strategies.map(s => <StrategyCard key={s.name} strategy={s} />)}
                    </div>
                )}
            </ErrorBoundary>
        </div>
    );
}
