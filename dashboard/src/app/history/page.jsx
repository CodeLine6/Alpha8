'use client';

import { useState, useCallback, useEffect } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, API_BASE } from '@/lib/utils';
import TradingChart from '@/components/TradingChart';

export default function HistoryPage() {
    const [trades, setTrades] = useState([]);
    const [loading, setLoading] = useState(true);
    const [activeTab, setActiveTab] = useState('ALL');
    const [chartSymbol, setChartSymbol] = useState(null);
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

    // Trade type arrives directly from the backend /api/trades
    const resolveTradeType = (t) => t.tradeType || null;

    // Client-side filter by tradeType and activeTab
    const visibleTrades = trades.filter(t => {
        const type = resolveTradeType(t);
        if (filters.tradeType && type !== filters.tradeType) return false;
        if (activeTab === 'LONG' && type !== 'LONG_ENTRY' && type !== 'LONG_EXIT') return false;
        if (activeTab === 'SHORT' && type !== 'SHORT_ENTRY' && type !== 'SHORT_COVER') return false;
        return true;
    });

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

            {/* Tabs */}
            <div style={{ display: 'flex', gap: '2rem', borderBottom: '1px solid var(--border-color)', marginBottom: '1.5rem', padding: '0 0.5rem' }}>
                <button 
                    style={{ 
                        paddingBottom: '0.75rem', 
                        fontSize: '0.9rem', 
                        fontWeight: '500', 
                        borderBottom: `2px solid ${activeTab === 'ALL' ? '#3b82f6' : 'transparent'}`,
                        color: activeTab === 'ALL' ? '#3b82f6' : 'var(--text-muted)',
                        cursor: 'pointer',
                        background: 'transparent',
                        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                        transition: 'all 0.2s'
                    }}
                    onClick={() => setActiveTab('ALL')}
                >
                    All Orders
                </button>
                <button 
                    style={{ 
                        paddingBottom: '0.75rem', 
                        fontSize: '0.9rem', 
                        fontWeight: '500', 
                        borderBottom: `2px solid ${activeTab === 'LONG' ? '#3b82f6' : 'transparent'}`,
                        color: activeTab === 'LONG' ? '#3b82f6' : 'var(--text-muted)',
                        cursor: 'pointer',
                        background: 'transparent',
                        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                        transition: 'all 0.2s'
                    }}
                    onClick={() => setActiveTab('LONG')}
                >
                    Long Orders
                </button>
                <button 
                    style={{ 
                        paddingBottom: '0.75rem', 
                        fontSize: '0.9rem', 
                        fontWeight: '500', 
                        borderBottom: `2px solid ${activeTab === 'SHORT' ? '#3b82f6' : 'transparent'}`,
                        color: activeTab === 'SHORT' ? '#3b82f6' : 'var(--text-muted)',
                        cursor: 'pointer',
                        background: 'transparent',
                        borderTop: 'none', borderLeft: 'none', borderRight: 'none',
                        transition: 'all 0.2s'
                    }}
                    onClick={() => setActiveTab('SHORT')}
                >
                    Short Orders
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
                            <option value="ORB">ORB Breakout</option>
                            <option value="BAVI">BAVI Order Flow</option>
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

            {/* ── Chart modal ───────────────────────────── */}
            {chartSymbol && (
                <div
                    onClick={() => setChartSymbol(null)}
                    style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(0,0,0,0.85)', display: 'flex', alignItems: 'center', justifyContent: 'center', backdropFilter: 'blur(4px)' }}
                >
                    <div className="card" onClick={(e) => e.stopPropagation()}
                        style={{ width: '90vw', maxWidth: '1000px', padding: '1.5rem', boxShadow: '0 8px 40px rgba(0,0,0,0.8)', border: '1px solid #374151', background: '#111827' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '1rem' }}>
                            <div style={{ fontSize: '1.25rem', fontWeight: 700, color: 'white' }}>📈 {chartSymbol.symbol} Interactive Chart</div>
                            <button onClick={() => setChartSymbol(null)} style={{ color: '#9ca3af', background: 'transparent', border: 'none', cursor: 'pointer', fontSize: '1.5rem', lineHeight: 1 }}>&times;</button>
                        </div>
                        <TradingChart symbol={chartSymbol.symbol} trades={chartSymbol.trades} />
                    </div>
                </div>
            )}

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
                                        <th>Chart</th>
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
                                                <td>
                                                    <button
                                                        onClick={() => setChartSymbol({ symbol: trade.symbol, trades: [trade] })}
                                                        title="View Chart"
                                                        style={{ background: 'rgba(59, 130, 246, 0.1)', color: '#60a5fa', border: '1px solid rgba(59, 130, 246, 0.3)', borderRadius: '4px', padding: '2px 8px', fontSize: '0.9rem', cursor: 'pointer' }}
                                                    >
                                                        📈
                                                    </button>
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
