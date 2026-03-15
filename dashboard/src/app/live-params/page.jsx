'use client';

import { useState, useEffect, useCallback } from 'react';
import ErrorBoundary from '@/components/ErrorBoundary';
import { formatINR, API_BASE } from '@/lib/utils';

// ─── Category metadata ───────────────────────────────────────────────────────

const CATEGORY_META = {
    risk: { label: 'Risk Management', icon: '🛡️' },
    ema: { label: 'EMA Crossover Strategy', icon: '📈' },
    rsi: { label: 'RSI Mean Reversion Strategy', icon: '🔄' },
    vwap: { label: 'VWAP Momentum Strategy', icon: '📊' },
    breakout: { label: 'Breakout Volume Strategy', icon: '🚀' },
};

// ─── Skeleton helpers ────────────────────────────────────────────────────────

function SkeletonRow() {
    return <div className="skeleton h-12 w-full rounded-lg mb-2" />;
}

// ═══════════════════════════════════════════════════════════════════════════════
// MAIN PAGE
// ═══════════════════════════════════════════════════════════════════════════════

export default function LiveParamsPage() {
    const [schema, setSchema] = useState(null);   // { key: { label, min, max, ... } }
    const [settings, setSettings] = useState(null);   // { key: { currentValue, isOverridden, ... } }
    const [categories, setCategories] = useState({});
    const [loading, setLoading] = useState(true);
    const [saving, setSaving] = useState({});     // { key: true } while request in flight
    const [errors, setErrors] = useState({});     // { key: 'error message' }
    const [success, setSuccess] = useState({});     // { key: true } for flash feedback
    const [inputs, setInputs] = useState({});     // { key: string } draft input values
    const [toast, setToast] = useState(null);   // { message, type: 'success'|'error' }

    // ─── Fetch schema + current settings ──────────────────────────────────────

    const fetchAll = useCallback(async () => {
        setLoading(true);
        try {
            const [schemaRes, settingsRes] = await Promise.all([
                fetch(`${API_BASE}/api/live-settings/schema`),
                fetch(`${API_BASE}/api/live-settings`),
            ]);

            const schemaJson = await schemaRes.json();
            const settingsJson = await settingsRes.json();

            setSchema(schemaJson.schema || {});
            setCategories(schemaJson.categories || {});
            setSettings(settingsJson.settings || {});

            // Initialise draft inputs to current values so fields are pre-filled
            const initialInputs = {};
            for (const [key, entry] of Object.entries(settingsJson.settings || {})) {
                initialInputs[key] = String(entry.currentValue ?? entry.default ?? '');
            }
            setInputs(initialInputs);
        } catch (err) {
            showToast('Failed to load settings', 'error');
        } finally {
            setLoading(false);
        }
    }, []);

    useEffect(() => { fetchAll(); }, [fetchAll]);

    // ─── Toast helper ──────────────────────────────────────────────────────────

    function showToast(message, type = 'success') {
        setToast({ message, type });
        setTimeout(() => setToast(null), 3000);
    }

    // ─── Apply a single override ───────────────────────────────────────────────

    async function applyOverride(key) {
        const value = inputs[key];
        if (value === '' || value === null || value === undefined) return;

        setSaving(prev => ({ ...prev, [key]: true }));
        setErrors(prev => ({ ...prev, [key]: null }));
        setSuccess(prev => ({ ...prev, [key]: false }));

        try {
            const res = await fetch(`${API_BASE}/api/live-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, value: Number(value) }),
            });
            const json = await res.json();

            if (!res.ok || !json.success) {
                setErrors(prev => ({ ...prev, [key]: json.error || 'Failed to apply' }));
                return;
            }

            // Flash success indicator
            setSuccess(prev => ({ ...prev, [key]: true }));
            setTimeout(() => setSuccess(prev => ({ ...prev, [key]: false })), 2000);

            // Update local settings state immediately (optimistic)
            setSettings(prev => ({
                ...prev,
                [key]: {
                    ...prev[key],
                    currentValue: Number(value),
                    overrideValue: Number(value),
                    isOverridden: true,
                },
            }));

            showToast(`${schema?.[key]?.label ?? key} updated`, 'success');
        } catch (err) {
            setErrors(prev => ({ ...prev, [key]: err.message }));
        } finally {
            setSaving(prev => ({ ...prev, [key]: false }));
        }
    }

    // ─── Reset a single key to .env default ───────────────────────────────────

    async function resetOverride(key) {
        setSaving(prev => ({ ...prev, [key]: true }));
        setErrors(prev => ({ ...prev, [key]: null }));

        try {
            const res = await fetch(`${API_BASE}/api/live-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ key, reset: true }),
            });
            const json = await res.json();

            if (!res.ok || !json.success) {
                setErrors(prev => ({ ...prev, [key]: json.error || 'Failed to reset' }));
                return;
            }

            const defaultValue = schema?.[key]?.default ?? '';

            // Revert draft input to default
            setInputs(prev => ({ ...prev, [key]: String(defaultValue) }));

            // Update local settings state
            setSettings(prev => ({
                ...prev,
                [key]: {
                    ...prev[key],
                    currentValue: defaultValue,
                    overrideValue: null,
                    isOverridden: false,
                },
            }));

            showToast(`${schema?.[key]?.label ?? key} reset to default`, 'success');
        } catch (err) {
            setErrors(prev => ({ ...prev, [key]: err.message }));
        } finally {
            setSaving(prev => ({ ...prev, [key]: false }));
        }
    }

    // ─── Reset ALL overrides ───────────────────────────────────────────────────

    async function resetAll() {
        if (!confirm('Reset ALL parameters to .env defaults?')) return;

        try {
            const res = await fetch(`${API_BASE}/api/live-settings`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ resetAll: true }),
            });
            const json = await res.json();

            if (!res.ok || !json.success) {
                showToast('Failed to reset all settings', 'error');
                return;
            }

            showToast('All parameters reset to defaults', 'success');
            fetchAll();
        } catch (err) {
            showToast(err.message, 'error');
        }
    }

    // ─── Count active overrides ────────────────────────────────────────────────

    const overrideCount = settings
        ? Object.values(settings).filter(s => s.isOverridden).length
        : 0;

    // ─── Group schema keys by category ────────────────────────────────────────

    const grouped = {};
    if (schema) {
        for (const [key, entry] of Object.entries(schema)) {
            const cat = entry.category || 'other';
            if (!grouped[cat]) grouped[cat] = [];
            grouped[cat].push(key);
        }
    }

    // ═══════════════════════════════════════════════════════════════════════════
    // RENDER
    // ═══════════════════════════════════════════════════════════════════════════

    return (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '2rem' }}>

            {/* ── Toast ────────────────────────────────────────────────────────────── */}
            {toast && (
                <div style={{
                    position: 'fixed',
                    bottom: '2rem',
                    right: '2rem',
                    zIndex: 100,
                    background: toast.type === 'success' ? 'var(--green)' : 'var(--red)',
                    color: '#fff',
                    padding: '0.75rem 1.25rem',
                    borderRadius: 'var(--radius-sm)',
                    fontSize: '0.875rem',
                    fontWeight: 500,
                    boxShadow: '0 4px 12px rgba(0,0,0,0.3)',
                }}>
                    {toast.type === 'success' ? '✅' : '❌'} {toast.message}
                </div>
            )}

            {/* ── Header ───────────────────────────────────────────────────────────── */}
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                <div>
                    <h1 className="text-3xl font-bold tracking-tight">Live Parameters</h1>
                    <p className="text-sm text-[var(--text-muted)] mt-2">
                        Override strategy and risk parameters without restarting. Takes effect on the next scan cycle.
                    </p>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: '1rem' }}>
                    {overrideCount > 0 && (
                        <span className="badge badge-blue">{overrideCount} active override{overrideCount !== 1 ? 's' : ''}</span>
                    )}
                    {overrideCount > 0 && (
                        <button className="btn btn-danger" onClick={resetAll}>
                            ↺ Reset All
                        </button>
                    )}
                </div>
            </div>

            {/* ── Info banner ──────────────────────────────────────────────────────── */}
            <div className="card" style={{ borderLeft: '3px solid var(--blue)', padding: '1rem 1.5rem' }}>
                <p className="text-sm text-[var(--text-secondary)]">
                    <strong>How it works:</strong> Overrides are stored in Redis and applied at the start of each 5-minute scan cycle.
                    Parameters revert to <code style={{ background: 'var(--bg-secondary)', padding: '0 4px', borderRadius: 4 }}>.env</code> defaults
                    if Redis is unavailable or on app restart without an override set.
                    Use <code style={{ background: 'var(--bg-secondary)', padding: '0 4px', borderRadius: 4 }}>/set KEY value</code> in Telegram to change params remotely.
                </p>
            </div>

            {/* ── Category sections ────────────────────────────────────────────────── */}
            {loading ? (
                <div className="card">
                    {[1, 2, 3, 4, 5].map(i => <SkeletonRow key={i} />)}
                </div>
            ) : (
                Object.entries(grouped).map(([cat, keys]) => (
                    <ErrorBoundary key={cat}>
                        <CategorySection
                            category={cat}
                            categoryMeta={CATEGORY_META[cat] || { label: cat, icon: '⚙️' }}
                            keys={keys}
                            schema={schema}
                            settings={settings}
                            inputs={inputs}
                            saving={saving}
                            errors={errors}
                            success={success}
                            onInputChange={(key, val) => setInputs(prev => ({ ...prev, [key]: val }))}
                            onApply={applyOverride}
                            onReset={resetOverride}
                        />
                    </ErrorBoundary>
                ))
            )}
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// CATEGORY SECTION
// ═══════════════════════════════════════════════════════════════════════════════

function CategorySection({
    category, categoryMeta, keys, schema, settings,
    inputs, saving, errors, success,
    onInputChange, onApply, onReset,
}) {
    const overridesInCategory = keys.filter(k => settings?.[k]?.isOverridden).length;

    return (
        <div className="card overflow-hidden" style={{ padding: 0 }}>
            {/* Section header */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '1.25rem 1.75rem',
                borderBottom: '1px solid var(--border-subtle)',
                background: 'var(--bg-card)',
            }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                    <span style={{ fontSize: '1.25rem' }}>{categoryMeta.icon}</span>
                    <span className="font-medium text-[var(--text-primary)]">{categoryMeta.label}</span>
                </div>
                {overridesInCategory > 0 && (
                    <span className="badge badge-blue">
                        {overridesInCategory} override{overridesInCategory !== 1 ? 's' : ''}
                    </span>
                )}
            </div>

            {/* Params table */}
            <div style={{ overflowX: 'auto' }}>
                <table className="data-table">
                    <thead>
                        <tr>
                            <th style={{ width: '25%' }}>Parameter</th>
                            <th style={{ width: '20%' }}>Current Value</th>
                            <th style={{ width: '15%' }}>.env Default</th>
                            <th style={{ width: '25%' }}>Override</th>
                            <th style={{ width: '15%' }}>Status</th>
                            <th style={{ width: '10%' }}></th>
                        </tr>
                    </thead>
                    <tbody>
                        {keys.map(key => (
                            <ParamRow
                                key={key}
                                paramKey={key}
                                schema={schema?.[key]}
                                setting={settings?.[key]}
                                inputValue={inputs[key] ?? ''}
                                isSaving={!!saving[key]}
                                error={errors[key]}
                                isSuccess={!!success[key]}
                                onInputChange={val => onInputChange(key, val)}
                                onApply={() => onApply(key)}
                                onReset={() => onReset(key)}
                            />
                        ))}
                    </tbody>
                </table>
            </div>
        </div>
    );
}

// ═══════════════════════════════════════════════════════════════════════════════
// PARAM ROW
// ═══════════════════════════════════════════════════════════════════════════════

function ParamRow({
    paramKey, schema, setting,
    inputValue, isSaving, error, isSuccess,
    onInputChange, onApply, onReset,
}) {
    if (!schema) return null;

    const isOverridden = setting?.isOverridden ?? false;
    const currentValue = setting?.currentValue ?? schema.default;
    const defaultValue = schema.default;
    const isDirty = Number(inputValue) !== currentValue;

    // Format value for display — capital gets INR formatting
    function fmtValue(val) {
        if (paramKey === 'TRADING_CAPITAL') return formatINR(val);
        if (String(val).includes('.')) return Number(val).toFixed(2);
        return val;
    }

    function handleKeyDown(e) {
        if (e.key === 'Enter') onApply();
    }

    return (
        <tr style={{ background: isOverridden ? 'rgba(59,130,246,0.04)' : undefined }}>

            {/* Parameter name + description */}
            <td>
                <div className="font-medium text-[var(--text-primary)]" style={{ fontSize: '0.875rem' }}>
                    {schema.label}
                </div>
                <div className="text-xs text-[var(--text-muted)] mt-0.5" style={{ maxWidth: 220 }}>
                    {schema.description}
                </div>
            </td>

            {/* Current active value */}
            <td>
                <span
                    className={`font-medium ${isOverridden ? 'text-[var(--blue)]' : 'text-[var(--text-secondary)]'}`}
                    style={{ fontSize: '0.9rem' }}
                >
                    {fmtValue(currentValue)}
                </span>
            </td>

            {/* .env default */}
            <td className="text-[var(--text-muted)]" style={{ fontSize: '0.875rem' }}>
                {fmtValue(defaultValue)}
            </td>

            {/* Input + apply button */}
            <td>
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
                    <input
                        type="number"
                        className="input"
                        style={{ width: 110 }}
                        min={schema.min}
                        max={schema.max}
                        step={schema.step}
                        value={inputValue}
                        disabled={isSaving}
                        onChange={e => onInputChange(e.target.value)}
                        onKeyDown={handleKeyDown}
                    />
                    <button
                        className="btn btn-primary"
                        style={{ padding: '0.4rem 0.75rem', fontSize: '0.8rem', opacity: (!isDirty || isSaving) ? 0.5 : 1 }}
                        onClick={onApply}
                        disabled={!isDirty || isSaving}
                    >
                        {isSaving ? '…' : 'Apply'}
                    </button>
                </div>

                {/* Validation error */}
                {error && (
                    <div className="text-xs mt-1" style={{ color: 'var(--red)' }}>
                        ⚠ {error}
                    </div>
                )}

                {/* Success flash */}
                {isSuccess && (
                    <div className="text-xs mt-1" style={{ color: 'var(--green)' }}>
                        ✓ Applied
                    </div>
                )}
            </td>

            {/* Status badge */}
            <td>
                {isOverridden ? (
                    <span className="badge badge-blue">Override</span>
                ) : (
                    <span className="badge badge-yellow">.env</span>
                )}
            </td>

            {/* Reset button — only shown when overridden */}
            <td>
                {isOverridden && (
                    <button
                        className="btn"
                        style={{ padding: '0.3rem 0.6rem', fontSize: '0.75rem' }}
                        onClick={onReset}
                        disabled={isSaving}
                        title={`Reset to default (${fmtValue(defaultValue)})`}
                    >
                        ↺
                    </button>
                )}
            </td>
        </tr>
    );
}