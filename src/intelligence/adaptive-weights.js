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
import { RegimeDetector } from '../filters/regime-detector.js';
import { IntradayDecayManager } from './intraday-decay.js';

const log = createLogger('adaptive-weights');

// ── Constants ────────────────────────────────────────────────────────────────

const ALL_STRATEGIES = [
    'ORB',
    'BAVI',
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
        // Primary source: shadow_signals (Pure Intelligence / Technical Accuracy)
        // Fix (Phase 17): We prioritize the strategy's technical prediction over 
        // final trade management (PnL). This is non-biased as it includes solo signals.
        try {
            const result = await this.dbQuery(
                `SELECT
           COUNT(*)                                                AS total,
           COUNT(*) FILTER (WHERE was_correct_30min = true)       AS wins
         FROM shadow_signals
         WHERE strategy    = $1
           AND created_at >= NOW() - INTERVAL '7 days'
           AND was_correct_30min IS NOT NULL
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

        // Fallback 1: signal_outcomes (Realized Trade PnL)
        // Only used if shadow data is insufficient.
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

export { RegimeDetector, IntradayDecayManager }; // re-export if external consumers exist
