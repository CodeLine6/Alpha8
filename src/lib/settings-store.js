import { getRedis } from './redis.js';

const DEFAULTS = {
    // Risk
    STOP_LOSS_PCT: null,        // null = use config
    TRAILING_STOP_PCT: null,
    MAX_POSITION_COUNT: null,
    MAX_DAILY_LOSS_PCT: null,
    PER_TRADE_STOP_LOSS_PCT: null,
    TRADING_CAPITAL: null,
    // Strategy — EMA
    EMA_FAST_PERIOD: null,
    EMA_SLOW_PERIOD: null,
    // Strategy — RSI
    RSI_PERIOD: null,
    RSI_OVERSOLD: null,
    RSI_OVERBOUGHT: null,
    // Strategy — VWAP
    VWAP_VOLUME_MULTIPLIER: null,
    // Strategy — Breakout
    BREAKOUT_LOOKBACK: null,
    BREAKOUT_VOLUME_MULTIPLIER: null,
};

const REDIS_KEY = 'live:settings';

export async function getLiveSetting(key, configFallback) {
    try {
        const raw = await getRedis().hget(REDIS_KEY, key);
        if (raw === null) return configFallback;
        // Coerce to same type as fallback
        if (typeof configFallback === 'number') return Number(raw);
        if (typeof configFallback === 'boolean') return raw === 'true';
        return raw;
    } catch {
        return configFallback;
    }
}

export async function setLiveSetting(key, value) {
    if (!(key in DEFAULTS)) throw new Error(`Unknown setting: ${key}`);
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
    await getRedis().hdel(REDIS_KEY, key);
}