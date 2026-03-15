/**
 * @fileoverview Position Statistics — Feature 4
 *
 * Reads historical win-rate and average P&L from signal_outcomes
 * so the Kelly Criterion in position-sizer.js has real inputs instead
 * of hardcoded defaults.
 *
 * Cache strategy: Redis key posStats:{SYMBOL} with TTL 3600s.
 * Never throws — on any failure, returns safe defaults.
 */

import { query } from '../lib/db.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('position-stats');

/** Returned when sample size < 10 or an error occurs. */
const DEFAULTS = { winRate: 0.5, avgWin: 1000, avgLoss: 500 };

export class PositionStats {
    /**
     * @param {Object} deps
     * @param {import('ioredis').Redis} deps.redis - Redis client instance
     */
    constructor({ redis }) {
        this.redis = redis;
    }

    /**
     * Return Kelly-input stats for a symbol.
     *
     * Checks Redis first (TTL 3600s). On miss, queries signal_outcomes for
     * the last 60 days. Falls back to defaults if sample size < 10 or on error.
     *
     * @param {string} symbol
     * @returns {Promise<{
     *   winRate: number,
     *   avgWin: number,
     *   avgLoss: number,
     *   sampleSize: number,
     *   usingDefaults: boolean,
     *   error?: string
     * }>}
     */
    async getStats(symbol) {
        const cacheKey = `posStats:${symbol}`;

        try {
            // ── Cache check ───────────────────────────────────────────────────
            if (this.redis) {
                try {
                    const cached = await this.redis.get(cacheKey);
                    if (cached) {
                        log.debug({ symbol, hit: true }, 'posStats cache hit');
                        return JSON.parse(cached);
                    }
                } catch (cacheErr) {
                    log.warn({ symbol, err: cacheErr.message }, 'posStats cache read failed — continuing to DB');
                }
            }

            // ── DB query ──────────────────────────────────────────────────────
            const result = await query(
                `SELECT
           COUNT(*)                                              AS total,
           COUNT(*) FILTER (WHERE outcome = 'WIN')              AS wins,
           AVG(pnl)  FILTER (WHERE outcome = 'WIN' AND pnl > 0) AS avg_win,
           AVG(ABS(pnl)) FILTER (WHERE outcome = 'LOSS' AND pnl < 0) AS avg_loss
         FROM signal_outcomes
         WHERE symbol = $1
           AND recorded_at >= NOW() - INTERVAL '60 days'`,
                [symbol]
            );

            const row = result.rows[0];
            const total = parseInt(row?.total, 10) || 0;

            // ── Insufficient data → defaults ──────────────────────────────────
            if (total < 10) {
                const stats = {
                    ...DEFAULTS,
                    sampleSize: total,
                    usingDefaults: true,
                };
                log.debug({ symbol, total }, 'posStats: insufficient sample — using defaults');
                return stats;
            }

            // ── Compute stats from real data ──────────────────────────────────
            const wins = parseInt(row.wins, 10) || 0;
            const rawWinRate = wins / total;
            // Clamp to [0.1, 0.9] — Kelly degrades badly at extremes
            const winRate = Math.min(Math.max(rawWinRate, 0.1), 0.9);
            const avgWin = parseFloat(row.avg_win) || DEFAULTS.avgWin;
            const avgLoss = parseFloat(row.avg_loss) || DEFAULTS.avgLoss;

            const stats = {
                winRate,
                avgWin,
                avgLoss,
                sampleSize: total,
                usingDefaults: false,
            };

            log.info({ symbol, winRate, avgWin, avgLoss, total }, 'posStats computed from DB');

            // ── Cache result ──────────────────────────────────────────────────
            if (this.redis) {
                try {
                    await this.redis.set(cacheKey, JSON.stringify(stats), 'EX', 3600);
                } catch (cacheErr) {
                    log.warn({ symbol, err: cacheErr.message }, 'posStats cache write failed — non-fatal');
                }
            }

            return stats;
        } catch (err) {
            log.error({ symbol, err: err.message }, 'posStats: error fetching stats — returning defaults');
            return {
                ...DEFAULTS,
                sampleSize: 0,
                usingDefaults: true,
                error: err.message,
            };
        }
    }

    /**
     * Batch fetch Kelly-input stats for multiple symbols in a single DB query.
     * Use this in scan loops instead of calling getStats() N times.
     * Does NOT use Redis cache (assumed to be called once per scan cycle).
     *
     * @param {string[]} symbols
     * @returns {Promise<Map<string, Object>>}
     */
    async getStatsBatch(symbols) {
        if (!symbols || symbols.length === 0) {
            return new Map();
        }

        const statsMap = new Map();

        // Pre-fill map with defaults for all requested symbols
        for (const symbol of symbols) {
            statsMap.set(symbol, {
                ...DEFAULTS,
                sampleSize: 0,
                usingDefaults: true,
            });
        }

        try {
            log.debug({ symbols: symbols.length, dbQuery: 1 }, 'Fetching position stats batch');

            const result = await query(
                `SELECT
                   symbol,
                   COUNT(*)                                              AS total,
                   COUNT(*) FILTER (WHERE outcome = 'WIN')              AS wins,
                   AVG(pnl)  FILTER (WHERE outcome = 'WIN' AND pnl > 0) AS avg_win,
                   AVG(ABS(pnl)) FILTER (WHERE outcome = 'LOSS' AND pnl < 0) AS avg_loss
                 FROM signal_outcomes
                 WHERE symbol = ANY($1::text[])
                   AND recorded_at >= NOW() - INTERVAL '60 days'
                 GROUP BY symbol`,
                [symbols]
            );

            for (const row of result.rows) {
                const symbol = row.symbol;
                const total = parseInt(row.total, 10) || 0;

                if (total >= 10) {
                    const wins = parseInt(row.wins, 10) || 0;
                    const rawWinRate = wins / total;
                    const winRate = Math.min(Math.max(rawWinRate, 0.1), 0.9);
                    const avgWin = parseFloat(row.avg_win) || DEFAULTS.avgWin;
                    const avgLoss = parseFloat(row.avg_loss) || DEFAULTS.avgLoss;

                    statsMap.set(symbol, {
                        winRate,
                        avgWin,
                        avgLoss,
                        sampleSize: total,
                        usingDefaults: false,
                    });
                } else {
                    // Update sample size even if using defaults
                    statsMap.set(symbol, {
                        ...DEFAULTS,
                        sampleSize: total,
                        usingDefaults: true,
                    });
                }
            }

            return statsMap;
        } catch (err) {
            log.error({ err: err.message }, 'posStats: error fetching batched stats — returning defaults for all');
            return statsMap;
        }
    }
}
