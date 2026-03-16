/**
 * @fileoverview Regime Detector for Alpha8
 *
 * Measures the overall market "weather" using the Nifty 50 index.
 * Classifies the market into one of three states every 30 minutes.
 *
 * STATES:
 *   TRENDING  → Clear direction (ADX > 25). Trade normally, full size.
 *   SIDEWAYS  → No direction (ADX < 20). Trade at half size. Avoid EMA/Breakout.
 *   VOLATILE  → ATR spiking 1.8x its 30-day average. Stop all trading.
 *
 * MEASUREMENTS:
 *   ATR (Average True Range)   — how large are the daily price swings?
 *   ADX (Average Directional Index) — is there a clear direction?
 *
 * WHY NIFTY 50:
 *   If the whole market is in a storm, it doesn't matter that RELIANCE looks
 *   fine on its own chart. All boats rise and fall with the tide.
 *
 * FAIL-OPEN: If insufficient data, defaults to TRENDING (full size).
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('regime-detector');

// NOTE: Redis client has keyPrefix: 'alpha8:' — do NOT add 'alpha8:' here
const CACHE_KEY = 'regime';
const CACHE_TTL_SEC = 30 * 60; // 30 min

// ADX thresholds for regime classification (Fix N10)
// ADX < 20      → SIDEWAYS  (no directional conviction, 0.5× position size)
// ADX 20 - 25   → TRENDING  (weak trend, treated as full trend — conservative)
// ADX >= 25     → TRENDING  (strong confirmed trend, 1.0× position size)
const ADX_SIDEWAYS_THRESHOLD = 20;
const VOLATILITY_SPIKE_RATIO = 1.8;
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;

/**
 * @typedef {'TRENDING'|'SIDEWAYS'|'VOLATILE'} MarketRegime
 * @typedef {object} RegimeState
 * @property {MarketRegime} regime
 * @property {number|null}  atr
 * @property {number|null}  atrPct
 * @property {number|null}  adx
 * @property {number|null}  volatilityRatio
 * @property {string}       reason
 * @property {number}       positionSizeMultiplier
 * @property {string}       updatedAt
 */

export function trueRange(candle, prevCandle) {
    if (!prevCandle) return candle.high - candle.low;
    return Math.max(
        candle.high - candle.low,
        Math.abs(candle.high - prevCandle.close),
        Math.abs(candle.low - prevCandle.close)
    );
}

export function calculateATR(candles, period = ATR_PERIOD) {
    if (candles.length < period + 1) return null;
    let atr = 0;
    for (let i = 1; i <= period; i++) atr += trueRange(candles[i], candles[i - 1]);
    atr /= period;
    for (let i = period + 1; i < candles.length; i++) {
        atr = (atr * (period - 1) + trueRange(candles[i], candles[i - 1])) / period;
    }
    return Math.round(atr * 100) / 100;
}

function directionalMovement(candle, prev) {
    const up = candle.high - prev.high;
    const down = prev.low - candle.low;
    return {
        plusDM: (up > down && up > 0) ? up : 0,
        minusDM: (down > up && down > 0) ? down : 0,
    };
}

export function calculateADX(candles, period = ADX_PERIOD) {
    if (candles.length < period * 2 + 1) return null;

    const trs = [], pDMs = [], mDMs = [];
    for (let i = 1; i < candles.length; i++) {
        trs.push(trueRange(candles[i], candles[i - 1]));
        const { plusDM, minusDM } = directionalMovement(candles[i], candles[i - 1]);
        pDMs.push(plusDM);
        mDMs.push(minusDM);
    }

    const smooth = (arr, p) => {
        let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
        const r = [s];
        for (let i = p; i < arr.length; i++) { s = s - s / p + arr[i]; r.push(s); }
        return r;
    };

    const sTR = smooth(trs, period), sPDM = smooth(pDMs, period), sMDM = smooth(mDMs, period);

    const pDI = sPDM.map((v, i) => sTR[i] > 0 ? (v / sTR[i]) * 100 : 0);
    const mDI = sMDM.map((v, i) => sTR[i] > 0 ? (v / sTR[i]) * 100 : 0);
    const dx = pDI.map((p, i) => {
        const sum = p + mDI[i], diff = Math.abs(p - mDI[i]);
        return sum > 0 ? (diff / sum) * 100 : 0;
    });

    let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
    return Math.round(adx * 100) / 100;
}

export function classifyRegime({ atr, atrAvg30, adx, currentPrice }) {
    if (atr === null || adx === null) {
        return {
            regime: 'TRENDING', atr: null, atrPct: null, adx: null,
            volatilityRatio: null,
            reason: 'Insufficient data — defaulting to TRENDING (fail-open)',
            positionSizeMultiplier: 1.0,
            updatedAt: new Date().toISOString(),
        };
    }

    const atrPct = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    const volatilityRatio = atrAvg30 > 0 ? atr / atrAvg30 : 1;

    if (volatilityRatio >= VOLATILITY_SPIKE_RATIO) {
        return {
            regime: 'VOLATILE',
            atr: Math.round(atr * 100) / 100,
            atrPct: Math.round(atrPct * 100) / 100,
            adx: Math.round(adx * 100) / 100,
            volatilityRatio: Math.round(volatilityRatio * 100) / 100,
            reason: `ATR ${volatilityRatio.toFixed(1)}x its 30-day average — high volatility. All trading paused.`,
            positionSizeMultiplier: 0,
            updatedAt: new Date().toISOString(),
        };
    }

    if (adx < ADX_SIDEWAYS_THRESHOLD) {
        return {
            regime: 'SIDEWAYS',
            atr: Math.round(atr * 100) / 100,
            atrPct: Math.round(atrPct * 100) / 100,
            adx: Math.round(adx * 100) / 100,
            volatilityRatio: Math.round(volatilityRatio * 100) / 100,
            reason: `ADX ${adx.toFixed(1)} < ${ADX_SIDEWAYS_THRESHOLD} — no clear trend. Position size halved.`,
            positionSizeMultiplier: 0.5,
            updatedAt: new Date().toISOString(),
        };
    }

    return {
        regime: 'TRENDING',
        atr: Math.round(atr * 100) / 100,
        atrPct: Math.round(atrPct * 100) / 100,
        adx: Math.round(adx * 100) / 100,
        volatilityRatio: Math.round(volatilityRatio * 100) / 100,
        reason: `ADX ${adx.toFixed(1)} — strong trend. Full position size.`,
        positionSizeMultiplier: 1.0,
        updatedAt: new Date().toISOString(),
    };
}

export class RegimeDetector {
    /**
     * @param {object} opts
     * @param {object}   opts.redis
     * @param {Function} [opts.logger]
     */
    constructor({ redis, logger }) {
        this.redis = redis;
        this.logger = logger || ((msg, meta) => log.info(meta || {}, msg));
    }

    /**
     * Compute and cache regime from Nifty 50 daily candles.
     * Called at 9:00 AM and every 30 min during trading.
     * @param {Array} niftyCandles
     * @returns {Promise<RegimeState>}
     */
    async update(niftyCandles) {
        if (!niftyCandles || niftyCandles.length < 30) {
            this.logger('[RegimeDetector] Insufficient Nifty candles — skipping update');
            return this.getRegime();
        }

        const atr = calculateATR(niftyCandles, ATR_PERIOD);
        const adx = calculateADX(niftyCandles, ADX_PERIOD);
        const atrAvg30 = this._atrAvg30(niftyCandles);
        const currentPrice = niftyCandles[niftyCandles.length - 1]?.close ?? 0;

        const regime = classifyRegime({ atr, atrAvg30, adx, currentPrice });

        try {
            await this.redis.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(regime));
        } catch (err) {
            this.logger(`[RegimeDetector] Redis write failed: ${err.message}`);
        }

        this.logger(`[RegimeDetector] Market: ${regime.regime} | ADX=${regime.adx} VR=${regime.volatilityRatio}x — ${regime.reason}`);
        return regime;
    }

    /** Get cached regime (fail-open: TRENDING if no cache). */
    async getRegime() {
        try {
            const cached = await this.redis.get(CACHE_KEY);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            this.logger(`[RegimeDetector] Redis read failed: ${err.message}`);
        }
        return {
            regime: 'TRENDING', positionSizeMultiplier: 1.0,
            reason: 'No cached regime — defaulting to TRENDING (fail-open)',
            atr: null, adx: null, atrPct: null, volatilityRatio: null, updatedAt: null,
        };
    }

    /**
     * Pipeline gate — returns allowed + positionSizeMult.
     * @returns {Promise<{ allowed: boolean, sizeMultiplier: number, reason: string }>}
     */
    async check() {
        const regime = await this.getRegime();
        if (regime.regime === 'VOLATILE') {
            return {
                allowed: false, sizeMultiplier: 0,
                reason: `🌩️ Market VOLATILE — all trading paused. ${regime.reason}`,
            };
        }
        return {
            allowed: true,
            sizeMultiplier: regime.positionSizeMultiplier,
            reason: `Market is ${regime.regime} (${regime.reason})`,
        };
    }

    _atrAvg30(candles) {
        if (candles.length < 31) return null;
        const recent = candles.slice(-31);
        const atrs = [];
        for (let i = 1; i < recent.length; i++) atrs.push(trueRange(recent[i], recent[i - 1]));
        return atrs.reduce((s, v) => s + v, 0) / atrs.length;
    }
}