/**
 * @fileoverview Adaptive Strategy Weighting for Alpha8
 *
 * Every Sunday after market close, reviews the last 2 weeks of signal outcomes
 * and adjusts how much each strategy is trusted in the consensus vote.
 *
 * Strategies with >55% accuracy get more weight.
 * Strategies with <45% accuracy get less weight.
 * All weights decay toward 1.0 over time (fresh start every few weeks).
 *
 * GUARDRAILS:
 *   - Min weight: 0.25  (never fully ignored)
 *   - Max weight: 2.0   (never dominates alone)
 *   - Min 10 signals needed before adjusting
 *   - Weights decay 5% toward 1.0 every update
 *
 * HOW IT CHANGES THE CONSENSUS:
 *   Original: "2 out of 4 strategies must agree"
 *   Weighted: "combined trust score of agreeing strategies must reach 2.0"
 *
 *   Example:
 *     EMA (weight=1.8) says BUY → contributes 1.8
 *     RSI (weight=0.4) says BUY → contributes 0.4
 *     Total = 2.2 ≥ 2.0 → TRADE ✅
 *
 *     EMA (weight=1.8) says BUY alone → 1.8 < 2.0 → NO TRADE
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

const ALL_STRATEGIES = ['ema-crossover', 'rsi-reversion', 'vwap-momentum', 'breakout-volume'];

// ── Pure functions (exported for testing) ───────────────────────────────────

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

// ── AdaptiveWeightManager ────────────────────────────────────────────────────

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
     * Sunday weekly update — re-evaluate all strategy weights from DB history.
     * @returns {Promise<Map<string, number>>}
     */
    async weeklyUpdate() {
        this.logger('[AdaptiveWeights] Running weekly weight update...');
        const currentWeights = await this.getWeights();
        const newWeights = new Map();

        for (const strategy of ALL_STRATEGIES) {
            const history = await this._fetchHistory(strategy, EVAL_WINDOW_DAYS);
            const { accuracy, count } = evaluateAccuracy(history);
            const cw = currentWeights.get(strategy) ?? WEIGHT_DEFAULT;
            const nw = calculateNewWeight(cw, accuracy, count);
            newWeights.set(strategy, nw);

            const trend = nw > cw ? 'IMPROVING' : nw < cw ? 'DECLINING' : 'STABLE';
            this.logger(`[AdaptiveWeights] ${strategy}: ${cw.toFixed(3)} → ${nw.toFixed(3)} | accuracy=${accuracy}% count=${count} | ${trend}`);
        }

        try {
            await this.redis.setex(CACHE_KEY, CACHE_TTL_SEC, JSON.stringify(Object.fromEntries(newWeights)));
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
     * @param {number} threshold - default 2.0 (matches original "min 2 agree")
     * @returns {Promise<object|null>}
     */
    async weightedConsensus(signals, threshold = 2.0) {
        if (!signals || signals.length === 0) return null;

        const weights = await this.getWeights();
        let buyWeight = 0;
        let sellWeight = 0;

        for (const sig of signals) {
            const w = weights.get(sig.strategy) ?? WEIGHT_DEFAULT;
            if (sig.signal === 'BUY') buyWeight += w;
            if (sig.signal === 'SELL') sellWeight += w;
        }

        // Log at the decision point so you can see { threshold, buyWeight, sellWeight }
        // and understand whether a raise in threshold (e.g. VOLATILE → 2.5) blocked the signal.
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

        log.debug({ threshold, buyWeight, sellWeight }, 'Weighted consensus blocked — weights below threshold');
        return null;
    }

    /**
     * Record a signal outcome for future weight evaluation.
     * Call this when a position closes.
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
            // Non-critical — log and continue
            this.logger(`[AdaptiveWeights] Failed to record outcome for ${strategy}/${symbol}: ${err.message}`);
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    async _fetchHistory(strategy, days) {
        try {
            const result = await query(
                `SELECT signal, outcome
         FROM   signal_outcomes
         WHERE  strategy    = $1
           AND  recorded_at >= NOW() - INTERVAL '${days} days'`,
                [strategy]
            );
            return result.rows;
        } catch {
            return [];
        }
    }

    _voteSummary(signals, weights) {
        return signals
            .map(s => `${s.strategy}(${s.signal}×${(weights.get(s.strategy) ?? 1).toFixed(2)})`)
            .join(' | ');
    }
}

/**
 * DB migration string — add to scripts/migrate.js or scripts/schema.sql.
 * Already included in the updated schema.sql.
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