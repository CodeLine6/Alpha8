'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, API_BASE } from '@/lib/utils';

const CARD = 'rounded-2xl border border-slate-700/50 bg-slate-900 p-6';
const LABEL = 'text-[10px] font-semibold uppercase tracking-widest text-slate-500 mb-2';
const INP = 'w-full rounded-xl border border-slate-600/40 bg-slate-950 px-3 py-2 text-sm text-slate-200 placeholder-slate-600 focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 outline-none transition';

function Badge({ color, children }) {
    const cls = { green: 'bg-green-500/10 text-green-400 border-green-500/20', red: 'bg-red-500/10 text-red-400 border-red-500/20', yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20' }[color] ?? 'bg-white/5 text-slate-400 border-white/10';
    return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

export default function SettingsPage() {
    const [settings, setSettings]             = useState(null);
    const [loading, setLoading]               = useState(true);
    const [showModal, setShowModal]           = useState(false);
    const [confirmText, setConfirmText]       = useState('');
    const [watchlistInput, setWatchlistInput] = useState('');

    const fetchSettings = useCallback(async () => {
        try { setSettings(await (await fetch(`${API_BASE}/api/settings`)).json()); }
        catch { /* ErrorBoundary */ }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchSettings(); }, [fetchSettings]);

    const api = (path, body) => fetch(`${API_BASE}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }).then(fetchSettings);

    const toggleMode = () => settings?.paperMode === false ? setShowModal(true) : api('/api/settings/mode', { paperMode: true });
    const confirmLive = () => { if (confirmText !== 'CONFIRM LIVE') return; api('/api/settings/mode', { paperMode: false }); setShowModal(false); setConfirmText(''); };
    const engageKill = () => confirm('⚠️ Engage Kill Switch? This will BLOCK all new orders.') && api('/api/killswitch', { action: 'engage', reason: 'Manual dashboard trigger' });
    const addSymbol  = () => { if (!watchlistInput.trim()) return; api('/api/settings/watchlist', { action: 'add', symbol: watchlistInput.trim().toUpperCase() }); setWatchlistInput(''); };
    const removeSymbol = (symbol) => api('/api/settings/watchlist', { action: 'remove', symbol });

    if (loading) return (
        <div className="space-y-5">
            <h1 className="text-2xl font-bold text-white">Settings</h1>
            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                {[1,2,3,4].map(i => <div key={i} className="h-32 rounded-2xl bg-[#141922] border border-white/[0.07] animate-pulse" />)}
            </div>
        </div>
    );

    const riskParams = [
        ['Capital',               formatINR(settings?.capital)],
        ['Max Daily Loss',        `${settings?.maxDailyLossPct ?? 0}%`],
        ['Per-Trade Stop Loss',   `${settings?.perTradeStopLossPct ?? 0}%`],
        ['Max Positions',         settings?.maxPositionCount ?? 0],
        ['Kill Switch Drawdown',  `${settings?.killSwitchDrawdownPct ?? 0}%`],
    ];

    return (
        <div className="space-y-6">
            <div>
                <h1 className="text-2xl font-bold tracking-tight text-white">Settings</h1>
                <p className="text-sm text-slate-500 mt-1">Configuration and control panel</p>
            </div>

            <div className="grid grid-cols-1 gap-5 sm:grid-cols-2">
                {/* Trading Mode */}
                <ErrorBoundary>
                    <div className={CARD}>
                        <p className={LABEL}>Trading Mode</p>
                        <div className="flex items-center justify-between mt-2">
                            <div>
                                <Badge color={settings?.paperMode ? 'yellow' : 'red'}>
                                    {settings?.paperMode ? '📝 Paper Trading' : '🔴 LIVE Trading'}
                                </Badge>
                                <p className="text-xs text-slate-500 mt-2">
                                    {settings?.paperMode ? 'Simulated — no real money' : '⚠️ Real orders with your broker'}
                                </p>
                            </div>
                            <button onClick={toggleMode}
                                className={`rounded-xl px-4 py-2 text-sm font-semibold transition border ${settings?.paperMode ? 'border-red-500/30 bg-red-500/10 text-red-400 hover:bg-red-500/20' : 'border-green-500/30 bg-green-500/10 text-green-400 hover:bg-green-500/20'}`}>
                                Switch to {settings?.paperMode ? 'LIVE' : 'Paper'}
                            </button>
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Kill Switch */}
                <ErrorBoundary>
                    <div className={`${CARD} ${settings?.killSwitchEngaged ? 'border-red-500/30' : ''}`}>
                        <p className={LABEL}>Kill Switch</p>
                        <div className="flex items-center justify-between mt-2">
                            <div>
                                <Badge color={settings?.killSwitchEngaged ? 'red' : 'green'}>
                                    {settings?.killSwitchEngaged ? '🛑 ENGAGED' : '✅ Normal'}
                                </Badge>
                                <p className="text-xs text-slate-500 mt-2">
                                    {settings?.killSwitchEngaged ? 'All orders blocked. Manual reset required.' : 'Trading is active'}
                                </p>
                            </div>
                            {!settings?.killSwitchEngaged && (
                                <button onClick={engageKill}
                                    className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition">
                                    🛑 Engage
                                </button>
                            )}
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Watchlist */}
                <ErrorBoundary>
                    <div className={CARD}>
                        <p className={LABEL}>Pinned Symbols</p>
                        <div className="flex gap-2 mb-4 mt-2">
                            <input type="text" className={INP} placeholder="Add symbol e.g. RELIANCE"
                                value={watchlistInput}
                                onChange={e => setWatchlistInput(e.target.value.toUpperCase())}
                                onKeyDown={e => e.key === 'Enter' && addSymbol()} />
                            <button onClick={addSymbol}
                                className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-4 py-2 text-sm font-semibold text-indigo-400 hover:bg-indigo-500/20 transition shrink-0">
                                Add
                            </button>
                        </div>
                        <div className="flex flex-wrap gap-2">
                            {(settings?.watchlist || []).map(sym => (
                                <span key={sym} className="inline-flex items-center gap-1.5 rounded-full border border-blue-500/20 bg-blue-500/10 px-3 py-1 text-xs font-semibold text-blue-400">
                                    {sym}
                                    <button onClick={() => removeSymbol(sym)} className="opacity-50 hover:opacity-100 transition">✕</button>
                                </span>
                            ))}
                            {!settings?.watchlist?.length && <span className="text-xs text-slate-600">No symbols added</span>}
                        </div>

                        <div className="mt-6 pt-4 border-t border-white/[0.04]">
                            <p className={LABEL}>Dynamic Universe (Auto-Scouted)</p>
                            <div className="flex flex-wrap gap-2 mt-3">
                                {(settings?.dynamicWatchlist || []).map(sym => (
                                    <span key={sym} className="inline-flex items-center gap-1.5 rounded-full border border-purple-500/20 bg-purple-500/10 px-3 py-1 text-xs font-semibold text-purple-400">
                                        ⚡ {sym}
                                    </span>
                                ))}
                                {!settings?.dynamicWatchlist?.length && <span className="text-xs text-slate-600">No dynamic symbols scouted yet</span>}
                            </div>
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Risk Params */}
                <ErrorBoundary>
                    <div className={CARD}>
                        <p className={LABEL}>Risk Parameters <span className="normal-case text-slate-600">(edit via .env)</span></p>
                        <div className="space-y-1 mt-2">
                            {riskParams.map(([lbl, val]) => (
                                <div key={lbl} className="flex justify-between py-2 border-b border-white/[0.04] last:border-0">
                                    <span className="text-sm text-slate-400">{lbl}</span>
                                    <span className="text-sm font-medium text-white tabular-nums">{val}</span>
                                </div>
                            ))}
                        </div>
                    </div>
                </ErrorBoundary>

                {/* Telegram */}
                <ErrorBoundary>
                    <div className={`${CARD} sm:col-span-2`}>
                        <p className={LABEL}>Telegram Notifications</p>
                        <div className="grid grid-cols-3 gap-6 mt-3">
                            <div>
                                <p className="text-xs text-slate-500 mb-1.5">Status</p>
                                <Badge color={settings?.telegram?.enabled ? 'green' : 'red'}>
                                    {settings?.telegram?.enabled ? '✅ Active' : '❌ Disabled'}
                                </Badge>
                            </div>
                            <div>
                                <p className="text-xs text-slate-500 mb-1.5">Messages Sent</p>
                                <p className="text-sm font-semibold text-white tabular-nums">{settings?.telegram?.totalSent ?? 0}</p>
                            </div>
                            <div>
                                <p className="text-xs text-slate-500 mb-1.5">Queue / Failed</p>
                                <p className="text-sm font-semibold text-white tabular-nums">
                                    {settings?.telegram?.queueLength ?? 0} queued · {settings?.telegram?.totalFailed ?? 0} failed
                                </p>
                            </div>
                        </div>
                    </div>
                </ErrorBoundary>
            </div>

            {/* Confirm LIVE modal */}
            {showModal && (
                <div onClick={() => { setShowModal(false); setConfirmText(''); }} className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 backdrop-blur-sm">
                    <div onClick={e => e.stopPropagation()} className="w-96 rounded-2xl border border-white/[0.08] bg-[#141922] p-6 shadow-2xl">
                        <h3 className="text-base font-bold text-red-400 mb-2">⚠️ Switch to LIVE Mode</h3>
                        <p className="text-sm text-slate-400 mb-4">
                            This will place <strong className="text-white">real orders</strong> with your broker.
                            Type <code className="rounded bg-white/5 px-1.5 py-0.5 text-red-400 text-xs">CONFIRM LIVE</code> to proceed.
                        </p>
                        <input type="text" className={`${INP} mb-4`} placeholder="Type CONFIRM LIVE" value={confirmText} onChange={e => setConfirmText(e.target.value)} autoFocus />
                        <div className="flex gap-3">
                            <button onClick={confirmLive} disabled={confirmText !== 'CONFIRM LIVE'}
                                className="flex-1 rounded-xl border border-red-500/30 bg-red-500/10 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition disabled:opacity-40">
                                🔴 Go Live
                            </button>
                            <button onClick={() => { setShowModal(false); setConfirmText(''); }}
                                className="flex-1 rounded-xl border border-white/10 bg-white/5 py-2 text-sm font-semibold text-slate-400 hover:bg-white/10 transition">
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
}
