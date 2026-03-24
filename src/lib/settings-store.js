/**
 * @fileoverview Live Settings Store for Alpha8
 *
 * Redis-backed runtime parameter overrides.
 * Parameters set here take effect on the next scan cycle.
 *
 * Storage: Redis hash at key `live:settings` (prefixed to `alpha8:live:settings`)
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

    // ── Signal Consensus ────────────────────────────────────────────────────────
    MIN_CONFIDENCE: null,
    MIN_AGREEMENT: null,
    SUPER_CONVICTION_THRESHOLD: null,
};

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
    await getRedis().hset(REDIS_KEY, key, String(value));
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