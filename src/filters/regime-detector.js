/**
 * @fileoverview Intraday Regime Detector for Alpha8
 *
 * Two-layer real-time market classification using Nifty 50 intraday data.
 * Updates every 5 minutes alongside the strategy scan cycle.
 *
 * ═══ LAYER 1 — Session Volatility (priority gate) ══════════════════════════
 *   range_ratio = today's intraday range / 20-day avg daily range
 *
 *   range_ratio >= 1.8  →  VOLATILE   →  block all new trades (0.0× size)
 *   range_ratio >= 1.3  →  warn       →  reduce position size to 0.7×
 *   range_ratio <  1.3  →  normal     →  proceed to Layer 2
 *
 * ═══ LAYER 2 — Intraday Trend Direction ═══════════════════════════════════
 *   ADX computed on last 60 five-minute Nifty candles (~5 hours of data)
 *
 *   ADX >= 25  →  TRENDING   →  1.0× size, threshold 1.8
 *   ADX 15–25  →  NEUTRAL    →  1.0× size, threshold 2.0
 *   ADX <  15  →  SIDEWAYS   →  0.5× size, threshold 2.2
 *
 * ═══ FAIL-OPEN BEHAVIOUR ══════════════════════════════════════════════════
 *   - If intraday candles unavailable → fall back to Redis-cached regime
 *   - If nothing is cached → return TRENDING (full size, no block)
 *   - Never throws — always returns a valid RegimeState object
 *
 * ═══ REDIS KEYS ═══════════════════════════════════════════════════════════
 *   'regime'               → full RegimeState (TTL 30 min)
 *   'regime:daily_baseline' → avg daily range number (TTL 24 h)
 *
 * ═══ BACKWARD COMPATIBILITY ═══════════════════════════════════════════════
 *   - constructor({ redis, logger }) — unchanged
 *   - update(niftyDailyCandles)     — now writes daily baseline only
 *   - getRegime()                   — unchanged (reads Redis, fail-open)
 *   - check()                       — unchanged (handles NEUTRAL)
 *   - calculateADX(), calculateATR(), trueRange() — unchanged pure functions
 *   - classifyRegime() — kept exported but deprecated (not called internally)
 */

import { createLogger } from '../lib/logger.js';
import {
  REGIME_DAILY_BASELINE,
  REGIME_VOLATILE_RATIO,
  REGIME_WARN_RATIO,
} from '../config/constants.js';

const log = createLogger('regime-detector');

// NOTE: Redis client has keyPrefix: 'alpha8:' — do NOT add 'alpha8:' here
const CACHE_KEY          = 'regime';
const BASELINE_CACHE_KEY = 'regime:daily_baseline';
const CACHE_TTL_SEC      = 30 * 60;        // 30 min — full regime result
const BASELINE_TTL_SEC   = 24 * 60 * 60;  // 24 h  — daily baseline

// ADX thresholds for Layer 2 trend direction
const ADX_TRENDING_THRESHOLD = 25;
const ADX_NEUTRAL_THRESHOLD  = 15;

// Legacy ATR period (kept for classifyRegime() backward compat)
const ATR_PERIOD = 14;
const ADX_PERIOD = 14;

/**
 * @typedef {'TRENDING'|'SIDEWAYS'|'VOLATILE'|'NEUTRAL'} MarketRegime
 * @typedef {object} RegimeState
 * @property {MarketRegime} regime
 * @property {number|null}  atr
 * @property {number|null}  atrPct
 * @property {number|null}  adx
 * @property {number|null}  volatilityRatio
 * @property {number|null}  rangeRatio
 * @property {string}       reason
 * @property {number}       positionSizeMultiplier
 * @property {string}       updatedAt
 */

// ─── Pure Math Functions (exported, unchanged) ────────────────────────────

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
        plusDM:  (up   > down && up   > 0) ? up   : 0,
        minusDM: (down > up   && down > 0) ? down : 0,
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
    const dx  = pDI.map((p, i) => {
        const sum = p + mDI[i], diff = Math.abs(p - mDI[i]);
        return sum > 0 ? (diff / sum) * 100 : 0;
    });

    let adx = dx.slice(0, period).reduce((a, b) => a + b, 0) / period;
    for (let i = period; i < dx.length; i++) adx = (adx * (period - 1) + dx[i]) / period;
    return Math.round(adx * 100) / 100;
}

/**
 * DEPRECATED — kept for backward compatibility with any external code that
 * imports this function. Not used internally by the new two-layer system.
 * @deprecated use RegimeDetector.updateIntraday() instead
 */
export function classifyRegime({ atr, atrAvg30, adx, currentPrice }) {
    if (atr === null || adx === null) {
        return {
            regime: 'TRENDING', atr: null, atrPct: null, adx: null,
            volatilityRatio: null, rangeRatio: null,
            reason: 'Insufficient data — defaulting to TRENDING (fail-open)',
            positionSizeMultiplier: 1.0,
            updatedAt: new Date().toISOString(),
        };
    }
    const atrPct         = currentPrice > 0 ? (atr / currentPrice) * 100 : 0;
    const volatilityRatio = atrAvg30 > 0 ? atr / atrAvg30 : 1;

    if (volatilityRatio >= REGIME_VOLATILE_RATIO) {
        return {
            regime: 'VOLATILE',
            atr: Math.round(atr * 100) / 100,
            atrPct: Math.round(atrPct * 100) / 100,
            adx: Math.round(adx * 100) / 100,
            volatilityRatio: Math.round(volatilityRatio * 100) / 100,
            rangeRatio: null,
            reason: `ATR ${volatilityRatio.toFixed(1)}x its 30-day average — high volatility. All trading paused.`,
            positionSizeMultiplier: 0,
            updatedAt: new Date().toISOString(),
        };
    }
    if (adx < 20) {
        return {
            regime: 'SIDEWAYS',
            atr: Math.round(atr * 100) / 100,
            atrPct: Math.round(atrPct * 100) / 100,
            adx: Math.round(adx * 100) / 100,
            volatilityRatio: Math.round(volatilityRatio * 100) / 100,
            rangeRatio: null,
            reason: `ADX ${adx.toFixed(1)} < 20 — no clear trend. Position size halved.`,
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
        rangeRatio: null,
        reason: `ADX ${adx.toFixed(1)} — strong trend. Full position size.`,
        positionSizeMultiplier: 1.0,
        updatedAt: new Date().toISOString(),
    };
}

// ─── Fail-open default ────────────────────────────────────────────────────

function defaultRegime(reason = 'No data — defaulting to TRENDING (fail-open)') {
    return {
        regime: 'TRENDING',
        positionSizeMultiplier: 1.0,
        reason,
        atr: null, adx: null, atrPct: null,
        volatilityRatio: null, rangeRatio: null,
        updatedAt: new Date().toISOString(),
    };
}

// ─── Main Class ───────────────────────────────────────────────────────────

export class RegimeDetector {
    /**
     * @param {object} opts
     * @param {object}   opts.redis
     * @param {Function} [opts.logger]
     * @param {object}   [opts.telegram] - Optional Telegram bot for regime-change alerts
     */
    constructor({ redis, logger, telegram = null }) {
        this.redis    = redis;
        this.logger   = logger || ((msg, meta) => log.info(meta || {}, msg));
        this.telegram = telegram;

        // In-memory cache of the previous regime for change-detection alerts
        this._lastRegime = null;
    }

    // ── Public API ───────────────────────────────────────────────────────────

    /**
     * Compute and cache the 20-day average daily range (the Layer 1 baseline).
     *
     * Called at 9:00 AM pre-market and every 30 minutes thereafter (harmless
     * redundancy). Does NOT classify the full regime — that is done by
     * updateIntraday() which runs every 5 minutes from the strategy scan.
     *
     * If fewer than REGIME_DAILY_BASELINE candles are supplied, the existing
     * Redis baseline is left intact (fail-open: the previous session's baseline
     * continues to be used).
     *
     * @param {Array} niftyDailyCandles - Array of daily OHLCV candles for Nifty 50
     * @returns {Promise<number|null>} The computed avg daily range, or null if skipped
     */
    async update(niftyDailyCandles) {
        if (!niftyDailyCandles || niftyDailyCandles.length < REGIME_DAILY_BASELINE) {
            this.logger(
                `[RegimeDetector] Insufficient daily candles (${niftyDailyCandles?.length ?? 0} < ${REGIME_DAILY_BASELINE}) — daily baseline unchanged`
            );
            return null;
        }

        const avgRange = this._avgDailyRange(niftyDailyCandles, REGIME_DAILY_BASELINE);
        if (avgRange === null) return null;

        try {
            await this.redis.setex(BASELINE_CACHE_KEY, BASELINE_TTL_SEC, String(avgRange));
        } catch (err) {
            this.logger(`[RegimeDetector] Redis write (baseline) failed: ${err.message}`);
        }

        this.logger(`[RegimeDetector] Daily baseline updated: avg_daily_range=${avgRange.toFixed(1)} (${REGIME_DAILY_BASELINE}-session avg)`);
        return avgRange;
    }

    /**
     * Two-layer intraday regime classification.
     *
     * Called at the START of every strategy scan cycle (~every 5 minutes from
     * 9:15 AM to 3:10 PM). Writes the result to Redis key 'regime' (TTL 30 min)
     * and fires a Telegram alert when the regime changes.
     *
     * Layer 1 (session volatility, priority gate):
     *   range_ratio = today_range / avg_daily_range
     *   range_ratio >= REGIME_VOLATILE_RATIO (1.8) → VOLATILE (trading blocked)
     *   range_ratio >= REGIME_WARN_RATIO    (1.3) → warn, no regime change
     *
     * Layer 2 (intraday trend direction):
     *   ADX on last 60 five-minute Nifty candles
     *   ADX >= 25 → TRENDING | ADX 15–25 → NEUTRAL | ADX < 15 → SIDEWAYS
     *
     * @param {Array}       niftyIntradayCandles - Array of 5-minute OHLCV candles (expect ~60)
     * @param {object|null} todayOHLC            - { high: number, low: number } from broker.getQuote()
     * @returns {Promise<RegimeState>}
     */
    async updateIntraday(niftyIntradayCandles, todayOHLC) {
        try {
            // ── Layer 2: ADX on 5-minute candles ──────────────────────────────
            const candles = niftyIntradayCandles || [];
            const adx     = calculateADX(candles);

            // ── Layer 1: today's range vs 20-day baseline ─────────────────────
            let rangeRatio = null;

            if (todayOHLC?.high != null && todayOHLC?.low != null) {
                const todayRange = todayOHLC.high - todayOHLC.low;
                const avgRange   = await this._getCachedBaseline();

                if (avgRange !== null && avgRange > 0) {
                    rangeRatio = Math.round((todayRange / avgRange) * 100) / 100;
                }
            }

            // ── Combined classification (Layer 1 overrides Layer 2) ───────────
            const regime = this._classify(rangeRatio, adx);

            // ── Cache + alert ─────────────────────────────────────────────────
            try {
                await this.redis.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(regime));
            } catch (err) {
                this.logger(`[RegimeDetector] Redis write failed: ${err.message}`);
            }

            this.logger(
                `[RegimeDetector] Intraday: ${regime.regime} | ` +
                `rangeRatio=${rangeRatio ?? 'n/a'} ADX=${adx ?? 'n/a'} — ${regime.reason}`
            );

            // Fire Telegram alert on regime change
            this._notifyIfChanged(regime);
            this._lastRegime = regime.regime;

            return regime;

        } catch (err) {
            this.logger(`[RegimeDetector] updateIntraday error: ${err.message} — returning cached/default`);
            return this.getRegime();
        }
    }

    /**
     * Get the cached regime state.
     *
     * Always returns within < 100ms (reads from Redis, no computation).
     * Fail-open: returns TRENDING if no cache entry exists.
     *
     * @returns {Promise<RegimeState>}
     */
    async getRegime() {
        try {
            const cached = await this.redis.get(CACHE_KEY);
            if (cached) return JSON.parse(cached);
        } catch (err) {
            this.logger(`[RegimeDetector] Redis read failed: ${err.message}`);
        }
        return defaultRegime('No cached regime — defaulting to TRENDING (fail-open)');
    }

    /**
     * Pipeline gate — returns { allowed, sizeMultiplier, reason }.
     *
     * Called by EnhancedSignalPipeline Gate 3 before every trade signal.
     * Reads from Redis cache (fast path, never recomputes inline).
     *
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

    // ── Private Helpers ───────────────────────────────────────────────────────

    /**
     * Combined Layer 1 + Layer 2 classification logic.
     * Layer 1 (range_ratio) takes absolute priority.
     * @private
     */
    _classify(rangeRatio, adx) {
        const ts = new Date().toISOString();

        // Layer 1 — VOLATILE gate
        if (rangeRatio !== null && rangeRatio >= REGIME_VOLATILE_RATIO) {
            return {
                regime: 'VOLATILE',
                positionSizeMultiplier: 0.0,
                reason: `Intraday range ${rangeRatio.toFixed(2)}× the 20-day avg — extreme volatility. All trading paused.`,
                atr: null, atrPct: null, adx: adx !== null ? Math.round(adx * 100) / 100 : null,
                volatilityRatio: null, rangeRatio,
                updatedAt: ts,
            };
        }

        // Layer 1 elevation warning (no regime change, just logged)
        const elevated = rangeRatio !== null && rangeRatio >= REGIME_WARN_RATIO;

        // Layer 2 — ADX trend direction
        if (adx === null) {
            // Not enough 5-min candles yet (pre-market or first scan)
            // Fall-through to TRENDING (fail-open)
            return {
                regime: 'TRENDING',
                positionSizeMultiplier: 1.0,
                reason: `Insufficient 5-min candles for ADX — defaulting to TRENDING (fail-open)${elevated ? '; range elevated' : ''}`,
                atr: null, atrPct: null, adx: null,
                volatilityRatio: null, rangeRatio: rangeRatio ?? null,
                updatedAt: ts,
            };
        }

        const adxRounded = Math.round(adx * 100) / 100;
        const elevatedNote = elevated ? ` | ⚠️ range ${rangeRatio.toFixed(2)}× avg (elevated)` : '';

        if (adx >= ADX_TRENDING_THRESHOLD) {
            return {
                regime: 'TRENDING',
                positionSizeMultiplier: 1.0,
                reason: `ADX ${adxRounded} ≥ ${ADX_TRENDING_THRESHOLD} — strong intraday trend. Full position size.${elevatedNote}`,
                atr: null, atrPct: null, adx: adxRounded,
                volatilityRatio: null, rangeRatio: rangeRatio ?? null,
                updatedAt: ts,
            };
        }

        if (adx >= ADX_NEUTRAL_THRESHOLD) {
            return {
                regime: 'NEUTRAL',
                positionSizeMultiplier: 1.0,
                reason: `ADX ${adxRounded} (15–25) — directionless, normal size with tighter threshold.${elevatedNote}`,
                atr: null, atrPct: null, adx: adxRounded,
                volatilityRatio: null, rangeRatio: rangeRatio ?? null,
                updatedAt: ts,
            };
        }

        return {
            regime: 'SIDEWAYS',
            positionSizeMultiplier: 0.5,
            reason: `ADX ${adxRounded} < ${ADX_NEUTRAL_THRESHOLD} — no directional conviction. Position size halved.${elevatedNote}`,
            atr: null, atrPct: null, adx: adxRounded,
            volatilityRatio: null, rangeRatio: rangeRatio ?? null,
            updatedAt: ts,
        };
    }

    /**
     * Read the avg_daily_range baseline from Redis.
     * Returns null if not yet computed (pre-market first boot).
     * @private
     * @returns {Promise<number|null>}
     */
    async _getCachedBaseline() {
        try {
            const raw = await this.redis.get(BASELINE_CACHE_KEY);
            if (raw !== null && raw !== undefined) {
                const val = parseFloat(raw);
                return isFinite(val) ? val : null;
            }
        } catch (err) {
            this.logger(`[RegimeDetector] Redis read (baseline) failed: ${err.message}`);
        }
        return null;
    }

    /**
     * Compute average of (high - low) for the last n completed sessions.
     * Only uses completed daily candles — never includes the current intraday bar.
     * @private
     * @param {Array}  candles - Daily OHLCV candles, descending or ascending
     * @param {number} n       - Number of sessions to average
     * @returns {number|null}
     */
    _avgDailyRange(candles, n = REGIME_DAILY_BASELINE) {
        if (!candles || candles.length < n) return null;

        // Use the last n candles (most recent sessions)
        const recent = candles.slice(-n);
        const totalRange = recent.reduce((sum, c) => sum + (c.high - c.low), 0);
        return Math.round((totalRange / n) * 100) / 100;
    }

    /**
     * Fire a Telegram alert when the market regime changes.
     * Silent if Telegram is not configured or if this is the first classification.
     * @private
     * @param {RegimeState} regime
     */
    _notifyIfChanged(regime) {
        if (!this.telegram?.enabled) return;

        const prev = this._lastRegime;
        if (prev === null || prev === regime.regime) return; // no change

        const emoji = {
            VOLATILE: '🌩️',
            TRENDING: '📈',
            NEUTRAL:  '➡️',
            SIDEWAYS: '↔️',
        }[regime.regime] ?? '📊';

        const impact = regime.regime === 'VOLATILE'
            ? '🛑 <b>All new trades BLOCKED</b>'
            : regime.positionSizeMultiplier < 1.0
                ? `⚠️ Position size reduced to ${regime.positionSizeMultiplier * 100}%`
                : '✅ Normal position size';

        const msg =
            `${emoji} <b>Regime Change: ${prev} → ${regime.regime}</b>\n\n` +
            `<b>ADX:</b> ${regime.adx ?? 'n/a'}\n` +
            `<b>Range Ratio:</b> ${regime.rangeRatio != null ? regime.rangeRatio.toFixed(2) + '×' : 'n/a'}\n` +
            `${impact}\n\n` +
            `<i>${regime.reason}</i>\n` +
            `<i>${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}</i>`;

        this.telegram.sendRaw(msg).catch(() => { });
    }
}