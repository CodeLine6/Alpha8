/**
 * @fileoverview Adaptive Strategy Weighting for Alpha8
 *
 * FIXES APPLIED:
 *
 *   Fix 1 — Strategy name case mismatch (CRITICAL)
 *     ALL_STRATEGIES now uses SCREAMING_SNAKE_CASE to match STRATEGY constants
 *     and the names written to signal_outcomes / shadow_signals by the execution
 *     engine. Previously used kebab-case which caused every weight lookup to
 *     return undefined → fall back to 1.0 → adaptive weights had zero effect.
 *
 *   Fix 2 — Solo accuracy as weight source (DESIGN)
 *     weeklyUpdate() now reads accuracy from shadow_signals (unbiased — every
 *     individual strategy signal regardless of consensus) instead of
 *     signal_outcomes (biased — only signals that reached a filled trade).
 *
 *     The old approach rewarded strategies that fire together (correlation) rather
 *     than strategies that are independently correct (accuracy). A strategy that
 *     fires correctly 70% of the time solo but rarely reaches consensus was
 *     permanently starved of positive feedback. Now solo accuracy is the primary
 *     weight driver.
 *
 *     Fallback chain:
 *       1. shadow_signals solo accuracy (>= MIN_SAMPLE_SIZE evaluated rows)
 *       2. shadow_signals overall accuracy (if solo sample too small)
 *       3. signal_outcomes accuracy (if shadow data insufficient)
 *       4. Decay only — no adjustment (if all sources insufficient)
 *
 * UNCHANGED:
 *   Weight bounds (0.25 – 2.0), decay rate (5%), adjustment steps (±0.10/0.15),
 *   MIN_SIGNALS_NEEDED (10), EVAL_WINDOW_DAYS (14), Redis key, TTL.
 *   weightedConsensus(), weightedConsensusWithWeights(), recordOutcome() —
 *   all public API signatures unchanged.
 */

import { createLogger } from '../lib/logger.js';
import { query } from '../lib/db.js';

const log = createLogger('adaptive-weights');

// NOTE: Redis keyPrefix 'alpha8:' is applied automatically — don't add it here
const CACHE_KEY = 'strategy:weights';
const CACHE_TTL_SEC = 7 * 24 * 60 * 60; // 1 week

const WEIGHT_MIN = 0.25;
const WEIGHT_MAX = 2.0;
const WEIGHT_DEFAULT = 1.0;
const WEIGHT_DECAY = 0.05;
const WEIGHT_UP_STEP = 0.15;
const WEIGHT_DOWN_STEP = 0.10;
const MIN_SIGNALS_NEEDED = 10;
const EVAL_WINDOW_DAYS = 14;

/**
 * Fix 1: Use SCREAMING_SNAKE_CASE to match STRATEGY constants in constants.js
 * and the strategy names written by execution-engine.js to both signal_outcomes
 * and shadow_signals tables.
 *
 * Previous value (broken): ['ema-crossover', 'rsi-reversion', 'vwap-momentum', 'breakout-volume']
 */
const ALL_STRATEGIES = [
    'EMA_CROSSOVER',
    'RSI_MEAN_REVERSION',
    'VWAP_MOMENTUM',
    'BREAKOUT_VOLUME',
];

// ── Pure functions (exported for testing) ────────────────────────────────────

export function evaluateAccuracy(signalHistory) {
    const actionable = signalHistory.filter(s => s.signal !== 'HOLD' && s.outcome);
    if (actionable.length === 0) return { accuracy: 0, count: 0 };
    const wins = actionable.filter(s => s.outcome === 'WIN').length;
    return { accuracy: Math.round((wins / actionable.length) * 100), count: actionable.length };
}

export function decayWeight(weight) {
    return weight + (WEIGHT_DEFAULT - weight) * WEIGHT_DECAY;
}

export function calculateNewWeight(currentWeight, recentAccuracyPct, signalCount) {
    if (signalCount < MIN_SIGNALS_NEEDED) return decayWeight(currentWeight);

    let w = currentWeight;
    if (recentAccuracyPct >= 55) w += WEIGHT_UP_STEP;
    else if (recentAccuracyPct <= 45) w -= WEIGHT_DOWN_STEP;

    w = decayWeight(w);
    return Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, w)) * 1000) / 1000;
}

// ── AdaptiveWeightManager ─────────────────────────────────────────────────────

export class AdaptiveWeightManager {
    /**
     * @param {object} opts
     * @param {object}   opts.redis
     * @param {Function} [opts.logger]
     */
    constructor({ redis, logger }) {
        this.redis = redis;
        this.logger = logger || ((msg, meta) => log.info(meta || {}, msg));
    }

    /** Get current weights. Returns defaults if none saved yet. */
    async getWeights() {
        try {
            const cached = await this.redis.get(CACHE_KEY);
            if (cached) return new Map(Object.entries(JSON.parse(cached)));
        } catch (err) {
            this.logger(`[AdaptiveWeights] Redis read failed: ${err.message}`);
        }
        return new Map(ALL_STRATEGIES.map(s => [s, WEIGHT_DEFAULT]));
    }

    /**
     * Sunday weekly update — re-evaluate all strategy weights.
     *
     * Fix 2: Reads solo accuracy from shadow_signals as primary source.
     * Solo accuracy measures how often a strategy is correct when it fires
     * WITHOUT consensus — the purest signal of individual strategy quality.
     *
     * Fallback chain per strategy:
     *   1. shadow_signals solo accuracy    (soloEvaluated >= MIN_SIGNALS_NEEDED)
     *   2. shadow_signals overall accuracy (evaluated >= MIN_SIGNALS_NEEDED)
     *   3. signal_outcomes accuracy        (count >= MIN_SIGNALS_NEEDED)
     *   4. Decay only                      (all sources insufficient)
     *
     * @returns {Promise<Map<string, number>>}
     */
    async weeklyUpdate() {
        this.logger('[AdaptiveWeights] Running weekly weight update (source: shadow_signals solo accuracy)...');
        const currentWeights = await this.getWeights();
        const newWeights = new Map();

        for (const strategy of ALL_STRATEGIES) {
            const cw = currentWeights.get(strategy) ?? WEIGHT_DEFAULT;

            // ── Source 1: Shadow signals solo accuracy ─────────────────────────────
            // Solo = signals that fired but did NOT reach consensus.
            // This is the unbiased measure of individual strategy quality.
            const shadow = await this._fetchShadowAccuracy(strategy, EVAL_WINDOW_DAYS);

            if (shadow.soloEvaluated >= MIN_SIGNALS_NEEDED) {
                const nw = calculateNewWeight(cw, shadow.soloAccuracy, shadow.soloEvaluated);
                newWeights.set(strategy, nw);
                this._logWeightChange(strategy, cw, nw, shadow.soloAccuracy, shadow.soloEvaluated, 'shadow:solo');
                continue;
            }

            // ── Source 2: Shadow signals overall accuracy ──────────────────────────
            // Includes both solo and consensus signals — less pure but larger sample.
            if (shadow.evaluated >= MIN_SIGNALS_NEEDED) {
                const nw = calculateNewWeight(cw, shadow.overallAccuracy, shadow.evaluated);
                newWeights.set(strategy, nw);
                this._logWeightChange(strategy, cw, nw, shadow.overallAccuracy, shadow.evaluated, 'shadow:overall');
                continue;
            }

            // ── Source 3: signal_outcomes (biased fallback) ────────────────────────
            // Only filled trades — kept as fallback for early data or shadow gaps.
            const outcomes = await this._fetchOutcomesAccuracy(strategy, EVAL_WINDOW_DAYS);

            if (outcomes.count >= MIN_SIGNALS_NEEDED) {
                const nw = calculateNewWeight(cw, outcomes.accuracy, outcomes.count);
                newWeights.set(strategy, nw);
                this._logWeightChange(strategy, cw, nw, outcomes.accuracy, outcomes.count, 'signal_outcomes:fallback');
                continue;
            }

            // ── Source 4: Decay only — no data ────────────────────────────────────
            const nw = decayWeight(cw);
            const rounded = Math.round(Math.min(WEIGHT_MAX, Math.max(WEIGHT_MIN, nw)) * 1000) / 1000;
            newWeights.set(strategy, rounded);
            this.logger(
                `[AdaptiveWeights] ${strategy}: ${cw.toFixed(3)} → ${rounded.toFixed(3)} | ` +
                `no data (decay only) — shadow solo: ${shadow.soloEvaluated}, ` +
                `shadow overall: ${shadow.evaluated}, outcomes: ${outcomes.count}`
            );
        }

        try {
            await this.redis.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(Object.fromEntries(newWeights)));
            this.logger('[AdaptiveWeights] Weights saved to Redis');
        } catch (err) {
            this.logger(`[AdaptiveWeights] Failed to save weights: ${err.message}`);
        }

        return newWeights;
    }

    /**
     * Weighted consensus — replaces simple "2+ strategies agree".
     * Combined trust score of agreeing strategies must reach `threshold`.
     *
     * The threshold is regime-adaptive (passed in from EnhancedSignalPipeline):
     *   TRENDING → 1.8, SIDEWAYS → 2.0, VOLATILE → 2.5, UNKNOWN → 2.0
     *
     * @param {Array}  signals   - [{ signal, confidence, strategy, reason }]
     * @param {number} threshold - default 2.0
     * @returns {Promise<object|null>}
     */
    async weightedConsensus(signals, threshold = 2.0) {
        if (!signals || signals.length === 0) return null;

        const weights = await this.getWeights();
        return this.weightedConsensusWithWeights(signals, weights, threshold);
    }

    /**
     * Weighted consensus with a pre-fetched / intraday-decayed weight Map.
     * Skips the Redis fetch — caller provides the weights.
     * Backward compatible: existing weightedConsensus() signature unchanged.
     *
     * @param {Array}              signals   - [{ signal, confidence, strategy, reason }]
     * @param {Map<string,number>} weights   - Pre-fetched weight map
     * @param {number}             threshold - default 2.0
     * @returns {object|null}
     */
    weightedConsensusWithWeights(signals, weights, threshold = 2.0) {
        if (!signals || signals.length === 0) return null;

        let buyWeight = 0;
        let sellWeight = 0;

        for (const sig of signals) {
            const w = weights.get(sig.strategy) ?? WEIGHT_DEFAULT;
            if (sig.signal === 'BUY') buyWeight += w;
            if (sig.signal === 'SELL') sellWeight += w;
        }

        log.debug({
            threshold,
            buyWeight: Math.round(buyWeight * 100) / 100,
            sellWeight: Math.round(sellWeight * 100) / 100,
        }, 'Weighted consensus threshold check');

        if (buyWeight >= threshold) {
            const buys = signals.filter(s => s.signal === 'BUY');
            const best = buys.reduce((m, s) => s.confidence > m.confidence ? s : m, buys[0]);
            log.debug({ threshold, buyWeight }, 'BUY weighted consensus passed');
            return {
                ...best,
                weightedScore: Math.round(buyWeight * 100) / 100,
                votingSummary: this._voteSummary(signals, weights),
            };
        }

        if (sellWeight >= threshold) {
            const sells = signals.filter(s => s.signal === 'SELL');
            const best = sells.reduce((m, s) => s.confidence > m.confidence ? s : m, sells[0]);
            log.debug({ threshold, sellWeight }, 'SELL weighted consensus passed');
            return {
                ...best,
                weightedScore: Math.round(sellWeight * 100) / 100,
                votingSummary: this._voteSummary(signals, weights),
            };
        }

        log.debug({ threshold, buyWeight, sellWeight },
            'Weighted consensus blocked — weights below threshold');
        return null;
    }

    /**
     * Record a signal outcome for future weight evaluation.
     * Written to signal_outcomes — kept as fallback data source.
     * Shadow signals are written independently by ShadowRecorder.
     *
     * @param {string} strategy
     * @param {string} signal   - 'BUY'|'SELL'
     * @param {string} symbol
     * @param {string} outcome  - 'WIN'|'LOSS'
     * @param {number} pnl
     */
    async recordOutcome({ strategy, signal, symbol, outcome, pnl }) {
        try {
            await query(
                `INSERT INTO signal_outcomes (strategy, signal, symbol, outcome, pnl, recorded_at)
         VALUES ($1, $2, $3, $4, $5, NOW())`,
                [strategy, signal, symbol, outcome, pnl]
            );
        } catch (err) {
            this.logger(`[AdaptiveWeights] Failed to record outcome for ${strategy}/${symbol}: ${err.message}`);
        }
    }

    // ── Private ───────────────────────────────────────────────────────────────

    /**
     * Fix 2: Fetch solo and overall accuracy from shadow_signals.
     *
     * Solo accuracy = was_correct_30min when consensus_reached = FALSE.
     * This is the purest measure of individual strategy quality — the strategy
     * fired alone and we can see if it was right without the confound of
     * whether other strategies agreed.
     *
     * Overall accuracy = was_correct_30min across all evaluated signals.
     *
     * @private
     * @param {string} strategy
     * @param {number} days
     * @returns {Promise<{
     *   soloAccuracy: number,
     *   soloEvaluated: number,
     *   overallAccuracy: number,
     *   evaluated: number
     * }>}
     */
    async _fetchShadowAccuracy(strategy, days) {
        const empty = { soloAccuracy: 0, soloEvaluated: 0, overallAccuracy: 0, evaluated: 0 };

        try {
            const result = await query(
                `SELECT
           -- Solo signals (fired without reaching consensus)
           COUNT(*) FILTER (
             WHERE consensus_reached = FALSE
               AND was_correct_30min IS NOT NULL
           )                                                           AS solo_evaluated,
           COUNT(*) FILTER (
             WHERE consensus_reached = FALSE
               AND was_correct_30min = TRUE
           )                                                           AS solo_correct,

           -- All evaluated signals (solo + consensus)
           COUNT(*) FILTER (WHERE was_correct_30min IS NOT NULL)       AS evaluated,
           COUNT(*) FILTER (WHERE was_correct_30min = TRUE)            AS overall_correct
         FROM shadow_signals
         WHERE strategy    = $1
           AND created_at >= NOW() - ($2 || ' days')::INTERVAL`,
                [strategy, days]
            );

            const row = result.rows[0];
            const soloEval = parseInt(row.solo_evaluated, 10) || 0;
            const soloCorrect = parseInt(row.solo_correct, 10) || 0;
            const evaluated = parseInt(row.evaluated, 10) || 0;
            const allCorrect = parseInt(row.overall_correct, 10) || 0;

            return {
                soloAccuracy: soloEval > 0 ? Math.round((soloCorrect / soloEval) * 100) : 0,
                soloEvaluated: soloEval,
                overallAccuracy: evaluated > 0 ? Math.round((allCorrect / evaluated) * 100) : 0,
                evaluated,
            };
        } catch (err) {
            this.logger(`[AdaptiveWeights] _fetchShadowAccuracy failed for ${strategy}: ${err.message}`);
            return empty;
        }
    }

    /**
     * Fetch accuracy from signal_outcomes (biased fallback).
     * Only used when shadow_signals has insufficient data.
     * @private
     */
    async _fetchOutcomesAccuracy(strategy, days) {
        try {
            const result = await query(
                `SELECT signal, outcome
         FROM   signal_outcomes
         WHERE  strategy    = $1
           AND  recorded_at >= NOW() - ($2 || ' days')::INTERVAL`,
                [strategy, days]
            );
            return evaluateAccuracy(result.rows);
        } catch {
            return { accuracy: 0, count: 0 };
        }
    }

    /** @private */
    _logWeightChange(strategy, oldWeight, newWeight, accuracy, sampleSize, source) {
        const trend = newWeight > oldWeight ? 'IMPROVING' :
            newWeight < oldWeight ? 'DECLINING' : 'STABLE';
        this.logger(
            `[AdaptiveWeights] ${strategy}: ${oldWeight.toFixed(3)} → ${newWeight.toFixed(3)} | ` +
            `accuracy=${accuracy}% n=${sampleSize} source=${source} | ${trend}`
        );
    }

    /** @private */
    _voteSummary(signals, weights) {
        return signals
            .map(s => `${s.strategy}(${s.signal}×${(weights.get(s.strategy) ?? 1).toFixed(2)})`)
            .join(' | ');
    }
}

/**
 * DB migration string — already included in scripts/setup-db.js.
 * Kept here for reference.
 */
export const SIGNAL_OUTCOMES_MIGRATION = `
CREATE TABLE IF NOT EXISTS signal_outcomes (
  id          SERIAL PRIMARY KEY,
  strategy    VARCHAR(50)  NOT NULL,
  signal      VARCHAR(10)  NOT NULL,
  symbol      VARCHAR(20)  NOT NULL,
  outcome     VARCHAR(10)  NOT NULL,
  pnl         DECIMAL(12,2),
  recorded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_strategy ON signal_outcomes(strategy, recorded_at);
`;