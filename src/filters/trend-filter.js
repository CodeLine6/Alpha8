/**
 * @fileoverview Trend Filter for Quant8
 *
 * Checks whether a stock is in a healthy uptrend before allowing a BUY signal.
 * Uses 20-day and 50-day Simple Moving Averages on daily close prices.
 *
 * WHY THIS MATTERS (plain English):
 *   The 4 strategies only look at today's chart. A stock could look "oversold"
 *   on the 5-minute chart but be in a 3-month collapse on the daily chart.
 *   This filter makes sure we only BUY stocks that are actually going up in
 *   the bigger picture — not fighting a downtrend.
 *
 * RULES:
 *   BUY allowed  → price > SMA20 > SMA50 (all three stacked bullishly)
 *   BUY blocked  → price < SMA20 < SMA50 (bearish stack)
 *   BUY blocked  → any neutral/choppy arrangement (SMA20 ≈ SMA50)
 *   SELL          → always allowed (we always want to be able to exit)
 *
 * DATA: 70 days of daily candles fetched at 9:00 AM, cached 6 hours.
 *       Uses existing fetchHistoricalData (Kite → Yahoo Finance fallback).
 *
 * FAIL-OPEN: If data is unavailable the filter allows the signal through.
 *            The risk manager is the hard safety net.
 */

import { createLogger } from '../lib/logger.js';
import { fetchHistoricalData } from '../data/historical-data.js';

const log = createLogger('trend-filter');

// NOTE: Redis client has keyPrefix: 'quant8:' — do NOT add 'quant8:' here
const CACHE_PREFIX = 'trend:';
const CACHE_TTL_SEC = 6 * 60 * 60; // 6 hours — refreshed at pre-market
const SMA_SHORT_DAYS = 20;
const SMA_LONG_DAYS = 50;
const HISTORY_DAYS = 70; // fetch 70 days → enough for 50-day SMA with buffer

/**
 * @typedef {object} TrendState
 * @property {number|null}  sma20
 * @property {number|null}  sma50
 * @property {number|null}  currentPrice
 * @property {boolean}      bullish
 * @property {boolean}      bearish
 * @property {'BULLISH'|'BEARISH'|'NEUTRAL'} regime
 * @property {string}       updatedAt
 */

/**
 * Calculate Simple Moving Average from an array of candles.
 * @param {Array}  candles  - sorted chronologically, each has {close}
 * @param {number} period
 * @returns {number|null}
 */
export function calculateSMA(candles, period) {
    if (candles.length < period) return null;
    const window = candles.slice(-period);
    return window.reduce((s, c) => s + c.close, 0) / period;
}

/**
 * Analyse trend from daily candles.
 * @param {Array} dailyCandles
 * @returns {TrendState}
 */
export function analyseTrend(dailyCandles) {
    if (!dailyCandles || dailyCandles.length === 0) {
        return {
            sma20: null, sma50: null, currentPrice: null,
            bullish: false, bearish: false, regime: 'NEUTRAL',
            updatedAt: new Date().toISOString(),
        };
    }

    const sma20 = calculateSMA(dailyCandles, SMA_SHORT_DAYS);
    const sma50 = calculateSMA(dailyCandles, SMA_LONG_DAYS);
    const currentPrice = dailyCandles[dailyCandles.length - 1].close;

    const bullish = sma20 !== null && sma50 !== null &&
        currentPrice > sma20 && currentPrice > sma50 && sma20 > sma50;

    const bearish = sma20 !== null && sma50 !== null &&
        currentPrice < sma20 && currentPrice < sma50 && sma20 < sma50;

    const regime = bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL';

    return {
        sma20: sma20 ? Math.round(sma20 * 100) / 100 : null,
        sma50: sma50 ? Math.round(sma50 * 100) / 100 : null,
        currentPrice: Math.round(currentPrice * 100) / 100,
        bullish, bearish, regime,
        updatedAt: new Date().toISOString(),
    };
}

/**
 * TrendFilter — pre-market warm-up + per-signal gate.
 */
export class TrendFilter {
    /**
     * @param {object} opts
     * @param {object}   opts.redis               - ioredis client
     * @param {object}   [opts.broker]            - BrokerManager instance (null OK → Yahoo fallback)
     * @param {object}   [opts.instrumentManager] - InstrumentManager for token lookup
     * @param {Function} [opts.logger]
     */
    constructor({ redis, broker = null, instrumentManager = null, logger }) {
        this.redis = redis;
        this.broker = broker;
        this.instrumentManager = instrumentManager;
        this.logger = logger || ((msg, meta) => log.info(meta || {}, msg));
    }

    /**
     * Pre-warm cache for all watchlist symbols.
     * Called at 9:00 AM IST before trading starts.
     * @param {string[]} symbols
     */
    async warmUp(symbols) {
        this.logger(`[TrendFilter] Warming up ${symbols.length} symbols...`);
        const results = await Promise.allSettled(symbols.map(s => this._refresh(s)));
        const failed = results.filter(r => r.status === 'rejected').length;
        if (failed > 0) {
            this.logger(`[TrendFilter] ${failed}/${symbols.length} warm-up failures (fail-open)`);
        }
        this.logger('[TrendFilter] Warm-up complete');
    }

    /**
     * Main gate — call this once per signal in the pipeline.
     *
     * @param {string} symbol
     * @param {'BUY'|'SELL'|'HOLD'} signal
     * @returns {Promise<{ allowed: boolean, reason: string, trend: TrendState|null }>}
     */
    async check(symbol, signal) {
        if (signal === 'HOLD' || signal === 'SELL') {
            return { allowed: true, reason: `${signal} always passes trend filter`, trend: null };
        }

        const trend = await this._getCached(symbol);

        if (trend.sma20 === null || trend.sma50 === null) {
            return {
                allowed: true,
                reason: `No trend data for ${symbol} — allowing (fail-open)`,
                trend,
            };
        }

        if (trend.bullish) {
            return {
                allowed: true,
                reason: `${symbol} BULLISH — price ${trend.currentPrice} > SMA20 ${trend.sma20} > SMA50 ${trend.sma50}`,
                trend,
            };
        }

        const reason = trend.bearish
            ? `${symbol} BEARISH (price ${trend.currentPrice} < SMA20 ${trend.sma20} < SMA50 ${trend.sma50}) — BUY blocked`
            : `${symbol} trend NEUTRAL (sideways) — BUY blocked`;

        return { allowed: false, reason, trend };
    }

    // ── Private ─────────────────────────────────────────────────────────────

    async _refresh(symbol) {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - HISTORY_DAYS);

        const fmt = (d) => d.toISOString().split('T')[0];

        try {
            const instrumentToken = this.instrumentManager?.getToken(symbol) ?? null;

            const candles = await fetchHistoricalData({
                broker: this.broker,     // null → Yahoo Finance fallback
                instrumentToken,
                symbol,
                interval: 'day',
                from: fmt(from),
                to: fmt(to),
                cacheTTL: CACHE_TTL_SEC,
                forceRefresh: true,
            });

            const trend = analyseTrend(candles);
            await this.redis.setex(`${CACHE_PREFIX}${symbol}`, CACHE_TTL_SEC, JSON.stringify(trend));

            this.logger(`[TrendFilter] ${symbol}: ${trend.regime} | SMA20=${trend.sma20} SMA50=${trend.sma50} Price=${trend.currentPrice}`);
            return trend;
        } catch (err) {
            this.logger(`[TrendFilter] Failed to refresh ${symbol}: ${err.message}`);
            return { regime: 'NEUTRAL', bullish: false, bearish: false, sma20: null, sma50: null, currentPrice: null, updatedAt: new Date().toISOString() };
        }
    }

    async _getCached(symbol) {
        try {
            const cached = await this.redis.get(`${CACHE_PREFIX}${symbol}`);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            this.logger(`[TrendFilter] Redis read failed for ${symbol}: ${err.message}`);
        }
        // Cache miss → try a fresh fetch, otherwise fail-open
        try {
            return await this._refresh(symbol);
        } catch {
            return { regime: 'NEUTRAL', bullish: false, bearish: false, sma20: null, sma50: null, currentPrice: null, updatedAt: null };
        }
    }
}