/**
 * @fileoverview Opening Range Breakout (ORB) Strategy for Alpha8
 *
 * CONCEPT:
 * The opening range (9:15–9:45 AM IST) is the period of initial price
 * discovery after overnight news is absorbed. The high and low of this
 * range represent short-term supply and demand equilibrium.
 *
 * When price breaks convincingly above the OR high with volume, institutional
 * buyers are driving the move — it's not retail noise. Similarly for breaks
 * below OR low.
 *
 * WHY 30 MINUTES (not 15):
 * NSE's first 15 minutes (9:15–9:30) has the highest noise-to-signal ratio
 * of the day. Algos hunt stops, gaps get filled, retail panic-sells.
 * The 9:30–9:45 window sees institutional flow begin to dominate.
 * A 30-minute range produces higher-quality, more reliable breakout levels.
 *
 * GROUP: REVERSAL
 * ORB identifies a structural price level (the opening equilibrium) and
 * trades the departure from it. Pairs correctly with momentum strategies.
 *
 * SIGNAL RULES:
 *   BUY:  candle CLOSES above OR high
 *         AND candle volume >= 1.5× average of prior 10 candles
 *         AND current time >= 09:45 IST
 *         AND current time <= 14:00 IST (no late-day breakouts)
 *         AND OR range is within acceptable bounds (0.3%–3.0% of price)
 *
 *   SELL: candle CLOSES below OR low
 *         (same volume and time conditions)
 *
 *   HOLD: OR not yet complete, range too tight/wide, or no breakout
 */

import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('orb-strategy');

// ── Configuration defaults ─────────────────────────────────────────────────

const ORB_WINDOW_CANDLES = 6;    // 6 × 5min = 30 minutes (9:15–9:45)
const MIN_RANGE_PCT = 0.30; // OR must be at least 0.30% of price
const MAX_RANGE_PCT = 3.00; // OR cannot be wider than 3.00% of price
const VOLUME_MULTIPLIER = 1.5;  // breakout candle volume must be 1.5× avg
const VOLUME_LOOKBACK = 10;   // candles to compute avg volume
const LAST_SIGNAL_HOUR_IST = 14;   // no new signals after 2:00 PM IST
const LAST_SIGNAL_MIN_IST = 0;

export class ORBStrategy {
    /**
     * @param {Object} [params]
     * @param {number} [params.orbWindowCandles=6]   number of 5-min candles in OR
     * @param {number} [params.minRangePct=0.30]
     * @param {number} [params.maxRangePct=3.00]
     * @param {number} [params.volumeMultiplier=1.5]
     * @param {Function} [params.getLiveSetting]
     */
    constructor(params = {}) {
        this.name = 'ORB';
        this.orbWindowCandles = params.orbWindowCandles ?? ORB_WINDOW_CANDLES;
        this.minRangePct = params.minRangePct ?? MIN_RANGE_PCT;
        this.maxRangePct = params.maxRangePct ?? MAX_RANGE_PCT;
        this.volumeMultiplier = params.volumeMultiplier ?? VOLUME_MULTIPLIER;
        this.volumeLookback = params.volumeLookback ?? VOLUME_LOOKBACK;
        this._getLiveSetting = params.getLiveSetting ?? null;

        // Minimum candles needed: OR window + volume lookback + 1 signal candle
        this.minCandles = this.orbWindowCandles + this.volumeLookback + 1;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Analyze candles and return a signal.
     * @param {Array<{open,high,low,close,volume,date}>} candles
     *   Most recent candle is candles[candles.length - 1].
     *   Candles must be 5-minute interval.
     * @returns {{ signal: string, confidence: number, reason: string, strategy: string, meta: Object }}
     */
    analyze(candles) {
        const hold = (reason, meta = {}) => ({
            signal: SIGNAL.HOLD, confidence: 0,
            reason, strategy: this.name, meta,
        });

        if (!candles || candles.length < this.minCandles) {
            return hold(`Insufficient candles: ${candles?.length ?? 0} < ${this.minCandles}`);
        }

        const latest = candles[candles.length - 1];
        const timeIST = this._toIST(latest.date);

        // ── Check if we're past the signal cutoff time ──────────────────────
        if (this._isPastCutoff(timeIST)) {
            return hold(`Past signal cutoff (${LAST_SIGNAL_HOUR_IST}:${String(LAST_SIGNAL_MIN_IST).padStart(2, '0')} IST)`);
        }

        // ── Extract the opening range candles ───────────────────────────────
        // OR = first N 5-min candles of the session (9:15, 9:20, ..., 9:40)
        // We identify these by time (09:15–09:44 IST)
        const orCandles = candles.filter(c => {
            const t = this._toIST(c.date);
            return t >= '09:15' && t <= '09:44';
        });

        if (orCandles.length < this.orbWindowCandles) {
            return hold(
                `OR incomplete: ${orCandles.length}/${this.orbWindowCandles} candles`,
                { orCandles: orCandles.length }
            );
        }

        // Use exactly orbWindowCandles from the OR period
        const orWindow = orCandles.slice(0, this.orbWindowCandles);
        const orHigh = Math.max(...orWindow.map(c => c.high));
        const orLow = Math.min(...orWindow.map(c => c.low));
        const orMid = (orHigh + orLow) / 2;
        const rangePct = orMid > 0 ? ((orHigh - orLow) / orMid) * 100 : 0;

        // ── Range validity check ─────────────────────────────────────────────
        if (rangePct < this.minRangePct) {
            return hold(
                `OR range too tight: ${rangePct.toFixed(2)}% < ${this.minRangePct}%`,
                { orHigh, orLow, rangePct }
            );
        }
        if (rangePct > this.maxRangePct) {
            return hold(
                `OR range too wide: ${rangePct.toFixed(2)}% > ${this.maxRangePct}%`,
                { orHigh, orLow, rangePct }
            );
        }

        // ── Only look at candles AFTER the OR period ─────────────────────────
        const postORCandles = candles.filter(c => {
            const t = this._toIST(c.date);
            return t >= '09:45';
        });

        if (postORCandles.length === 0) {
            return hold('Waiting for first post-OR candle (9:45 AM IST)');
        }

        // ── Volume average (prior candles before latest) ────────────────────
        const priorCandles = candles.slice(-(this.volumeLookback + 1), -1);
        const avgVolume = priorCandles.length > 0
            ? priorCandles.reduce((s, c) => s + (c.volume || 0), 0) / priorCandles.length
            : 0;

        const latestVolume = latest.volume || 0;
        const volumeRatio = avgVolume > 0 ? latestVolume / avgVolume : 0;
        const volumeOk = volumeRatio >= this.volumeMultiplier;

        // ── Breakout detection ───────────────────────────────────────────────
        const closedAboveOR = latest.close > orHigh;
        const closedBelowOR = latest.close < orLow;

        // False breakout filter: check if previous candle also closed outside OR
        // Two consecutive closes = more conviction
        const prevPostOR = postORCandles.slice(-2, -1)[0];
        const prevAboveOR = prevPostOR ? prevPostOR.close > orHigh : false;
        const prevBelowOR = prevPostOR ? prevPostOR.close < orLow : false;
        const twoCandles = closedAboveOR ? prevAboveOR : (closedBelowOR ? prevBelowOR : false);

        if (!closedAboveOR && !closedBelowOR) {
            return hold('No breakout — price within OR range', {
                orHigh, orLow, close: latest.close, rangePct
            });
        }

        // ── Confidence scoring ───────────────────────────────────────────────
        let confidence = 60;

        // Range quality bonus
        if (rangePct >= 0.5 && rangePct <= 1.5) confidence += 10;  // sweet spot
        else if (rangePct >= 0.3 && rangePct <= 2.5) confidence += 5;

        // Volume bonus
        if (volumeRatio >= 2.5) confidence += 15;
        else if (volumeRatio >= 2.0) confidence += 10;
        else if (volumeRatio >= 1.5) confidence += 5;
        else if (!volumeOk) confidence -= 15;

        // Two consecutive candles bonus
        if (twoCandles) confidence += 8;

        // Breakout strength bonus (how far outside the range)
        const breakoutPct = closedAboveOR
            ? ((latest.close - orHigh) / orHigh) * 100
            : ((orLow - latest.close) / orLow) * 100;

        if (breakoutPct >= 0.5) confidence += 7;
        else if (breakoutPct >= 0.25) confidence += 3;

        // Time decay — weaker signals in afternoon
        const hourIST = parseInt(timeIST.split(':')[0], 10);
        if (hourIST >= 13) confidence -= 8;
        else if (hourIST >= 12) confidence -= 4;

        confidence = Math.max(35, Math.min(92, confidence));

        if (!volumeOk && confidence < 55) {
            return hold(`Breakout without volume: ratio=${volumeRatio.toFixed(2)}× < ${this.volumeMultiplier}×`,
                { orHigh, orLow, volumeRatio });
        }

        const direction = closedAboveOR ? SIGNAL.BUY : SIGNAL.SELL;
        const dirLabel = closedAboveOR ? 'above OR high' : 'below OR low';

        return {
            signal: direction,
            confidence,
            strategy: this.name,
            reason: `ORB ${direction}: price closed ${dirLabel} ` +
                `(range ${rangePct.toFixed(2)}%, vol ${volumeRatio.toFixed(1)}×, ` +
                `${twoCandles ? '2-candle confirm' : 'single candle'})`,
            meta: {
                orHigh,
                orLow,
                orMid,
                rangePct: +rangePct.toFixed(3),
                breakoutPct: +breakoutPct.toFixed(3),
                volumeRatio: +volumeRatio.toFixed(2),
                twoCandles,
                timeIST,
            },
        };
    }

    async refreshParams() {
        if (!this._getLiveSetting) return;
        try {
            this.minRangePct = await this._getLiveSetting('ORB_MIN_RANGE_PCT', this.minRangePct);
            this.maxRangePct = await this._getLiveSetting('ORB_MAX_RANGE_PCT', this.maxRangePct);
            this.volumeMultiplier = await this._getLiveSetting('ORB_VOLUME_MULTIPLIER', this.volumeMultiplier);
        } catch (err) {
            log.warn({ err: err.message }, 'ORB refreshParams failed');
        }
    }

    // ── Private ─────────────────────────────────────────────────────────────

    /**
     * Convert a Date or ISO string to IST time string 'HH:MM'.
     */
    _toIST(date) {
        const d = date instanceof Date ? date : new Date(date);
        return d.toLocaleString('en-US', {
            timeZone: 'Asia/Kolkata',
            hour: '2-digit',
            minute: '2-digit',
            hour12: false,
        }).replace(',', '').trim().slice(0, 5);
    }

    _isPastCutoff(timeIST) {
        const [h, m] = timeIST.split(':').map(Number);
        return h > LAST_SIGNAL_HOUR_IST ||
            (h === LAST_SIGNAL_HOUR_IST && m >= LAST_SIGNAL_MIN_IST);
    }
}

export default ORBStrategy;