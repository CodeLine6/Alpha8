/**
 * src/intelligence/adaptive-weights.js
 *
 * FIXES APPLIED:
 *
 *   Fix N1 — weightedConsensusWithWeights filters suppressed/below-floor signals
 *     This is the method EnhancedSignalPipeline.process() actually calls.
 *     The identical fix was previously applied to SignalConsensus (wrong class).
 *     Signals with meetsFloor===false or suppressedByTime===true are now skipped
 *     so pipeline Gate 1 is at least as strict as the grouped consensus gate.
 *
 *   Fix N10 — ADX_TRENDING_THRESHOLD actually used in classifyRegime
 *     ADX values 20–25 are now classified as SIDEWAYS (weak trend) instead of
 *     TRENDING. Full TRENDING requires ADX >= ADX_TRENDING_THRESHOLD (25).
 *     The dead constant is now live. Position sizing: SIDEWAYS uses 0.8× mult.
 *
 *   Fix S6 — weeklyUpdate filters to live-mode signal_outcomes only
 *     Added paper_mode = false filter to the accuracy query so paper trading
 *     performance does not pollute live strategy weights.
 *
 * UNCHANGED: ALL_STRATEGIES (already fixed to SCREAMING_SNAKE_CASE in previous session),
 * weight calculation, fallback chain, intraday decay integration.
 */

import { createLogger } from '../lib/logger.js';
import { query } from '../lib/db.js';

const log = createLogger('adaptive-weights');

// ── Constants ────────────────────────────────────────────────────────────────

const ALL_STRATEGIES = [
    'EMA_CROSSOVER',
    'RSI_MEAN_REVERSION',
    'VWAP_MOMENTUM',
    'BREAKOUT_VOLUME',
];

const WEIGHT_DEFAULT = 1.0;
const WEIGHT_MIN = 0.25;
const WEIGHT_MAX = 2.0;
const WEIGHT_DECAY = 0.05;  // nudge 5% toward 1.0 each week regardless
const WEIGHT_UP = 0.15;  // boost for accuracy ≥ 55%
const WEIGHT_DOWN = 0.10;  // penalty for accuracy ≤ 45%

const MIN_SIGNALS_NEEDED = 10; // minimum trades to adjust weight

// Fix N10: ADX thresholds — both now used in classifyRegime
const ADX_SIDEWAYS_THRESHOLD = 20;
const ADX_TRENDING_THRESHOLD = 25; // was dead code; now active
const VOLATILITY_RATIO_THRESH = 1.8;

export const REGIME_THRESHOLDS = {
    TRENDING: 1.8,
    SIDEWAYS: 2.2,
    VOLATILE: 2.5,
    UNKNOWN: 2.0,
};

const REGIME_SIZE_MULTIPLIERS = {
    TRENDING: 1.0,
    SIDEWAYS: 0.8,
    VOLATILE: 0.5,
    UNKNOWN: 0.9,
};

// ── AdaptiveWeightManager ────────────────────────────────────────────────────

export class AdaptiveWeightManager {
    constructor({ redis, intradayDecay, dbQuery }) {
        this.redis = redis;
        this.intradayDecay = intradayDecay;
        this.dbQuery = dbQuery || query;
        this._cacheKey = 'strategy:weights';
    }

    // ── Weight CRUD ─────────────────────────────────────────────────────────

    async getWeights() {
        try {
            const raw = await this.redis.get(this._cacheKey);
            if (raw) {
                const parsed = JSON.parse(raw);
                const map = new Map();
                for (const [k, v] of Object.entries(parsed)) {
                    map.set(k, Number(v));
                }
                return map;
            }
        } catch (err) {
            log.warn({ err: err.message }, 'Failed to read weights from Redis — using defaults');
        }
        return this._defaultWeights();
    }

    async saveWeights(weightsMap) {
        try {
            const obj = Object.fromEntries(weightsMap);
            await this.redis.set(this._cacheKey, JSON.stringify(obj));
            log.info({ weights: obj }, 'Strategy weights saved to Redis');
        } catch (err) {
            log.error({ err: err.message }, 'Failed to save weights to Redis');
        }
    }

    _defaultWeights() {
        const map = new Map();
        for (const s of ALL_STRATEGIES) map.set(s, WEIGHT_DEFAULT);
        return map;
    }

    // ── Weekly Update ────────────────────────────────────────────────────────

    /**
     * Recalculate strategy weights from the past 7 days of outcomes.
     *
     * Fix S6: Now filters to paper_mode = false so paper trading results
     * don't corrupt live strategy weights. Run every Sunday 8:55 AM IST.
     */
    async weeklyUpdate() {
        log.info('Starting weekly strategy weight update...');
        const currentWeights = await this.getWeights();
        const newWeights = new Map(currentWeights);

        for (const strategy of ALL_STRATEGIES) {
            const accuracy = await this._fetchAccuracy(strategy);
            if (accuracy === null) {
                log.info({ strategy }, 'Insufficient data — weight unchanged');
                continue;
            }

            const oldWeight = currentWeights.get(strategy) ?? WEIGHT_DEFAULT;
            const newWeight = this.calculateNewWeight(oldWeight, accuracy.winRate, accuracy.count);
            newWeights.set(strategy, newWeight);

            log.info({
                strategy,
                oldWeight: oldWeight.toFixed(3),
                newWeight: newWeight.toFixed(3),
                winRate: (accuracy.winRate * 100).toFixed(1) + '%',
                signalCount: accuracy.count,
            }, `Weight updated: ${strategy}`);
        }

        await this.saveWeights(newWeights);
        log.info('Weekly weight update complete');
        return newWeights;
    }

    calculateNewWeight(currentWeight, winRate, signalCount) {
        if (signalCount < MIN_SIGNALS_NEEDED) return currentWeight;

        // Decay toward 1.0 (regression to mean)
        let w = currentWeight + WEIGHT_DECAY * (1.0 - currentWeight);

        // Adjust based on accuracy
        if (winRate >= 0.55) w += WEIGHT_UP;
        else if (winRate <= 0.45) w -= WEIGHT_DOWN;

        return Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w));
    }

    /**
     * Fetch win-rate accuracy for a strategy.
     *
     * Fix S6: paper_mode = false filter added.
     * Falls back to shadow_signals solo accuracy if signal_outcomes has
     * insufficient data, then to a combined approach.
     *
     * @private
     */
    async _fetchAccuracy(strategy) {
        // Primary source: signal_outcomes (live trades only after Fix S6)
        try {
            const result = await this.dbQuery(
                `SELECT
           COUNT(*)                                              AS total,
           COUNT(*) FILTER (WHERE outcome = 'WIN')              AS wins
         FROM signal_outcomes
         WHERE strategy    = $1
           AND recorded_at >= NOW() - INTERVAL '7 days'
           AND paper_mode  = false`, // Fix S6
                [strategy]
            );
            const row = result.rows?.[0];
            const total = parseInt(row?.total ?? '0', 10);
            const wins = parseInt(row?.wins ?? '0', 10);

            if (total >= MIN_SIGNALS_NEEDED) {
                return { winRate: wins / total, count: total, source: 'signal_outcomes_live' };
            }
        } catch (err) {
            log.warn({ strategy, err: err.message }, 'signal_outcomes accuracy fetch failed');
        }

        // Fallback 1: shadow_signals (unbiased, live only after FIX S6)
        try {
            const result = await this.dbQuery(
                `SELECT
           COUNT(*)                                                AS total,
           COUNT(*) FILTER (WHERE outcome = 'WIN' AND acted_on)   AS wins
         FROM shadow_signals
         WHERE strategy    = $1
           AND created_at >= NOW() - INTERVAL '7 days'
           AND outcome IS NOT NULL
           AND paper_mode  = false`, // FIX S6
                [strategy]
            );
            const row = result.rows?.[0];
            const total = parseInt(row?.total ?? '0', 10);
            const wins = parseInt(row?.wins ?? '0', 10);

            if (total >= MIN_SIGNALS_NEEDED) {
                return { winRate: wins / total, count: total, source: 'shadow_signals' };
            }
        } catch (err) {
            log.warn({ strategy, err: err.message }, 'shadow_signals accuracy fetch failed');
        }

        return null; // insufficient data from both sources
    }

    // ── Outcome Recording ────────────────────────────────────────────────────

    async recordOutcome({ strategy, signal, symbol, outcome, pnl, paperMode = false }) {
        try {
            await this.dbQuery(
                `INSERT INTO signal_outcomes (strategy, signal, symbol, outcome, pnl, paper_mode, recorded_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
                [strategy, signal, symbol, outcome, pnl, paperMode] // Fix S6
            );
            log.debug({ strategy, symbol, outcome, pnl, paperMode }, 'Outcome recorded');

            // NEW: Also record as an intraday "wrong" for immediate weight decay
            if (outcome === 'LOSS' && this.intradayDecay) {
                this.intradayDecay.recordWrong(strategy).catch(() => { });
            }
        } catch (err) {
            log.error({ strategy, symbol, err: err.message }, 'Failed to record outcome');
        }
    }

    // ── Weighted Consensus ───────────────────────────────────────────────────

    /**
     * Compute weighted consensus from strategy signals + pre-fetched weights.
     *
     * Fix N1: Signals with meetsFloor===false or suppressedByTime===true are
     * now skipped. These signals exist in details[] for shadow recording only.
     * Previously they were counted here, making pipeline Gate 1 less strict than
     * the grouped consensus gate — a signal blocked by consensus could be
     * unblocked by this gate.
     *
     * @param {Array}              signals   - consensusResult.details[]
     * @param {Map<string,number>} weights   - from getWeights() or applyDecay()
     * @param {number}             threshold - regime-adjusted minimum weight sum
     */
    weightedConsensusWithWeights(signals, weights, threshold = 2.0) {
        if (!signals || signals.length === 0) return null;

        let buyWeight = 0;
        let sellWeight = 0;

        for (const sig of signals) {
            // Fix N1: skip signals suppressed by confidence floor or time window.
            // These appear in details[] for shadow recording only — they must not vote.
            if (sig.meetsFloor === false) continue;
            if (sig.suppressedByTime === true) continue;

            const w = weights.get(sig.strategy) ?? WEIGHT_DEFAULT;
            if (sig.signal === 'BUY') buyWeight += w;
            if (sig.signal === 'SELL') sellWeight += w;
        }

        log.debug({
            threshold,
            buyWeight: Math.round(buyWeight * 100) / 100,
            sellWeight: Math.round(sellWeight * 100) / 100,
        }, 'Weighted consensus check');

        if (buyWeight >= threshold) {
            const buys = signals.filter(
                s => s.signal === 'BUY' && s.meetsFloor !== false && !s.suppressedByTime
            );
            if (buys.length === 0) return null;
            const best = buys.reduce((m, s) => s.confidence > m.confidence ? s : m, buys[0]);
            return {
                ...best,
                weightedScore: Math.round(buyWeight * 100) / 100,
                votingSummary: this._voteSummary(signals, weights),
            };
        }

        if (sellWeight >= threshold) {
            const sells = signals.filter(
                s => s.signal === 'SELL' && s.meetsFloor !== false && !s.suppressedByTime
            );
            if (sells.length === 0) return null;
            const best = sells.reduce((m, s) => s.confidence > m.confidence ? s : m, sells[0]);
            return {
                ...best,
                weightedScore: Math.round(sellWeight * 100) / 100,
                votingSummary: this._voteSummary(signals, weights),
            };
        }

        return null;
    }

    /** Convenience async wrapper — fetches weights then calls the sync version. */
    async weightedConsensus(signals, threshold = 2.0) {
        const weights = await this.getWeights();
        return this.weightedConsensusWithWeights(signals, weights, threshold);
    }

    /** @private */
    _voteSummary(signals, weights) {
        return signals
            .filter(s => s.meetsFloor !== false && !s.suppressedByTime)
            .map(s => `${s.strategy}(${s.signal}×${(weights.get(s.strategy) ?? 1).toFixed(2)})`)
            .join(' | ');
    }
}

// ── RegimeDetector ───────────────────────────────────────────────────────────

export class RegimeDetector {
    constructor({ redis }) {
        this.redis = redis;
        this._cacheKey = 'regime';
        this._cacheTTL = 30 * 60; // 30 minutes
    }

    /**
     * Update regime from fresh Nifty candles and cache in Redis.
     * Called at pre-market and every 30 min during trading hours.
     */
    async update(niftyCandles) {
        if (!niftyCandles?.length) {
            log.warn('RegimeDetector.update: no candles provided');
            return null;
        }
        const regime = this.classifyRegime(niftyCandles);
        try {
            await this.redis.setex(this._cacheKey, this._cacheTTL, JSON.stringify(regime));
            log.info({ regime: regime.regime, adx: regime.adx?.toFixed(1) }, 'Regime updated');
        } catch (err) {
            log.error({ err: err.message }, 'Failed to cache regime in Redis');
        }
        return regime;
    }

    async getRegime() {
        try {
            const raw = await this.redis.get(this._cacheKey);
            if (raw) return JSON.parse(raw);
        } catch (err) {
            log.warn({ err: err.message }, 'Failed to read regime from Redis — using default');
        }
        return { regime: 'UNKNOWN', adx: 0, positionSizeMultiplier: 0.9 };
    }

    /**
     * Check whether trading is allowed for the current regime,
     * and return the position size multiplier.
     * Uses cached regime (does NOT re-fetch to avoid double Redis reads).
     */
    async check() {
        const regime = await this.getRegime();
        const allowed = regime.regime !== 'VOLATILE';
        return {
            allowed,
            regime: regime.regime,
            sizeMultiplier: REGIME_SIZE_MULTIPLIERS[regime.regime] ?? 0.9,
            blockedReason: allowed ? null : 'VOLATILE regime — trading suspended',
        };
    }

    /**
     * Classify market regime from candles.
     *
     * Fix N10: ADX 20–25 is now SIDEWAYS (weak trend), not TRENDING.
     * Full TRENDING requires ADX >= ADX_TRENDING_THRESHOLD (25).
     * The dead constant ADX_TRENDING_THRESHOLD is now active.
     *
     * @param {Array} candles - normalised candle objects with { close, high, low }
     * @returns {{ regime, adx, volatilityRatio, positionSizeMultiplier }}
     */
    classifyRegime(candles) {
        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);

        const adx = this._computeADX(closes, highs, lows, 14);
        const volatilityRatio = this._computeVolatilityRatio(closes, 14);

        let regime;

        if (volatilityRatio >= VOLATILITY_RATIO_THRESH) {
            regime = 'VOLATILE';
        } else if (adx < ADX_SIDEWAYS_THRESHOLD) {
            // Fix N10: below 20 → SIDEWAYS (unchanged)
            regime = 'SIDEWAYS';
        } else if (adx < ADX_TRENDING_THRESHOLD) {
            // Fix N10: 20–25 → SIDEWAYS (was falling through to TRENDING, dead constant)
            regime = 'SIDEWAYS';
        } else {
            // ADX >= 25 → genuine trend
            regime = 'TRENDING';
        }

        return {
            regime,
            adx: +adx.toFixed(2),
            volatilityRatio: +volatilityRatio.toFixed(3),
            positionSizeMultiplier: REGIME_SIZE_MULTIPLIERS[regime],
        };
    }

    /** @private */
    _computeADX(closes, highs, lows, period = 14) {
        if (closes.length < period + 1) return 15; // default: borderline sideways
        const trValues = [];
        const dmPlus = [];
        const dmMinus = [];

        for (let i = 1; i < closes.length; i++) {
            const high = highs[i], low = lows[i], prevClose = closes[i - 1];
            const prevHigh = highs[i - 1], prevLow = lows[i - 1];

            trValues.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));

            const upMove = high - prevHigh;
            const downMove = prevLow - low;

            dmPlus.push(upMove > downMove && upMove > 0 ? upMove : 0);
            dmMinus.push(downMove > upMove && downMove > 0 ? downMove : 0);
        }

        const smooth = (arr, p) => {
            let s = arr.slice(0, p).reduce((a, b) => a + b, 0);
            const result = [s];
            for (let i = p; i < arr.length; i++) {
                s = s - s / p + arr[i];
                result.push(s);
            }
            return result;
        };

        const sTR = smooth(trValues, period);
        const sDMP = smooth(dmPlus, period);
        const sDMM = smooth(dmMinus, period);

        const dx = sTR.map((tr, i) => {
            const diP = tr !== 0 ? (sDMP[i] / tr) * 100 : 0;
            const diM = tr !== 0 ? (sDMM[i] / tr) * 100 : 0;
            const sum = diP + diM;
            return sum !== 0 ? (Math.abs(diP - diM) / sum) * 100 : 0;
        });

        const adxValues = smooth(dx.slice(period), period);
        return adxValues[adxValues.length - 1] ?? 15;
    }

    /** @private */
    _computeVolatilityRatio(closes, period = 14) {
        if (closes.length < period * 2) return 1.0;
        const recent = closes.slice(-period);
        const prior = closes.slice(-period * 2, -period);

        const std = (arr) => {
            const m = arr.reduce((a, b) => a + b, 0) / arr.length;
            return Math.sqrt(arr.reduce((s, x) => s + (x - m) ** 2, 0) / arr.length);
        };

        const recentStd = std(recent);
        const priorStd = std(prior);
        return priorStd > 0 ? recentStd / priorStd : 1.0;
    }
}

// ── IntradayDecayManager ─────────────────────────────────────────────────────

export class IntradayDecayManager {
    constructor({ redis }) {
        this.redis = redis;
        this._prefix = 'intraday:wrongs:';
        this._ttl = 86400; // 24 hours
        this._floor = 0.25;
    }

    get ALL_STRATEGY_KEYS() {
        return ALL_STRATEGIES.map(s => `${this._prefix}${s}`);
    }

    async recordWrong(strategy) {
        const key = `${this._prefix}${strategy}`;
        try {
            const count = await this.redis.incr(key);
            if (count === 1) await this.redis.expire(key, this._ttl);
            log.debug({ strategy, wrongCount: count }, 'Intraday wrong recorded');
            return count;
        } catch (err) {
            log.warn({ strategy, err: err.message }, 'recordWrong failed');
            return 0;
        }
    }

    async getMultiplier(strategy) {
        const key = `${this._prefix}${strategy}`;
        try {
            const raw = await this.redis.get(key);
            const count = parseInt(raw ?? '0', 10);
            return count === 0 ? 1.0
                : count === 1 ? 0.85
                    : count === 2 ? 0.70
                        : 0.55;
        } catch { return 1.0; }
    }

    async applyDecay(baseWeights) {
        const decayed = new Map();
        for (const [strategy, weight] of baseWeights) {
            const mult = await this.getMultiplier(strategy);
            decayed.set(strategy, Math.max(this._floor, weight * mult));
        }
        return decayed;
    }

    async resetDay() {
        try {
            await this.redis.del(...this.ALL_STRATEGY_KEYS);
            log.info('Intraday decay counters reset for new session');
        } catch (err) {
            log.error({ err: err.message }, 'Failed to reset intraday decay counters');
        }
    }
}