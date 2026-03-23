'use client';

import { useState, useCallback, useEffect } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, API_BASE } from '@/lib/utils';

export default function HistoryPage() {
    const [trades, setTrades] = useState([]);
    const [loading, setLoading] = useState(true);
    const [filters, setFilters] = useState({
        startDate: '',
        endDate: '',
        strategy: '',
        symbol: '',
        side: '',
        tradeType: '',
    });

    const fetchTrades = useCallback(async () => {
        setLoading(true);
        try {
            const params = new URLSearchParams();
            Object.entries(filters).forEach(([k, v]) => { if (v) params.set(k, v); });
            const res = await fetch(`${API_BASE}/api/trades?${params}`);
            const json = await res.json();
            setTrades(json.trades || []);
        } catch { /* handled by ErrorBoundary */ }
        finally { setLoading(false); }
    }, [filters]);

    useEffect(() => { fetchTrades(); }, [fetchTrades]);

    const exportCSV = () => {
        if (!trades.length) return;
        const headers = ['Date', 'Symbol', 'Type', 'Side', 'Qty', 'Price', 'P&L', 'Capital Deployed', 'ROI %', 'Strategy', 'Status'];
        const rows = trades.map((t) => [
            t.date, t.symbol, t.tradeType ?? '', t.side, t.quantity, t.price, t.pnl,
            t.capitalDeployed ?? '', t.tradeRoi != null ? t.tradeRoi.toFixed(4) : '',
            t.strategy, t.status,
        ]);
        const csv = [headers.join(','), ...rows.map((r) => r.join(','))].join('\n');
        const blob = new Blob([csv], { type: 'text/csv' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `alpha8-trades-${new Date().toISOString().split('T')[0]}.csv`;
        a.click();
        URL.revokeObjectURL(url);
    };

    // Resolve trade type — uses API field when available (after bot restart),
    // falls back to side+pnl heuristic for old rows / pre-restart API.
    const resolveTradeType = (t) => {
        if (t.tradeType) return t.tradeType;
        if (t.side === 'BUY')  return Math.abs(t.pnl) < 0.01 ? 'LONG_ENTRY'  : 'SHORT_COVER';
        if (t.side === 'SELL') return Math.abs(t.pnl) < 0.01 ? 'SHORT_ENTRY' : 'LONG_EXIT';
        return null;
    };

    // Client-side filter by tradeType (derived field, not stored in DB)
    const visibleTrades = filters.tradeType
        ? trades.filter(t => resolveTradeType(t) === filters.tradeType)
        : trades;

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>
            <div className="flex items-center justify-between mb-8">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Trade History</h1>
                    <p className="text-sm text-[var(--text-muted)] mt-2">View and export past trades</p>
                </div>
                <button className="btn btn-primary" onClick={exportCSV} disabled={!trades.length}>
                    📥 Export CSV
                </button>
            </div>

            {/* Filters */}
            <div className="card">
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: '1rem' }}>
                    <div>
                        <label className="text-xs text-[var(--text-muted)] mb-1 block">Start Date</label>
                        <input type="date" className="input" value={filters.startDate}
                            onChange={(e) => setFilters({ ...filters, startDate: e.target.value })} />
                    </div>
                    <div>
                        <label className="text-xs text-[var(--text-muted)] mb-1 block">End Date</label>
                        <input type="date" className="input" value={filters.endDate}
                            onChange={(e) => setFilters({ ...filters, endDate: e.target.value })} />
                    </div>
                    <div>
                        <label className="text-xs text-[var(--text-muted)] mb-1 block">Strategy</label>
                        <select className="input" value={filters.strategy}
                            onChange={(e) => setFilters({ ...filters, strategy: e.target.value })}>
                            <option value="">All</option>
                            <option value="EMA_CROSSOVER">EMA Crossover</option>
                            <option value="RSI_MEAN_REVERSION">RSI Reversion</option>
                            <option value="VWAP_MOMENTUM">VWAP Momentum</option>
                            <option value="BREAKOUT_VOLUME">Breakout Volume</option>
                        </select>
                    </div>
                    <div>
                        <label className="text-xs text-[var(--text-muted)] mb-1 block">Symbol</label>
                        <input type="text" className="input" placeholder="e.g. RELIANCE"
                            value={filters.symbol}
                            onChange={(e) => setFilters({ ...filters, symbol: e.target.value.toUpperCase() })} />
                    </div>
                    <div>
                        <label className="text-xs text-[var(--text-muted)] mb-1 block">Side</label>
                        <select className="input" value={filters.side}
                            onChange={(e) => setFilters({ ...filters, side: e.target.value })}>
                            <option value="">All</option>
                            <option value="BUY">BUY</option>
                            <option value="SELL">SELL</option>
                        </select>
                    </div>
                    <div>
                        <label className="text-xs text-[var(--text-muted)] mb-1 block">Type</label>
                        <select className="input" value={filters.tradeType}
                            onChange={(e) => setFilters({ ...filters, tradeType: e.target.value })}>
                            <option value="">All</option>
                            <option value="LONG_ENTRY">Long Entry</option>
                            <option value="LONG_EXIT">Long Exit</option>
                            <option value="SHORT_ENTRY">Short Entry</option>
                            <option value="SHORT_COVER">Short Cover</option>
                        </select>
                    </div>
                </div>
            </div>

            {/* Results */}
            <ErrorBoundary>
                <div className="card overflow-hidden">
                    {loading ? (
                        <div className="space-y-2">{[1, 2, 3, 4, 5].map((i) => <div key={i} className="skeleton h-10 w-full rounded-lg" />)}</div>
                    ) : trades.length === 0 ? (
                        <div className="text-center py-12 text-[var(--text-muted)]">
                            <p className="text-3xl mb-2">📭</p>
                            <p>No trades found matching filters</p>
                        </div>
                    ) : (
                        <div className="overflow-x-auto">
                            <table className="data-table">
                                <thead>
                                    <tr>
                                        <th>Date</th>
                                        <th>Symbol</th>
                                        <th>Type</th>
                                        <th>Qty</th>
                                        <th>Price</th>
                                        <th>P&L</th>
                                        <th>Deployed</th>
                                        <th>ROI</th>
                                        <th>Strategy</th>
                                        <th>Status</th>
                                    </tr>
                                </thead>
                                <tbody>
                                    {visibleTrades.map((trade, i) => {
                                        const typeConfig = {
                                            LONG_ENTRY:  { label: 'L ENTRY',  cls: 'badge-green'  },
                                            LONG_EXIT:   { label: 'L EXIT',   cls: 'badge-yellow' },
                                            SHORT_ENTRY: { label: 'S ENTRY',  cls: 'badge-red'    },
                                            SHORT_COVER: { label: 'S COVER',  cls: 'badge-blue'   },
                                        };
                                        const tc = typeConfig[resolveTradeType(trade)] ?? { label: trade.side, cls: trade.side === 'BUY' ? 'badge-green' : 'badge-red' };
                                        return (
                                            <tr key={i}>
                                                <td className="whitespace-nowrap">{trade.date}</td>
                                                <td className="font-medium text-[var(--text-primary)]">{trade.symbol}</td>
                                                <td><span className={`badge ${tc.cls}`}>{tc.label}</span></td>
                                                <td>{trade.quantity}</td>
                                                <td>{formatINR(trade.price)}</td>
                                                <td className={`font-medium ${pnlColor(trade.pnl)}`}>{formatINR(trade.pnl)}</td>
                                                <td className="text-xs text-[var(--text-muted)]">
                                                    {trade.capitalDeployed != null ? formatINR(trade.capitalDeployed) : '—'}
                                                </td>
                                                <td className={`text-xs font-medium ${trade.tradeRoi == null ? '' : trade.tradeRoi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                                                    {trade.tradeRoi != null ? `${trade.tradeRoi >= 0 ? '+' : ''}${trade.tradeRoi.toFixed(2)}%` : '—'}
                                                </td>
                                                <td className="text-xs">{trade.strategy}</td>
                                                <td>
                                                    <span className={`badge ${trade.status === 'FILLED' ? 'badge-green' :
                                                        trade.status === 'REJECTED' ? 'badge-red' : 'badge-yellow'
                                                        }`}>{trade.status}</span>
                                                </td>
                                            </tr>
                                        );
                                    })}
                                </tbody>
                            </table>
                        </div>
                    )}
                    <div className="text-xs text-[var(--text-muted)] mt-3 px-1">
                        {trades.length} trades found
                    </div>
                </div>
            </ErrorBoundary>
        </div>
    );
}
