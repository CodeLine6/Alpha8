'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, API_BASE } from '@/lib/utils';

const CATEGORY_META = {
    risk:      { label: 'Risk Management',           icon: '🛡️' },
    ema:       { label: 'EMA Crossover Strategy',    icon: '📈' },
    rsi:       { label: 'RSI Mean Reversion',        icon: '🔄' },
    vwap:      { label: 'VWAP Momentum',             icon: '📊' },
    breakout:  { label: 'Breakout Volume',           icon: '🚀' },
    orb:       { label: 'ORB Breakout',              icon: '🌅' },
    bavi:      { label: 'BAVI Order Flow',           icon: '🌊' },
    consensus: { label: 'Signal Consensus',          icon: '🤝' },
    scout:     { label: 'Nightly Symbol Scout',      icon: '🔍' },
};

const TH = 'py-3 px-4 text-left text-[10px] font-semibold uppercase tracking-widest text-slate-500 border-b border-slate-700/40 whitespace-nowrap sticky top-0 z-10 bg-slate-900';
const TD = 'py-3 px-4 text-sm align-top';
const INP_CLS = 'w-[110px] rounded-xl border border-slate-600/40 bg-slate-950 px-2.5 py-1.5 text-sm text-slate-200 outline-none focus:border-indigo-500/50 focus:ring-1 focus:ring-indigo-500/20 transition disabled:opacity-40';

function Badge({ color, children }) {
    const cls = { green: 'bg-green-500/10 text-green-400 border-green-500/20', red: 'bg-red-500/10 text-red-400 border-red-500/20', yellow: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20', blue: 'bg-blue-500/10 text-blue-400 border-blue-500/20' }[color] ?? 'bg-white/5 text-slate-400 border-white/10';
    return <span className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-semibold ${cls}`}>{children}</span>;
}

// ── Param Row ────────────────────────────────────────────────
function ParamRow({ paramKey, schema, setting, inputValue, isSaving, error, isSuccess, onInputChange, onApply, onReset }) {
    if (!schema) return null;
    const isOverridden = setting?.isOverridden ?? false;
    const currentValue = setting?.currentValue ?? schema.default;
    const defaultValue = schema.default;

    let isDirty = inputValue !== String(currentValue);
    if (schema.type === 'number')  isDirty = Number(inputValue) !== currentValue;
    if (schema.type === 'boolean') isDirty = (inputValue === 'true') !== currentValue;

    const fmt = (v) => paramKey === 'TRADING_CAPITAL' ? formatINR(v) : String(v).includes('.') ? Number(v).toFixed(2) : v;

    return (
        <tr className={`border-b border-white/[0.04] ${isOverridden ? 'bg-blue-500/[0.03]' : 'hover:bg-white/[0.02]'} transition-colors`}>
            <td className={TD}>
                <p className="text-sm font-medium text-white">{schema.label}</p>
                <p className="text-xs text-slate-600 mt-0.5 max-w-[220px]">{schema.description}</p>
            </td>
            <td className={`${TD} tabular-nums font-semibold ${isOverridden ? 'text-blue-400' : 'text-slate-300'}`}>{fmt(currentValue)}</td>
            <td className={`${TD} tabular-nums text-slate-500`}>{fmt(defaultValue)}</td>
            <td className={TD}>
                <div className="flex items-center gap-2">
                    {schema.type === 'boolean' || schema.type === 'select' ? (
                        <select className={INP_CLS} value={String(inputValue)} disabled={isSaving} onChange={e => onInputChange(e.target.value)}>
                            {schema.type === 'boolean'
                                ? [<option key="t" value="true">Enabled</option>, <option key="f" value="false">Disabled</option>]
                                : schema.options?.map(o => <option key={o} value={o}>{o}</option>)
                            }
                        </select>
                    ) : (
                        <input type="number" className={INP_CLS} min={schema.min} max={schema.max} step={schema.step}
                            value={inputValue} disabled={isSaving}
                            onChange={e => onInputChange(e.target.value)}
                            onKeyDown={e => e.key === 'Enter' && onApply()} />
                    )}
                    <button onClick={onApply} disabled={!isDirty || isSaving}
                        className="rounded-xl border border-indigo-500/30 bg-indigo-500/10 px-3 py-1.5 text-xs font-semibold text-indigo-400 hover:bg-indigo-500/20 transition disabled:opacity-30">
                        {isSaving ? '…' : 'Apply'}
                    </button>
                </div>
                {error   && <p className="text-xs mt-1 text-red-400">⚠ {error}</p>}
                {isSuccess && <p className="text-xs mt-1 text-green-400">✓ Applied</p>}
            </td>
            <td className={TD}><Badge color={isOverridden ? 'blue' : 'yellow'}>{isOverridden ? 'Override' : '.env'}</Badge></td>
            <td className={TD}>
                {isOverridden && (
                    <button onClick={onReset} disabled={isSaving} title={`Reset to default (${fmt(defaultValue)})`}
                        className="rounded-lg border border-white/10 bg-white/5 px-2.5 py-1 text-xs text-slate-400 hover:bg-white/10 transition disabled:opacity-40">
                        ↺
                    </button>
                )}
            </td>
        </tr>
    );
}

// ── Category Section ─────────────────────────────────────────
function CategorySection({ categoryMeta, keys, schema, settings, inputs, saving, errors, success, onInputChange, onApply, onReset }) {
    const overrides = keys.filter(k => settings?.[k]?.isOverridden).length;
    return (
        <div className="rounded-2xl border border-slate-700/50 bg-slate-900 overflow-hidden">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-700/40">
                <div className="flex items-center gap-2.5">
                    <span className="text-xl">{categoryMeta.icon}</span>
                    <span className="font-semibold text-white text-sm">{categoryMeta.label}</span>
                </div>
                {overrides > 0 && <Badge color="blue">{overrides} override{overrides !== 1 ? 's' : ''}</Badge>}
            </div>
            <div className="overflow-x-auto">
                <table className="w-full border-collapse">
                    <thead><tr>{['Parameter', 'Current', '.env Default', 'Override', 'Status', ''].map(h => <th key={h} className={TH}>{h}</th>)}</tr></thead>
                    <tbody>
                        {keys.map(key => (
                            <ParamRow key={key} paramKey={key} schema={schema?.[key]} setting={settings?.[key]}
                                inputValue={inputs[key] ?? ''} isSaving={!!saving[key]} error={errors[key]} isSuccess={!!success[key]}
                                onInputChange={val => onInputChange(key, val)} onApply={() => onApply(key)} onReset={() => onReset(key)} />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ── Main Page ─────────────────────────────────────────────────
export default function LiveParamsPage() {
    const [schema,   setSchema]   = useState(null);
    const [settings, setSettings] = useState(null);
    const [loading,  setLoading]  = useState(true);
    const [saving,   setSaving]   = useState({});
    const [errors,   setErrors]   = useState({});
    const [success,  setSuccess]  = useState({});
    const [inputs,   setInputs]   = useState({});
    const [toast,    setToast]    = useState(null);

    const showToast = (msg, type = 'success') => { setToast({ msg, type }); setTimeout(() => setToast(null), 3000); };

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const [sr, sv] = await Promise.all([
                fetch(`${API_BASE}/api/live-settings/schema`),
                fetch(`${API_BASE}/api/live-settings`),
            ]);
            const schemaJson   = await sr.json();
            const settingsJson = await sv.json();
            setSchema(schemaJson.schema || {});
            setSettings(settingsJson.settings || {});
            const init = {};
            for (const [k, e] of Object.entries(settingsJson.settings || {})) init[k] = String(e.currentValue ?? e.default ?? '');
            setInputs(init);
        } catch { showToast('Failed to load settings', 'error'); }
        finally { setLoading(false); }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    const applyOverride = async (key) => {
        const value = inputs[key];
        if (value === '' || value == null) return;
        let v = value;
        if (schema?.[key]?.type === 'number')  v = Number(value);
        if (schema?.[key]?.type === 'boolean') v = value === 'true';
        setSaving(p => ({ ...p, [key]: true })); setErrors(p => ({ ...p, [key]: null })); setSuccess(p => ({ ...p, [key]: false }));
        try {
            const r = await fetch(`${API_BASE}/api/live-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, value: v }) });
            const j = await r.json();
            if (!r.ok || !j.success) { setErrors(p => ({ ...p, [key]: j.error || 'Failed' })); return; }
            setSuccess(p => ({ ...p, [key]: true })); setTimeout(() => setSuccess(p => ({ ...p, [key]: false })), 2000);
            setSettings(p => ({ ...p, [key]: { ...p[key], currentValue: v, overrideValue: v, isOverridden: true } }));
            showToast(`${schema?.[key]?.label ?? key} updated`);
        } catch (e) { setErrors(p => ({ ...p, [key]: e.message })); }
        finally { setSaving(p => ({ ...p, [key]: false })); }
    };

    const resetOverride = async (key) => {
        setSaving(p => ({ ...p, [key]: true })); setErrors(p => ({ ...p, [key]: null }));
        try {
            const r = await fetch(`${API_BASE}/api/live-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ key, reset: true }) });
            const j = await r.json();
            if (!r.ok || !j.success) { setErrors(p => ({ ...p, [key]: j.error || 'Failed' })); return; }
            const def = schema?.[key]?.default ?? '';
            setInputs(p => ({ ...p, [key]: String(def) }));
            setSettings(p => ({ ...p, [key]: { ...p[key], currentValue: def, overrideValue: null, isOverridden: false } }));
            showToast(`${schema?.[key]?.label ?? key} reset`);
        } catch (e) { setErrors(p => ({ ...p, [key]: e.message })); }
        finally { setSaving(p => ({ ...p, [key]: false })); }
    };

    const resetAll = async () => {
        if (!confirm('Reset ALL parameters to .env defaults?')) return;
        try {
            const r = await fetch(`${API_BASE}/api/live-settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ resetAll: true }) });
            const j = await r.json();
            if (!r.ok || !j.success) { showToast('Failed to reset all', 'error'); return; }
            showToast('All parameters reset to defaults'); fetchAll();
        } catch (e) { showToast(e.message, 'error'); }
    };

    const overrideCount = settings ? Object.values(settings).filter(s => s.isOverridden).length : 0;

    const grouped = {};
    if (schema) for (const [key, e] of Object.entries(schema)) { const c = e.category || 'other'; (grouped[c] ??= []).push(key); }

    return (
        <div className="space-y-6">
            {/* Toast */}
            {toast && (
                <div className={`fixed bottom-8 right-8 z-[100] rounded-xl px-4 py-2.5 text-sm font-medium text-white shadow-xl ${toast.type === 'success' ? 'bg-green-600' : 'bg-red-600'}`}>
                    {toast.type === 'success' ? '✅' : '❌'} {toast.msg}
                </div>
            )}

            {/* Header */}
            <div className="flex items-start justify-between">
                <div>
                    <h1 className="text-2xl font-bold tracking-tight text-white">Live Parameters</h1>
                    <p className="text-sm text-slate-500 mt-1">Override strategy and risk params without restarting</p>
                </div>
                <div className="flex items-center gap-3">
                    {overrideCount > 0 && <Badge color="blue">{overrideCount} active override{overrideCount !== 1 ? 's' : ''}</Badge>}
                    {overrideCount > 0 && (
                        <button onClick={resetAll} className="rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-2 text-sm font-semibold text-red-400 hover:bg-red-500/20 transition">
                            ↺ Reset All
                        </button>
                    )}
                </div>
            </div>

            {/* Info banner */}
            <div className="rounded-2xl border-l-4 border-l-blue-500 border-r border-t border-b border-white/[0.06] bg-[#141922] px-5 py-3.5">
                <p className="text-sm text-slate-400">
                    <strong className="text-white">How it works:</strong> Overrides stored in Redis, applied at the next 5-minute scan cycle.
                    Params revert to <code className="rounded bg-white/5 px-1 text-blue-400 text-xs">.env</code> defaults on restart. Use{' '}
                    <code className="rounded bg-white/5 px-1 text-blue-400 text-xs">/set KEY value</code> in Telegram to change remotely.
                </p>
            </div>

            {/* Category sections */}
            {loading ? (
                <div className="rounded-2xl border border-white/[0.07] bg-[#141922] p-6 space-y-2">
                    {[1,2,3,4,5].map(i => <div key={i} className="h-12 rounded-xl bg-white/[0.04] animate-pulse" />)}
                </div>
            ) : (
                Object.entries(grouped).map(([cat, keys]) => (
                    <ErrorBoundary key={cat}>
                        <CategorySection
                            categoryMeta={CATEGORY_META[cat] || { label: cat, icon: '⚙️' }}
                            keys={keys} schema={schema} settings={settings}
                            inputs={inputs} saving={saving} errors={errors} success={success}
                            onInputChange={(k, v) => setInputs(p => ({ ...p, [k]: v }))}
                            onApply={applyOverride} onReset={resetOverride}
                        />
                    </ErrorBoundary>
                ))
            )}
        </div>
    );
}