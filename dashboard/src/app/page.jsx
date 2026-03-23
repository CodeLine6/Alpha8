'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, pnlColor, formatPct, API_BASE } from '@/lib/utils';

// ─── Data fetching hook ──────────────────────────────────
function usePolling(url, intervalMs = 5000) {
    const [data, setData] = useState(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState(null);

    const fetchData = useCallback(async () => {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`${res.status}`);
            const json = await res.json();
            setData(json);
            setError(null);
        } catch (err) {
            setError(err.message);
        } finally {
            setLoading(false);
        }
    }, [url]);

    useEffect(() => {
        fetchData();
        const id = setInterval(fetchData, intervalMs);
        return () => clearInterval(id);
    }, [fetchData, intervalMs]);

    return { data, loading, error, refetch: fetchData };
}

// ─── Skeleton helpers ────────────────────────────────────
function SkeletonCard() {
    return <div className="skeleton h-28 w-full rounded-xl" />;
}
function SkeletonRow() {
    return <div className="skeleton h-10 w-full rounded-lg mb-2" />;
}

// ═══════════════════════════════════════════════════════════
// MAIN DASHBOARD PAGE
// ═══════════════════════════════════════════════════════════

export default function DashboardPage() {
    const summary = usePolling(`${API_BASE}/api/summary`, 5000);
    const positions = usePolling(`${API_BASE}/api/positions`, 5000);
    const health = usePolling(`${API_BASE}/api/health`, 10000);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2.5rem' }}>
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Dashboard</h1>
                    <p className="text-sm text-[var(--text-muted)] mt-2">
                        Real-time trading overview
                    </p>
                </div>
                <div className="flex items-center gap-4">
                    {summary.data?.paperMode !== undefined && (
                        <span className={`badge ${summary.data.paperMode ? 'badge-yellow' : 'badge-green'}`}>
                            {summary.data.paperMode ? '📝 Paper' : '🔴 LIVE'}
                        </span>
                    )}
                    <span className="text-xs text-[var(--text-muted)]">
                        {new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' })}
                    </span>
                </div>
            </div>

            {/* Stats Cards */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: '1.5rem' }}>
                <ErrorBoundary>
                    <PnLCard data={summary.data} loading={summary.loading} />
                </ErrorBoundary>
                <ErrorBoundary>
                    <TradesCard data={summary.data} loading={summary.loading} />
                </ErrorBoundary>
                <ErrorBoundary>
                    <WinRateCard data={summary.data} loading={summary.loading} />
                </ErrorBoundary>
                <ErrorBoundary>
                    <DrawdownCard data={summary.data} loading={summary.loading} />
                </ErrorBoundary>
                <ErrorBoundary>
                    <DailyRoiCard data={summary.data} loading={summary.loading} />
                </ErrorBoundary>
            </div>

            {/* Health + Kill Switch Row */}
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1.5rem' }}>
                <ErrorBoundary>
                    <HealthWidget data={health.data} loading={health.loading} />
                </ErrorBoundary>
                <ErrorBoundary>
                    <KillSwitchWidget data={summary.data} loading={summary.loading} />
                </ErrorBoundary>
            </div>

            {/* Positions Table */}
            <ErrorBoundary>
                <PositionsTable data={positions.data} loading={positions.loading} />
            </ErrorBoundary>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════
// STAT CARDS
// ═══════════════════════════════════════════════════════════

function PnLCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const pnl = data?.pnl ?? 0;
    return (
        <div className={`card ${pnl >= 0 ? 'pulse-green' : 'pulse-red'}`}>
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Daily P&L
            </div>
            <div className={`text-3xl font-bold ${pnlColor(pnl)}`}>
                {formatINR(pnl)}
            </div>
            <div className={`text-xs mt-2 ${pnlColor(pnl)}`}>
                {formatPct(data?.pnlPct)}
            </div>
        </div>
    );
}

function TradesCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    return (
        <div className="card">
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Trades Today
            </div>
            <div className="text-3xl font-bold">{data?.tradeCount ?? 0}</div>
            <div className="text-xs text-[var(--text-muted)] mt-2">
                {data?.filled ?? 0} filled · {data?.rejected ?? 0} rejected
            </div>
        </div>
    );
}

function WinRateCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const winRate = data?.tradeCount ? ((data.winCount || 0) / data.tradeCount * 100) : 0;
    return (
        <div className="card">
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Win Rate
            </div>
            <div className={`text-3xl font-bold ${winRate >= 50 ? 'text-green-400' : 'text-red-400'}`}>
                {winRate.toFixed(1)}%
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-2">
                {data?.winCount ?? 0}W / {data?.lossCount ?? 0}L
            </div>
        </div>
    );
}

function DrawdownCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const dd = data?.drawdownPct ?? 0;
    return (
        <div className="card">
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Max Drawdown
            </div>
            <div className={`text-3xl font-bold ${dd > 3 ? 'text-red-400' : dd > 1 ? 'text-yellow-400' : 'text-green-400'}`}>
                {dd.toFixed(2)}%
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-2">
                Capital: {formatINR(data?.capital)}
            </div>
        </div>
    );
}

function DailyRoiCard({ data, loading }) {
    if (loading) return <SkeletonCard />;
    const roi = data?.dailyRoi ?? 0;
    const deployed = data?.totalCashRequired ?? 0;
    // walletDeployed = fresh wallet cash still locked in open positions (always ≤ capital)
    // currentDeployment can exceed capital via recycled profits — not shown directly
    const walletDeployed = data?.walletDeployed ?? data?.currentDeployment ?? 0;
    return (
        <div className={`card ${roi >= 0 ? 'pulse-green' : 'pulse-red'}`}>
            <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider mb-2">
                Daily ROI
            </div>
            <div className={`text-3xl font-bold ${roi >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                {roi >= 0 ? '+' : ''}{roi.toFixed(2)}%
            </div>
            <div className="text-xs text-[var(--text-muted)] mt-2">
                on {formatINR(deployed)} fresh capital used
            </div>
            {walletDeployed > 0 && (
                <div className="text-xs mt-1 text-yellow-400">
                    {formatINR(walletDeployed)} wallet currently deployed
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════
// HEALTH STATUS WIDGET — mirrors 5 Telegram alert types
// ═══════════════════════════════════════════════════════════

function HealthWidget({ data, loading }) {
    if (loading) {
        return (
            <div className="card">
                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">
                    System Health
                </div>
                <div className="space-y-2">
                    <SkeletonRow /><SkeletonRow /><SkeletonRow />
                </div>
            </div>
        );
    }

    const services = [
        { name: 'Broker API', key: 'broker', icon: '🔗' },
        { name: 'Broker Token', key: 'brokerTokenValid', icon: '🔑' },
        { name: 'Redis', key: 'redis', icon: '🗄️' },
        { name: 'Database', key: 'db', icon: '💾' },
        { name: 'Data Feed', key: 'dataFeed', icon: '📡' },
        { name: 'Telegram', key: 'telegram', icon: '📱' },
    ];

    const allHealthy = services.every((s) => data?.[s.key] !== false);

    return (
        <div className={`card ${allHealthy ? '' : 'border-red-500/50'}`}>
            <div className="flex items-center justify-between mb-4">
                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wider">
                    System Health
                </div>
                <span className={`badge ${allHealthy ? 'badge-green' : 'badge-red'}`}>
                    {allHealthy ? '✅ All Systems Go' : '⚠️ Degraded'}
                </span>
            </div>
            <div className="space-y-1">
                {services.map((service) => {
                    const status = data?.[service.key];
                    const isUp = status !== false;
                    const dotClass = status === null ? 'dot-yellow' : status !== false ? 'dot-green' : 'dot-red';
                    const statusText = status === null ? 'Not checked' : status !== false ? 'Valid' : 'EXPIRED';

                    return (
                        <div key={service.key} className="flex items-center justify-between py-2.5 px-3 rounded-lg hover:bg-[var(--bg-card-hover)] transition-colors">
                            <div className="flex items-center gap-2">
                                <span>{service.icon}</span>
                                <span className="text-sm">{service.name}</span>
                            </div>
                            <div className="flex items-center gap-2">
                                <span className={`dot ${dotClass}`} />
                                <span className={`text-xs font-medium ${status === null ? 'text-yellow-400' : status !== false ? 'text-green-400' : 'text-red-400'}`}>
                                    {service.key === 'brokerTokenValid' ? statusText : (isUp ? 'Connected' : 'DOWN')}
                                </span>
                            </div>
                        </div>
                    );
                })}
            </div>
            {data?.lastCheck && (
                <div className="text-xs text-[var(--text-muted)] mt-3">
                    Last check: {new Date(data.lastCheck).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' })}
                </div>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════
// KILL SWITCH WIDGET
// ═══════════════════════════════════════════════════════════

function KillSwitchWidget({ data, loading }) {
    if (loading) return <SkeletonCard />;

    const engaged = data?.killSwitchEngaged;

    return (
        <div className={`card ${engaged ? 'border-red-500/50 pulse-red' : ''}`}>
            <div className="flex items-center justify-between mb-3">
                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">
                    Kill Switch
                </div>
                <span className={`badge ${engaged ? 'badge-red' : 'badge-green'}`}>
                    {engaged ? '🛑 ENGAGED' : '✅ Normal'}
                </span>
            </div>
            {engaged ? (
                <div>
                    <p className="text-red-400 text-sm mb-2">
                        All new orders are <strong>BLOCKED</strong>
                    </p>
                    {data?.killSwitchReason && (
                        <p className="text-xs text-[var(--text-muted)]">
                            Reason: {data.killSwitchReason}
                        </p>
                    )}
                </div>
            ) : (
                <p className="text-sm text-[var(--text-secondary)]">
                    Trading is active. Kill switch can be engaged from{' '}
                    <a href="/settings" className="text-blue-400 hover:underline">Settings</a>.
                </p>
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════
// POSITIONS TABLE  (with manual exit)
// ═══════════════════════════════════════════════════════════

function PositionsTable({ data, loading }) {
    const [confirm, setConfirm] = useState(null);   // { symbol, entryPrice, qty, side }
    const [exiting, setExiting] = useState(null);   // symbol currently being exited
    const [exitMsg, setExitMsg] = useState(null);   // { ok, text }

    const handleExitClick = (pos) => {
        setExitMsg(null);
        setConfirm({ symbol: pos.symbol, entryPrice: pos.entryPrice, qty: pos.quantity, side: pos.side });
    };

    const handleExitConfirm = async () => {
        if (!confirm) return;
        const sym = confirm.symbol;
        setExiting(sym);
        setConfirm(null);
        try {
            const apiKey = process.env.NEXT_PUBLIC_API_KEY || '';
            const res = await fetch(`${API_BASE}/api/positions/exit`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    ...(apiKey ? { 'X-Api-Key': apiKey } : {}),
                },
                body: JSON.stringify({ symbol: sym }),
            });
            const result = await res.json();
            if (!res.ok) throw new Error(result.error || 'Exit failed');
            const pnlSign = (result.pnl ?? 0) >= 0 ? '+' : '';
            setExitMsg({ ok: true, text: `✅ ${sym} exited @ ₹${result.exitPrice?.toFixed(2)} · P&L ${pnlSign}₹${(result.pnl ?? 0).toFixed(2)}` });
        } catch (err) {
            setExitMsg({ ok: false, text: `❌ ${err.message}` });
        } finally {
            setExiting(null);
        }
    };

    if (loading) {
        return (
            <div className="card">
                <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">Open Positions</div>
                {[1, 2, 3].map((i) => <SkeletonRow key={i} />)}
            </div>
        );
    }

    const positions = data?.positions || [];

    return (
        <>
            {/* ── Confirmation modal ───────────────────────────── */}
            {confirm && (
                <div
                    onClick={() => setConfirm(null)}
                    style={{ position: 'fixed', inset: 0, zIndex: 50, background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                >
                    <div className="card" onClick={(e) => e.stopPropagation()}
                        style={{ width: '22rem', padding: '1.75rem', boxShadow: '0 8px 40px rgba(0,0,0,0.5)' }}>
                        <div style={{ fontSize: '1.1rem', fontWeight: 700, marginBottom: '0.75rem' }}>🔴 Exit position?</div>
                        <div style={{ fontSize: '0.875rem', color: 'var(--text-secondary)', marginBottom: '1.25rem', lineHeight: 1.6 }}>
                            <strong>{confirm.symbol}</strong>&nbsp;
                            <span className={`badge ${confirm.side === 'BUY' ? 'badge-green' : 'badge-red'}`}>{confirm.side}</span><br />
                            Qty: {confirm.qty} · Entry: ₹{confirm.entryPrice?.toFixed(2)}<br />
                            <span style={{ color: 'var(--text-muted)', fontSize: '0.78rem' }}>Will exit at current market price via broker.</span>
                        </div>
                        <div style={{ display: 'flex', gap: '0.75rem' }}>
                            <button id={`exit-confirm-${confirm.symbol}`} className="btn btn-danger" style={{ flex: 1 }} onClick={handleExitConfirm}>Exit Now</button>
                            <button className="btn btn-secondary" style={{ flex: 1 }} onClick={() => setConfirm(null)}>Cancel</button>
                        </div>
                    </div>
                </div>
            )}

            <div className="card overflow-hidden">
                <div className="flex items-center justify-between mb-3 px-1">
                    <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide">Open Positions</div>
                    <span className="badge badge-blue">{positions.length} active</span>
                </div>

                {exitMsg && (
                    <div style={{
                        margin: '0 0 1rem', padding: '0.6rem 1rem', borderRadius: '0.5rem', fontSize: '0.82rem',
                        background: exitMsg.ok ? 'rgba(34,197,94,0.1)' : 'rgba(239,68,68,0.1)',
                        color: exitMsg.ok ? '#4ade80' : '#f87171',
                        border: `1px solid ${exitMsg.ok ? 'rgba(34,197,94,0.3)' : 'rgba(239,68,68,0.3)'}`,
                    }}>{exitMsg.text}</div>
                )}

                {positions.length === 0 ? (
                    <div className="text-center py-8 text-[var(--text-muted)]">
                        <p className="text-3xl mb-2">📭</p>
                        <p className="text-sm">No open positions</p>
                    </div>
                ) : (
                    <div className="overflow-x-auto">
                        <table className="data-table">
                            <thead>
                                <tr>
                                    <th>Symbol</th><th>Side</th><th>Qty</th><th>Avg Price</th>
                                    <th>Entry Price</th><th>Current</th><th>P&L</th><th>Stop Loss</th><th></th>
                                </tr>
                            </thead>
                            <tbody>
                                {positions.map((pos, i) => {
                                    const unrealized = pos.unrealisedPnL ?? 0;
                                    const isExiting = exiting === pos.symbol;
                                    return (
                                        <tr key={i}>
                                            <td className="font-medium text-[var(--text-primary)]">{pos.symbol}</td>
                                            <td><span className={`badge ${pos.side === 'BUY' ? 'badge-green' : 'badge-red'}`}>{pos.side}</span></td>
                                            <td>{pos.quantity}</td>
                                            <td>{formatINR(pos.avgPrice)}</td>
                                            <td>{formatINR(pos.entryPrice)}</td>
                                            <td>{formatINR(pos.currentPrice)}</td>
                                            <td className={`font-medium ${pnlColor(unrealized)}`}>{formatINR(unrealized)}</td>
                                            <td className="text-yellow-400">{pos.stopLoss ? formatINR(pos.stopLoss) : '—'}</td>
                                            <td>
                                                <button
                                                    id={`exit-btn-${pos.symbol}`}
                                                    onClick={() => handleExitClick(pos)}
                                                    disabled={isExiting}
                                                    style={{
                                                        padding: '0.3rem 0.75rem', fontSize: '0.75rem', fontWeight: 600,
                                                        borderRadius: '0.375rem', border: '1px solid rgba(239,68,68,0.5)',
                                                        background: isExiting ? 'rgba(239,68,68,0.05)' : 'rgba(239,68,68,0.1)',
                                                        color: '#f87171', cursor: isExiting ? 'not-allowed' : 'pointer', transition: 'background 0.15s', whiteSpace: 'nowrap',
                                                    }}
                                                    onMouseEnter={(e) => { if (!isExiting) e.currentTarget.style.background = 'rgba(239,68,68,0.25)'; }}
                                                    onMouseLeave={(e) => { if (!isExiting) e.currentTarget.style.background = 'rgba(239,68,68,0.1)'; }}
                                                >
                                                    {isExiting ? '⏳ Exiting…' : '🔴 Exit'}
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
