/**
 * @fileoverview Intraday Strategy Weight Decay — Feature 7
 *
 * Adaptive weights update once per week (Sunday). But a strategy can be
 * systematically wrong all day Tuesday and its Sunday weight stays fixed
 * until the weekend. This module provides a lightweight intraday modifier:
 *
 *   - If a strategy fires 3+ WRONG signals today → multiply its effective
 *     weight by 0.80 (20% reduction) for the rest of the session.
 *   - If it fires 5+ WRONG signals → 0.65 (35% reduction).
 *   - Resets at market open each day (clean slate every session).
 *
 * NO DB writes. Entirely Redis-backed with 24h auto-expire TTL.
 * Does NOT modify the Sunday base weights — purely a multiplier on top.
 *
 * Redis key pattern: intraday:wrongs:{STRATEGY}
 * (Note: Redis client auto-prefixes 'alpha8:' — do not add it here)
 *
 * Weight floor: 0.25 (matches WEIGHT_MIN in adaptive-weights.js)
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('intraday-decay');

/** All four strategy keys — used for explicit DEL at market open (no SCAN). */
const ALL_STRATEGY_KEYS = [
    'intraday:wrongs:EMA_CROSSOVER',
    'intraday:wrongs:RSI_MEAN_REVERSION',
    'intraday:wrongs:VWAP_MOMENTUM',
    'intraday:wrongs:BREAKOUT_VOLUME',
];

/** Floor applied after decay multiplication — matches WEIGHT_MIN in adaptive-weights.js */
const WEIGHT_FLOOR = 0.25;

export class IntradayDecayManager {
    /**
     * @param {Object} opts
     * @param {import('ioredis').Redis} opts.redis - Redis client (auto-prefixed with 'alpha8:')
     */
    constructor({ redis }) {
        this.redis = redis;
    }

    /**
     * Increment the wrong-signal counter for a strategy.
     * Called after price outcomes confirm the signal was incorrect.
     *
     * - Uses Redis INCR (atomic).
     * - Sets 24h TTL on first increment (belt-and-suspenders; market open reset is primary).
     * - Never throws.
     *
     * @param {string} strategy - e.g. 'EMA_CROSSOVER'
     */
    async recordWrong(strategy) {
        const key = `intraday:wrongs:${strategy}`;
        try {
            const newCount = await this.redis.incr(key);
            if (newCount === 1) {
                // First wrong today — set TTL so it auto-expires even if resetDay() never runs
                await this.redis.expire(key, 86400);
            }
            log.debug({ strategy, wrongCount: newCount }, 'Intraday wrong signal recorded');
        } catch (err) {
            log.warn({ strategy, err: err.message }, 'recordWrong failed — non-fatal');
        }
    }

    /**
     * Get the intraday decay multiplier for a strategy.
     *
     * Thresholds:
     *   wrongs >= 5 → 0.65 (very bad day — 35% reduction)
     *   wrongs >= 3 → 0.80 (bad day — 20% reduction)
     *   otherwise  → 1.00 (no change)
     *
     * Fail-open: returns 1.0 on Redis failure (never penalise due to cache error).
     *
     * @param {string} strategy
     * @returns {Promise<number>} Multiplier in range (0, 1]
     */
    async getMultiplier(strategy) {
        const key = `intraday:wrongs:${strategy}`;
        try {
            const raw = await this.redis.get(key);
            if (raw === null) return 1.0;
            const count = parseInt(raw, 10) || 0;
            if (count >= 5) return 0.65;
            if (count >= 3) return 0.80;
            return 1.0;
        } catch (err) {
            log.warn({ strategy, err: err.message }, 'getMultiplier failed — returning 1.0 (fail-open)');
            return 1.0;
        }
    }

    /**
     * Apply intraday decay multipliers to a weight map.
     *
     * Accepts a Map<strategy, weight> from AdaptiveWeightManager.getWeights(),
     * returns a NEW Map with each weight multiplied by its intraday multiplier.
     * Input map is never mutated.
     *
     * Floor: WEIGHT_FLOOR (0.25) — strategy is suppressed but not silenced.
     *
     * @param {Map<string, number>} weights - Base weights from AdaptiveWeightManager
     * @returns {Promise<Map<string, number>>} New map with decay applied
     */
    async applyDecay(weights) {
        const decayed = new Map();
        for (const [strategy, baseWeight] of weights.entries()) {
            const multiplier = await this.getMultiplier(strategy);
            const adjusted = Math.max(WEIGHT_FLOOR, baseWeight * multiplier);
            decayed.set(strategy, adjusted);
            if (multiplier < 1.0) {
                log.debug({
                    strategy,
                    baseWeight,
                    multiplier,
                    adjusted: Math.round(adjusted * 1000) / 1000,
                }, 'Intraday decay applied to strategy weight');
            }
        }
        return decayed;
    }

    /**
     * Reset all intraday wrong-signal counters.
     * Called at market open (_marketOpen()) — clean slate before first scan.
     *
     * Uses explicit DEL on all 4 strategy keys (no SCAN — not supported on all providers).
     * Non-fatal: individual key failures are logged and skipped.
     */
    async resetDay() {
        try {
            // DEL accepts multiple keys in one round-trip
            const deleted = await this.redis.del(...ALL_STRATEGY_KEYS);
            log.info({ deleted, keys: ALL_STRATEGY_KEYS.length },
                'Intraday decay counters reset for new session');
        } catch (err) {
            log.warn({ err: err.message }, 'resetDay failed — intraday counters may carry over');
        }
    }
}
