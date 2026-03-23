'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, formatPct, API_BASE } from '@/lib/utils';

export default function StrategiesPage() {
    const [strategies, setStrategies] = useState([]);
    const [signals, setSignals] = useState([]);
    const [loading, setLoading] = useState(true);

    const fetchData = useCallback(async () => {
        try {
            const [stratRes, sigRes] = await Promise.all([
                fetch(`${API_BASE}/api/strategies/performance`),
                fetch(`${API_BASE}/api/strategies/signals?limit=50`),
            ]);
            const stratJson = await stratRes.json();
            const sigJson = await sigRes.json();
            setStrategies(stratJson.strategies || []);
            setSignals(sigJson.signals || []);
        } catch { /* ErrorBoundary */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchData(); }, [fetchData]);

    return (
        <div>
            <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight">Strategy Performance</h1>
                <p className="text-sm text-[var(--text-muted)] mt-2">Per-strategy metrics and signal log</p>
            </div>

            {/* Strategy Cards */}
            <ErrorBoundary>
                {loading ? (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
                        {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-44 rounded-xl" />)}
                    </div>
                ) : (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1.5rem', marginBottom: '2rem' }}>
                        {strategies.map((strat) => (
                            <StrategyCard key={strat.name} strategy={strat} />
                        ))}
                    </div>
                )}
            </ErrorBoundary>

            {/* Signal Log */}
            <ErrorBoundary>
                <div className="card overflow-hidden">
                    <div className="flex items-center justify-between mb-4 px-1">
                        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">
                            Last 50 Signals
                        </div>
                    </div>
                    {loading ? (
                        <div className="space-y-2">{[1, 2, 3].map((i) => <div key={i} className="skeleton h-10 w-full rounded-lg" />)}</div>
                    ) : signals.length === 0 ? (
                        <div className="text-center py-8 text-[var(--text-muted)]">
                            <p className="text-3xl mb-2">📡</p>
                            <p className="text-sm">No signals recorded yet</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Time</th>
                                        <th>Strategy</th>
                                        <th>Symbol</th>
                                        <th>Signal</th>
                                        <th>Confidence</th>
                                        <th>Acted On</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {signals.map((sig, i) => (
                                        <tr key={i}>
                                            <td className="whitespace-nowrap text-xs">
                                                <div>{sig.date ?? sig.timestamp}</div>
                                                <div className="text-[var(--text-muted)]">{sig.time}</div>
                                            </td>
                                            <td className="text-xs">{sig.strategy}</td>
                                            <td className="font-medium text-[var(--text-primary)]">{sig.symbol}</td>
                                            <td>
                                                <span className={`badge ${sig.signal === 'BUY' ? 'badge-green' :
                                                    sig.signal === 'SELL' ? 'badge-red' : 'badge-yellow'
                                                    }`}>{sig.signal}</span>
                                            </td>
                                            <td>
                                                <div className="flex items-center gap-2">
                                                    <div className="flex-1 h-1.5 bg-[var(--bg-secondary)] rounded-full overflow-hidden" style={{ maxWidth: '80px' }}>
                                                        <div
                                                            className={`h-full rounded-full ${sig.confidence >= 70 ? 'bg-green-400' :
                                                                sig.confidence >= 40 ? 'bg-yellow-400' : 'bg-red-400'
                                                                }`}
                                                            style={{ width: `${sig.confidence}%` }}
                                                        />
                                                    </div>
                                                    <span className="text-xs text-[var(--text-muted)]">{sig.confidence}%</span>
                                                </div>
                                            </td>
                                            <td>
                                                {sig.actedOn ? (
                                                    <span className="dot dot-green" title="Traded" />
                                                ) : (
                                                    <span className="dot" style={{ background: 'var(--text-muted)' }} title="No action" />
                                                )}
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

function StrategyCard({ strategy }) {
    const s = strategy;
    return (
        <div className="card">
            <div className="flex items-center justify-between mb-4">
                <h3 className="font-semibold text-base">{s.name}</h3>
                <span className={`badge ${s.winRate >= 50 ? 'badge-green' : 'badge-red'}`}>
                    {s.winRate?.toFixed(1)}% WR
                </span>
            </div>

            <div className="grid grid-cols-2 gap-4">
                <div>
                    <div className="text-xs text-[var(--text-muted)]">Avg Return</div>
                    <div className={`text-sm font-semibold ${pnlColor(s.avgReturn)}`}>
                        {formatPct(s.avgReturn)}
                    </div>
                </div>
                <div>
                    <div className="text-xs text-[var(--text-muted)]">Total P&L</div>
                    <div className={`text-sm font-semibold ${pnlColor(s.totalPnl)}`}>
                        {formatINR(s.totalPnl)}
                    </div>
                </div>
                <div>
                    <div className="text-xs text-[var(--text-muted)]">Sharpe Ratio</div>
                    <div className={`text-sm font-semibold ${s.sharpe >= 1 ? 'text-green-400' : 'text-yellow-400'}`}>
                        {s.sharpe?.toFixed(2) ?? 'N/A'}
                    </div>
                </div>
                <div>
                    <div className="text-xs text-[var(--text-muted)]">Max Drawdown</div>
                    <div className="text-sm font-semibold text-red-400">
                        {s.maxDrawdown?.toFixed(2) ?? '0.00'}%
                    </div>
                </div>
            </div>

            <div className="mt-4 text-xs text-[var(--text-muted)]">
                {s.tradeCount ?? 0} trades · W: {s.wins ?? 0} / L: {s.losses ?? 0}
            </div>
        </div>
    );
}
