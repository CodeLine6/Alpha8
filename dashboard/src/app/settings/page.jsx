'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, API_BASE } from '@/lib/utils';

export default function SettingsPage() {
    const [settings, setSettings] = useState(null);
    const [loading, setLoading] = useState(true);
    const [showModal, setShowModal] = useState(false);
    const [confirmText, setConfirmText] = useState('');
    const [watchlistInput, setWatchlistInput] = useState('');

    const fetchSettings = useCallback(async () => {
        try {
            const res = await fetch(`${API_BASE}/api/settings`);
            const json = await res.json();
            setSettings(json);
        } catch { /* ErrorBoundary */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchSettings(); }, [fetchSettings]);

    // Paper/Live Toggle
    const toggleMode = async () => {
        if (settings?.paperMode === false) {
            // Going to paper — no confirmation needed
            await fetch(`${API_BASE}/api/settings/mode`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ paperMode: true }),
            });
            fetchSettings();
        } else {
            // Going to live — require confirmation
            setShowModal(true);
        }
    };

    const confirmLive = async () => {
        if (confirmText !== 'CONFIRM LIVE') return;
        await fetch(`${API_BASE}/api/settings/mode`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ paperMode: false }),
        });
        setShowModal(false);
        setConfirmText('');
        fetchSettings();
    };

    // Kill Switch
    const engageKillSwitch = async () => {
        if (!confirm('⚠️ Engage Kill Switch? This will BLOCK all new orders.')) return;
        await fetch(`${API_BASE}/api/killswitch`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'engage', reason: 'Manual dashboard trigger' }),
        });
        fetchSettings();
    };

    // Watchlist
    const addSymbol = async () => {
        if (!watchlistInput.trim()) return;
        await fetch(`${API_BASE}/api/settings/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'add', symbol: watchlistInput.trim().toUpperCase() }),
        });
        setWatchlistInput('');
        fetchSettings();
    };

    const removeSymbol = async (symbol) => {
        await fetch(`${API_BASE}/api/settings/watchlist`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'remove', symbol }),
        });
        fetchSettings();
    };

    if (loading) {
        return (
            <div>
                <h1 className="text-3xl font-bold tracking-tight mb-8">Settings</h1>
                <div className="space-y-4">
                    {[1, 2, 3, 4].map((i) => <div key={i} className="skeleton h-32 rounded-xl" />)}
                </div>
            </div>
        );
    }

    return (
        <div>
            <div className="mb-8">
                <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
                <p className="text-sm text-[var(--text-muted)] mt-2">Configuration and control panel</p>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(380px, 1fr))', gap: '1.5rem' }}>
                {/* Paper/Live Mode */}
                <ErrorBoundary>
                    <div className="card">
                        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">
                            Trading Mode
                        </div>
                        <div className="flex items-center justify-between">
                            <div>
                                <div className="flex items-center gap-2 mb-1">
                                    <span className={`badge ${settings?.paperMode ? 'badge-yellow' : 'badge-green'}`}>
                                        {settings?.paperMode ? '📝 Paper Trading' : '🔴 LIVE Trading'}
                                    </span>
                                </div>
                                <p className="text-xs text-[var(--text-muted)]">
                                    {settings?.paperMode
                                        ? 'Simulated orders — no real money at risk'
                                        : '⚠️ Real orders are being placed with your broker'}
                                </p>
                            </div>
                            <button
                                className={`btn ${settings?.paperMode ? 'btn-danger' : 'btn-success'}`}
                                onClick={toggleMode}
                            >
                                Switch to {settings?.paperMode ? 'LIVE' : 'Paper'}
                            </button>
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Kill Switch */}
                <ErrorBoundary>
                    <div className={`card ${settings?.killSwitchEngaged ? 'border-red-500/50' : ''}`}>
                        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">
                            Kill Switch
                        </div>
                        <div className="flex items-center justify-between">
                            <div>
                                <span className={`badge ${settings?.killSwitchEngaged ? 'badge-red' : 'badge-green'} mb-1`}>
                                    {settings?.killSwitchEngaged ? '🛑 ENGAGED' : '✅ Normal'}
                                </span>
                                <p className="text-xs text-[var(--text-muted)]">
                                    {settings?.killSwitchEngaged
                                        ? 'All orders are blocked. Requires manual reset.'
                                        : 'Trading is active'}
                                </p>
                            </div>
                            {!settings?.killSwitchEngaged && (
                                <button className="btn btn-danger" onClick={engageKillSwitch}>
                                    🛑 Engage
                                </button>
                            )}
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Watchlist */}
                <ErrorBoundary>
                    <div className="card">
                        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">
                            Watchlist
                        </div>
                        <div className="flex gap-2 mb-3">
                            <input
                                type="text"
                                className="input"
                                placeholder="Add symbol e.g. RELIANCE"
                                value={watchlistInput}
                                onChange={(e) => setWatchlistInput(e.target.value.toUpperCase())}
                                onKeyDown={(e) => e.key === 'Enter' && addSymbol()}
                            />
                            <button className="btn btn-primary" onClick={addSymbol}>Add</button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(settings?.watchlist || []).map((sym) => (
                                <span key={sym} className="badge badge-blue flex items-center gap-1 px-3 py-1">
                                    {sym}
                                    <button
                                        className="ml-1 text-xs opacity-60 hover:opacity-100"
                                        onClick={() => removeSymbol(sym)}
                                    >✕</button>
                                </span>
                            ))}
                            {(!settings?.watchlist || settings.watchlist.length === 0) && (
                                <span className="text-xs text-[var(--text-muted)]">No symbols in watchlist</span>
                            )}
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Risk Parameters (read-only) */}
                <ErrorBoundary>
                    <div className="card">
                        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">
                            Risk Parameters <span className="text-[var(--text-muted)]">(edit via .env)</span>
                        </div>
                        <div className="space-y-2">
                            {[
                                ['Capital', formatINR(settings?.capital)],
                                ['Max Daily Loss', `${settings?.maxDailyLossPct ?? 0}%`],
                                ['Per-Trade Stop Loss', `${settings?.perTradeStopLossPct ?? 0}%`],
                                ['Max Positions', settings?.maxPositionCount ?? 0],
                                ['Kill Switch Drawdown', `${settings?.killSwitchDrawdownPct ?? 0}%`],
                            ].map(([label, value]) => (
                                <div key={label} className="flex justify-between py-1 border-b border-[var(--border-subtle)]/50">
                                    <span className="text-sm text-[var(--text-secondary)]">{label}</span>
                                    <span className="text-sm font-medium">{value}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Telegram Config */}
                <ErrorBoundary>
                    <div className="card lg:col-span-2">
                        <div className="text-xs text-[var(--text-muted)] uppercase tracking-wide mb-3">
                            Telegram Notifications
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                            <div>
                                <div className="text-xs text-[var(--text-muted)] mb-1">Status</div>
                                <span className={`badge ${settings?.telegram?.enabled ? 'badge-green' : 'badge-red'}`}>
                                    {settings?.telegram?.enabled ? '✅ Active' : '❌ Disabled'}
                                </span>
                            </div>
                            <div>
                                <div className="text-xs text-[var(--text-muted)] mb-1">Messages Sent</div>
                                <span className="text-sm font-medium">{settings?.telegram?.totalSent ?? 0}</span>
                            </div>
                            <div>
                                <div className="text-xs text-[var(--text-muted)] mb-1">Queue / Failed</div>
                                <span className="text-sm font-medium">
                                    {settings?.telegram?.queueLength ?? 0} queued · {settings?.telegram?.totalFailed ?? 0} failed
                                </span>
                            </div>
                        </div>
                    </div>
                </ErrorBoundary>
            </div>

            {/* CONFIRM LIVE Modal */}
            {showModal && (
                <div className="modal-overlay" onClick={() => setShowModal(false)}>
                    <div className="modal-content" onClick={(e) => e.stopPropagation()}>
                        <h3 className="text-lg font-bold text-red-400 mb-2">⚠️ Switch to LIVE Mode</h3>
                        <p className="text-sm text-[var(--text-secondary)] mb-4">
                            This will place <strong>real orders</strong> with your broker using real money.
                            Type <code className="bg-[var(--bg-secondary)] px-1.5 py-0.5 rounded text-red-400">CONFIRM LIVE</code> to proceed.
                        </p>
                        <input
                            type="text"
                            className="input mb-4"
                            placeholder="Type CONFIRM LIVE"
                            value={confirmText}
                            onChange={(e) => setConfirmText(e.target.value)}
                            autoFocus
                        />
                        <div className="flex gap-3 justify-end">
                            <button className="btn" onClick={() => { setShowModal(false); setConfirmText(''); }}>
                                Cancel
                            </button>
                            <button
                                className="btn btn-danger"
                                onClick={confirmLive}
                                disabled={confirmText !== 'CONFIRM LIVE'}
                            >
                                🔴 Go Live
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
