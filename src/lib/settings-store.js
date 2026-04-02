/**
 * @fileoverview Live Settings Store for Alpha8
 *
 * Redis-backed runtime parameter overrides.
 * Parameters set here take effect on the next scan cycle.
 *
 * Storage: Redis hash at key `live:settings` (prefixed to `alpha8:live:settings`)
 *
 * Validation added to setLiveSetting:
 *   - Numeric keys reject non-numeric values and enforce positive-only constraints.
 *   - Boolean keys reject anything other than 'true' or 'false'.
 *   - Enum keys (TRAIL_MODE) reject unrecognised values.
 *   - Cross-field constraints from the startup Zod schema are re-checked:
 *       KILL_SWITCH_DRAWDOWN_PCT >= MAX_DAILY_LOSS_PCT
 *       STOP_LOSS_PCT < TRAILING_STOP_PCT  (if both are set)
 */

import { getRedis } from './redis.js';

const REDIS_KEY = 'live:settings';

const DEFAULTS = {
    // ── Risk Management ─────────────────────────────────────────────────────────
    MAX_DAILY_LOSS_PCT: null,
    PER_TRADE_STOP_LOSS_PCT: null,
    MAX_POSITION_COUNT: null,
    KILL_SWITCH_DRAWDOWN_PCT: null,
    TRADING_CAPITAL: null,
    MAX_CAPITAL_EXPOSURE_PCT: null,
    MAX_POSITION_VALUE_PCT: null,

    // ── Position Exit — Core ──────────────────────────────────────────────────────
    STOP_LOSS_PCT: null,   // Hard stop loss % below entry
    TRAILING_STOP_PCT: null,  // Base trailing stop % (overridden by ATR if candles available)

    // ── Position Exit — Profit Target ────────────────────────────────────────────
    PROFIT_TARGET_PCT: null, // Fixed % target (used by RSI mean reversion)
    RISK_REWARD_RATIO: null, // R/R multiplier for stop distance (used by momentum strategies)

    // ── Position Exit — Partial Exit ─────────────────────────────────────────────
    PARTIAL_EXIT_ENABLED: null, // boolean — sell partial at profit target
    PARTIAL_EXIT_PCT: null, // % of position to sell at target (default 50)

    // ── Position Exit — Signal Reversal ─────────────────────────────────────────
    SIGNAL_REVERSAL_ENABLED: null, // boolean — exit when opening strategy fires opposite

    // ── Position Exit — PnL Trail ────────────────────────────────────────────────
    PNL_TRAIL_PCT: null,       // % of peak PnL to give back before exiting
    PNL_TRAIL_FLOOR: null,     // Min ₹ profit before PnL trail activates
    TRAIL_MODE: null,          // 'PNL_TRAIL' | 'PRICE_TRAIL' | 'HYBRID'
    USE_ATR_TRAIL: null,       // boolean — derive trail width from ATR vs fixed %

    // ── Position Exit — Time ────────────────────────────────────────────────────
    MAX_HOLD_MINUTES: null, // Max minutes to hold a flat/losing position

    // ── EMA Crossover Strategy ───────────────────────────────────────────────────
    EMA_FAST_PERIOD: null,
    EMA_SLOW_PERIOD: null,

    // ── RSI Mean Reversion Strategy ─────────────────────────────────────────────
    RSI_PERIOD: null,
    RSI_OVERSOLD: null,
    RSI_OVERBOUGHT: null,
    RSI_EXTREME_OVERSOLD: null,
    RSI_EXTREME_OVERBOUGHT: null,

    // ── VWAP Momentum Strategy ───────────────────────────────────────────────────
    VWAP_VOLUME_MULTIPLIER: null,
    VWAP_PRICE_BAND_PCT: null,
    VWAP_VOLUME_AVG_PERIOD: null,

    // ── Breakout Volume Strategy ─────────────────────────────────────────────────
    BREAKOUT_LOOKBACK: null,
    BREAKOUT_VOLUME_MULTIPLIER: null,
    BREAKOUT_BB_PERIOD: null,
    BREAKOUT_BB_STDDEV: null,

    // ── ORB Strategy ─────────────────────────────────────────────────────────────
    ORB_MIN_RANGE_PCT: null,
    ORB_MAX_RANGE_PCT: null,
    ORB_VOLUME_MULTIPLIER: null,

    // ── BAVI Strategy ────────────────────────────────────────────────────────────
    BAVI_IMBALANCE_THRESHOLD: null,
    BAVI_STRONG_IMBALANCE: null,
    BAVI_MIN_TICK_COUNT: null,

    // ── Short Selling ────────────────────────────────────────────────────────────
    SHORTS_ENABLED: null,
    SHORT_MIN_CONFIDENCE: null,

    // ── Signal Consensus ────────────────────────────────────────────────────────
    MIN_CONFIDENCE: null,
    MIN_AGREEMENT: null,
    SUPER_CONVICTION_THRESHOLD: null,

    // ── Symbol Scout ────────────────────────────────────────────────────────────
    SCOUT_MAX_DYNAMIC: null,
};

// ── Per-key type metadata ─────────────────────────────────────────────────────

const BOOLEAN_KEYS = new Set([
    'PARTIAL_EXIT_ENABLED', 'SIGNAL_REVERSAL_ENABLED', 'USE_ATR_TRAIL', 'SHORTS_ENABLED',
]);

const ENUM_KEYS = {
    TRAIL_MODE: ['PNL_TRAIL', 'PRICE_TRAIL', 'HYBRID'],
};

// Keys that must be > 0
const POSITIVE_KEYS = new Set([
    'MAX_DAILY_LOSS_PCT', 'PER_TRADE_STOP_LOSS_PCT', 'KILL_SWITCH_DRAWDOWN_PCT',
    'TRADING_CAPITAL', 'MAX_CAPITAL_EXPOSURE_PCT', 'MAX_POSITION_VALUE_PCT',
    'STOP_LOSS_PCT', 'TRAILING_STOP_PCT', 'PROFIT_TARGET_PCT', 'RISK_REWARD_RATIO',
    'PARTIAL_EXIT_PCT', 'PNL_TRAIL_PCT',
    'MAX_POSITION_COUNT', 'MAX_HOLD_MINUTES',
    'EMA_FAST_PERIOD', 'EMA_SLOW_PERIOD',
    'RSI_PERIOD', 'VWAP_VOLUME_AVG_PERIOD',
    'BREAKOUT_LOOKBACK', 'BAVI_MIN_TICK_COUNT',
    'SHORT_MIN_CONFIDENCE', 'MIN_CONFIDENCE', 'MIN_AGREEMENT', 'SUPER_CONVICTION_THRESHOLD',
    'SCOUT_MAX_DYNAMIC',
]);

// All numeric keys (positive + non-negative)
const NUMERIC_KEYS = new Set([
    ...POSITIVE_KEYS,
    'PNL_TRAIL_FLOOR',           // 0 is valid (no floor)
    'VWAP_PRICE_BAND_PCT',
    'ORB_MIN_RANGE_PCT', 'ORB_MAX_RANGE_PCT', 'ORB_VOLUME_MULTIPLIER',
    'VWAP_VOLUME_MULTIPLIER',
    'BREAKOUT_VOLUME_MULTIPLIER', 'BREAKOUT_BB_PERIOD', 'BREAKOUT_BB_STDDEV',
    'BAVI_IMBALANCE_THRESHOLD', 'BAVI_STRONG_IMBALANCE',
    'RSI_OVERSOLD', 'RSI_OVERBOUGHT', 'RSI_EXTREME_OVERSOLD', 'RSI_EXTREME_OVERBOUGHT',
]);

/**
 * Validate a key+value pair before writing to Redis.
 * Mirrors the cross-field constraints enforced by the startup Zod schema.
 * @throws {Error} on any violation
 * @private
 */
async function validateSetting(key, value) {
    // ── Boolean keys ──────────────────────────────────────────────────────────
    if (BOOLEAN_KEYS.has(key)) {
        if (value !== 'true' && value !== 'false') {
            throw new Error(`${key} must be 'true' or 'false', got: "${value}"`);
        }
        return;
    }

    // ── Enum keys ─────────────────────────────────────────────────────────────
    if (ENUM_KEYS[key]) {
        if (!ENUM_KEYS[key].includes(value)) {
            throw new Error(`${key} must be one of [${ENUM_KEYS[key].join(', ')}], got: "${value}"`);
        }
        return;
    }

    // ── Numeric keys ─────────────────────────────────────────────────────────
    if (NUMERIC_KEYS.has(key)) {
        const num = Number(value);
        if (isNaN(num) || !isFinite(num)) {
            throw new Error(`${key} must be a number, got: "${value}"`);
        }
        if (POSITIVE_KEYS.has(key) && num <= 0) {
            throw new Error(`${key} must be > 0, got: ${num}`);
        }
        if (!POSITIVE_KEYS.has(key) && num < 0) {
            throw new Error(`${key} must be >= 0, got: ${num}`);
        }

        // ── Cross-field constraints ───────────────────────────────────────────
        // Re-check the startup Zod refine() constraints so /set cannot produce
        // a configuration the startup validator would have rejected.
        const redis = getRedis();

        if (key === 'MAX_DAILY_LOSS_PCT') {
            const ksRaw = await redis.hget(REDIS_KEY, 'KILL_SWITCH_DRAWDOWN_PCT');
            const ksPct = ksRaw !== null ? Number(ksRaw) : null;
            if (ksPct !== null && num > ksPct) {
                throw new Error(
                    `MAX_DAILY_LOSS_PCT (${num}) cannot exceed KILL_SWITCH_DRAWDOWN_PCT (${ksPct}). ` +
                    `Lower KILL_SWITCH_DRAWDOWN_PCT first or raise it simultaneously.`
                );
            }
        }

        if (key === 'KILL_SWITCH_DRAWDOWN_PCT') {
            const dlRaw = await redis.hget(REDIS_KEY, 'MAX_DAILY_LOSS_PCT');
            const dlPct = dlRaw !== null ? Number(dlRaw) : null;
            if (dlPct !== null && num < dlPct) {
                throw new Error(
                    `KILL_SWITCH_DRAWDOWN_PCT (${num}) must be >= MAX_DAILY_LOSS_PCT (${dlPct}).`
                );
            }
        }

        if (key === 'STOP_LOSS_PCT') {
            const trailRaw = await redis.hget(REDIS_KEY, 'TRAILING_STOP_PCT');
            const trailPct = trailRaw !== null ? Number(trailRaw) : null;
            if (trailPct !== null && num >= trailPct) {
                throw new Error(
                    `STOP_LOSS_PCT (${num}) must be < TRAILING_STOP_PCT (${trailPct}). ` +
                    `The hard stop must be tighter than the trail activation level.`
                );
            }
        }

        if (key === 'TRAILING_STOP_PCT') {
            const stopRaw = await redis.hget(REDIS_KEY, 'STOP_LOSS_PCT');
            const stopPct = stopRaw !== null ? Number(stopRaw) : null;
            if (stopPct !== null && num <= stopPct) {
                throw new Error(
                    `TRAILING_STOP_PCT (${num}) must be > STOP_LOSS_PCT (${stopPct}).`
                );
            }
        }
    }
}

export async function getLiveSetting(key, configFallback) {
    try {
        const raw = await getRedis().hget(REDIS_KEY, key);
        if (raw === null || raw === undefined) return configFallback;
        if (typeof configFallback === 'number') return Number(raw);
        if (typeof configFallback === 'boolean') return raw === 'true';
        return raw;
    } catch {
        return configFallback;
    }
}

export async function setLiveSetting(key, value) {
    if (!(key in DEFAULTS)) {
        throw new Error(
            `Unknown setting key: "${key}". ` +
            `Valid keys: ${Object.keys(DEFAULTS).join(', ')}`
        );
    }
    const strValue = String(value).trim();
    await validateSetting(key, strValue);
    await getRedis().hset(REDIS_KEY, key, strValue);
}

export async function getAllLiveSettings() {
    try {
        return await getRedis().hgetall(REDIS_KEY) || {};
    } catch {
        return {};
    }
}

export async function resetLiveSetting(key) {
    try {
        await getRedis().hdel(REDIS_KEY, key);
    } catch { /* non-fatal */ }
}

export async function hasActiveOverrides() {
    try {
        const all = await getAllLiveSettings();
        return Object.keys(all).length > 0;
    } catch {
        return false;
    }
}
