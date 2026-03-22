/**
 * @fileoverview Bid-Ask Volume Imbalance (BAVI) Strategy for Alpha8
 *
 * CONCEPT:
 * Every trade in the market is initiated by either a buyer (who lifts the ask)
 * or a seller (who hits the bid). When buyers are consistently more aggressive
 * than sellers — paying up to get filled — price rises. This aggression shows
 * in volume imbalance BEFORE it fully shows in price.
 *
 * BAVI measures the ratio of buyer-initiated vs seller-initiated volume over
 * a rolling window of the last 200 ticks. A strong positive imbalance with
 * price above VWAP signals institutional accumulation. A strong negative
 * imbalance with price below VWAP signals distribution.
 *
 * WHY THIS BEATS RSI:
 * RSI measures past price changes — it's a lagging derivative of price.
 * Volume imbalance measures real-time order flow — it's a leading indicator.
 * Institutional buying shows in tick imbalance before price reacts.
 * RSI only sees the effect; BAVI sees the cause.
 *
 * GROUP: REVERSAL
 * BAVI detects absorption — when one side is aggressively dominating order
 * flow, often reversing prior price direction. Pairs with momentum strategies.
 *
 * REQUIRES:
 * A RollingTickBuffer instance populated by TickClassifier from the live
 * tick feed. Passed as second argument to analyze().
 *
 * SIGNAL RULES:
 *   BUY:  imbalance > +0.35 (65%+ buyer volume)
 *         AND imbalance trend is RISING or FLAT (not deteriorating)
 *         AND price >= VWAP (confirms institutional buying direction)
 *         AND buffer is reliable (>= 50 ticks)
 *
 *   SELL: imbalance < -0.35 (65%+ seller volume)
 *         AND imbalance trend is FALLING or FLAT
 *         AND price <= VWAP
 *         AND buffer is reliable
 *
 *   HOLD: insufficient ticks, mixed signals, or weak imbalance
 */

import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('bavi-strategy');

// ── Configuration defaults ─────────────────────────────────────────────────

const IMBALANCE_THRESHOLD = 0.35;  // |imbalance| must exceed this for signal
const STRONG_IMBALANCE = 0.50;  // 'strong' bonus threshold
const MIN_TICK_COUNT = 50;    // minimum reliable tick count
const VWAP_BAND_PCT = 0.05;  // % band around VWAP (avoid signals too close)

export class BAVIStrategy {
    /**
     * @param {Object} [params]
     * @param {number} [params.imbalanceThreshold=0.35]
     * @param {number} [params.strongImbalance=0.50]
     * @param {number} [params.minTickCount=50]
     * @param {Function} [params.getLiveSetting]
     */
    constructor(params = {}) {
        this.name = 'BAVI';
        this.imbalanceThreshold = params.imbalanceThreshold ?? IMBALANCE_THRESHOLD;
        this.strongImbalance = params.strongImbalance ?? STRONG_IMBALANCE;
        this.minTickCount = params.minTickCount ?? MIN_TICK_COUNT;
        this._getLiveSetting = params.getLiveSetting ?? null;

        // Minimum candles: need enough for VWAP calculation
        this.minCandles = 5;
    }

    // ── Public API ──────────────────────────────────────────────────────────

    /**
     * Analyze tick buffer and candles and return a signal.
     *
     * @param {Array<{open,high,low,close,volume,date}>} candles  5-min candles
     * @param {import('../data/rolling-tick-buffer.js').RollingTickBuffer|null} tickBuffer
     *   The shared RollingTickBuffer instance. If null (backtest mode),
     *   returns HOLD — BAVI cannot run without live tick data.
     * @returns {{ signal, confidence, reason, strategy, meta }}
     */
    analyze(candles, tickBuffer = null, symbol = null) {
        const hold = (reason, meta = {}) => ({
            signal: SIGNAL.HOLD, confidence: 0,
            reason, strategy: this.name, meta,
        });

        // ── Backtest / no tick data ─────────────────────────────────────────
        if (!tickBuffer || !symbol) {
            return hold('No tick buffer — BAVI requires live tick feed');
        }

        if (!candles || candles.length < this.minCandles) {
            return hold(`Insufficient candles: ${candles?.length ?? 0} < ${this.minCandles}`);
        }

        // ── Get imbalance from tick buffer ──────────────────────────────────
        const imb = tickBuffer.getImbalance(symbol);

        if (!imb.isReliable) {
            return hold(
                `Tick buffer unreliable: ${imb.tickCount} ticks < ${this.minTickCount} minimum`,
                { tickCount: imb.tickCount }
            );
        }

        const { imbalance, buyVolume, sellVolume, totalVolume, trend, trendStrength } = imb;

        // ── Compute VWAP from today's candles ───────────────────────────────
        const todayCandles = this._filterToday(candles);
        if (todayCandles.length === 0) {
            return hold('No today candles for VWAP');
        }

        const vwap = this._calculateVWAP(todayCandles);
        const currentPrice = candles[candles.length - 1].close;
        const priceVsVWAP = vwap > 0 ? ((currentPrice - vwap) / vwap) * 100 : 0;

        // Price is in a band around VWAP — ambiguous territory
        const nearVWAP = Math.abs(priceVsVWAP) < VWAP_BAND_PCT;

        // ── Signal logic ────────────────────────────────────────────────────
        const isBullish = imbalance > this.imbalanceThreshold;
        const isBearish = imbalance < -this.imbalanceThreshold;
        const aboveVWAP = currentPrice > vwap;
        const belowVWAP = currentPrice < vwap;

        // Trend must not be working against the signal
        const trendOkForBuy = trend !== 'FALLING';  // imbalance not deteriorating
        const trendOkForSell = trend !== 'RISING';   // imbalance not recovering

        if (!isBullish && !isBearish) {
            return hold(
                `Weak imbalance: ${(imbalance * 100).toFixed(1)}% (threshold: ±${(this.imbalanceThreshold * 100).toFixed(0)}%)`,
                { imbalance, vwap, currentPrice }
            );
        }

        // ── BUY signal ──────────────────────────────────────────────────────
        if (isBullish && aboveVWAP && trendOkForBuy) {
            const confidence = this._scoreConfidence('BUY', {
                imbalance, trend, trendStrength, priceVsVWAP,
                nearVWAP, totalVolume, candles,
            });

            return {
                signal: SIGNAL.BUY,
                confidence,
                strategy: this.name,
                reason: `BAVI BUY: ${(imbalance * 100).toFixed(1)}% buyer imbalance, ` +
                    `price ${priceVsVWAP > 0 ? '+' : ''}${priceVsVWAP.toFixed(2)}% vs VWAP, ` +
                    `trend ${trend} (${(trendStrength * 100).toFixed(0)}%)`,
                meta: {
                    imbalance: +imbalance.toFixed(4),
                    buyVolume,
                    sellVolume,
                    totalVolume,
                    vwap: +vwap.toFixed(2),
                    priceVsVWAP: +priceVsVWAP.toFixed(3),
                    trend,
                    trendStrength,
                    tickCount: imb.tickCount,
                },
            };
        }

        // ── SELL signal ─────────────────────────────────────────────────────
        if (isBearish && belowVWAP && trendOkForSell) {
            const confidence = this._scoreConfidence('SELL', {
                imbalance: Math.abs(imbalance), trend, trendStrength,
                priceVsVWAP: Math.abs(priceVsVWAP),
                nearVWAP, totalVolume, candles,
            });

            return {
                signal: SIGNAL.SELL,
                confidence,
                strategy: this.name,
                reason: `BAVI SELL: ${(Math.abs(imbalance) * 100).toFixed(1)}% seller imbalance, ` +
                    `price ${priceVsVWAP.toFixed(2)}% vs VWAP, ` +
                    `trend ${trend} (${(trendStrength * 100).toFixed(0)}%)`,
                meta: {
                    imbalance: +imbalance.toFixed(4),
                    buyVolume,
                    sellVolume,
                    totalVolume,
                    vwap: +vwap.toFixed(2),
                    priceVsVWAP: +priceVsVWAP.toFixed(3),
                    trend,
                    trendStrength,
                    tickCount: imb.tickCount,
                },
            };
        }

        // Signal exists but VWAP condition not met or trend conflict
        const reason = isBullish
            ? `Bullish imbalance but price ${nearVWAP ? 'too close to VWAP' : 'below VWAP'}`
            : `Bearish imbalance but price ${nearVWAP ? 'too close to VWAP' : 'above VWAP'}`;

        return hold(reason, { imbalance, vwap, currentPrice, priceVsVWAP });
    }

    async refreshParams() {
        if (!this._getLiveSetting) return;
        try {
            this.imbalanceThreshold = await this._getLiveSetting('BAVI_IMBALANCE_THRESHOLD', this.imbalanceThreshold);
            this.strongImbalance = await this._getLiveSetting('BAVI_STRONG_IMBALANCE', this.strongImbalance);
            this.minTickCount = await this._getLiveSetting('BAVI_MIN_TICK_COUNT', this.minTickCount);
        } catch (err) {
            log.warn({ err: err.message }, 'BAVI refreshParams failed');
        }
    }

    // ── Private ─────────────────────────────────────────────────────────────

    _scoreConfidence(direction, { imbalance, trend, trendStrength, priceVsVWAP, nearVWAP, totalVolume, candles }) {
        let confidence = 55;

        // Imbalance strength
        if (imbalance > this.strongImbalance) confidence += 15;
        else if (imbalance > this.imbalanceThreshold * 1.2) confidence += 8;
        else confidence += 3;

        // Trend alignment bonus
        if (direction === 'BUY' && trend === 'RISING') confidence += 10;
        if (direction === 'SELL' && trend === 'FALLING') confidence += 10;
        if (trendStrength >= 0.8) confidence += 5;

        // VWAP separation bonus (stronger when further from VWAP)
        if (priceVsVWAP >= 0.5) confidence += 10;
        else if (priceVsVWAP >= 0.25) confidence += 5;
        else if (nearVWAP) confidence -= 10;

        // Volume activity level
        const recentCandles = candles.slice(-5);
        const avgVol = recentCandles.reduce((s, c) => s + (c.volume || 0), 0) / recentCandles.length;
        const latestVol = candles[candles.length - 1].volume || 0;
        if (avgVol > 0) {
            const volRatio = latestVol / avgVol;
            if (volRatio >= 2.0) confidence += 5;
            else if (volRatio < 0.5) confidence -= 10;
        }

        return Math.max(35, Math.min(92, confidence));
    }

    _filterToday(candles) {
        const today = new Date().toLocaleString('en-CA', {
            timeZone: 'Asia/Kolkata',
        }).split(',')[0].trim();

        return candles.filter(c => {
            const d = c.date instanceof Date ? c.date : new Date(c.date);
            const ist = d.toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' })
                .split(',')[0].trim();
            return ist === today;
        });
    }

    _calculateVWAP(candles) {
        let cumTPV = 0;  // cumulative typical_price × volume
        let cumVol = 0;

        for (const c of candles) {
            const typicalPrice = (c.high + c.low + c.close) / 3;
            const vol = c.volume || 0;
            cumTPV += typicalPrice * vol;
            cumVol += vol;
        }

        return cumVol > 0 ? cumTPV / cumVol : 0;
    }
}

export default BAVIStrategy;