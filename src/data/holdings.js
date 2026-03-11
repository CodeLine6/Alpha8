/**
 * @fileoverview Holdings Manager — Feature 5
 *
 * Provides proactive exposure awareness before a BUY is placed.
 * Fetches delivery holdings AND intraday positions from the broker,
 * merges them into a single Map keyed by tradingsymbol, and caches
 * the result for 5 minutes in Redis.
 *
 * This is the complement to reconcilePositions() (which is reactive,
 * runs every 30 minutes). Holdings awareness is proactive — it blocks
 * a BUY before the order is placed when exposure already exists.
 *
 * Constraint: never throws. All public methods return safe defaults on error.
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('holdings-manager');

export class HoldingsManager {
    /**
     * @param {Object} deps
     * @param {Object}  deps.broker  - BrokerManager instance (may be null in paper mode)
     * @param {import('ioredis').Redis} deps.redis
     * @param {number}  deps.capital - Trading capital (for future use / logging)
     */
    constructor({ broker, redis, capital }) {
        this.broker = broker;
        this.redis = redis;
        this.capital = capital;
    }

    /**
     * Return a Map of all current equity exposures.
     *
     * Merges broker.getHoldings() (delivery) and broker.getPositions() (intraday).
     * Uses Promise.allSettled so a holdings failure doesn't block positions.
     * Caches result at "holdings:snapshot" with TTL 300s.
     *
     * @returns {Promise<Map<string, { symbol: string, quantity: number, avgPrice: number, source: string }>>}
     */
    async getSnapshot() {
        if (!this.broker) {
            return new Map();
        }

        const cacheKey = 'holdings:snapshot';

        // ── Cache check ───────────────────────────────────────────────────
        if (this.redis) {
            try {
                const cached = await this.redis.get(cacheKey);
                if (cached) {
                    log.debug('holdings snapshot cache hit');
                    return new Map(Object.entries(JSON.parse(cached)));
                }
            } catch (cacheErr) {
                log.warn({ err: cacheErr.message }, 'Holdings cache read failed — continuing to broker');
            }
        }

        // ── Fetch from broker (partial failure is acceptable) ─────────────
        const [holdingsResult, positionsResult] = await Promise.allSettled([
            this.broker.getHoldings(),
            this.broker.getPositions(),
        ]);

        const snapshot = new Map();

        // ── Normalize holdings (delivery) ─────────────────────────────────
        if (holdingsResult.status === 'fulfilled') {
            const rawHoldings = Array.isArray(holdingsResult.value) ? holdingsResult.value : [];
            for (const h of rawHoldings) {
                const symbol = h.tradingsymbol;
                const quantity = h.quantity ?? 0;
                if (!symbol || quantity <= 0) continue;
                snapshot.set(symbol, {
                    symbol,
                    quantity,
                    avgPrice: h.average_price ?? 0,
                    source: 'holdings',
                });
            }
        } else {
            log.warn({ err: holdingsResult.reason?.message }, 'getHoldings() failed — omitting delivery holdings');
        }

        // ── Normalize positions (intraday) ────────────────────────────────
        if (positionsResult.status === 'fulfilled') {
            const raw = positionsResult.value;
            // Kite wraps positions in { net: [...], day: [...] }
            const rawPositions = Array.isArray(raw) ? raw : (raw?.net || []);
            for (const p of rawPositions) {
                const symbol = p.tradingsymbol;
                // netQuantity is the definitive field; quantity is a fallback
                const quantity = p.netQuantity ?? p.quantity ?? 0;
                if (!symbol || quantity === 0) continue;
                const avgPrice = p.average_price ?? 0;

                if (snapshot.has(symbol)) {
                    // Symbol already in holdings — merge (sum quantities, weighted avg price)
                    const existing = snapshot.get(symbol);
                    const totalQty = existing.quantity + quantity;
                    const weightedAvgPrice = totalQty > 0
                        ? (existing.avgPrice * existing.quantity + avgPrice * quantity) / totalQty
                        : 0;
                    snapshot.set(symbol, {
                        symbol,
                        quantity: totalQty,
                        avgPrice: weightedAvgPrice,
                        source: 'both',
                    });
                } else {
                    snapshot.set(symbol, {
                        symbol,
                        quantity,
                        avgPrice,
                        source: 'positions',
                    });
                }
            }
        } else {
            log.warn({ err: positionsResult.reason?.message }, 'getPositions() failed — omitting intraday positions');
        }

        if (holdingsResult.status === 'rejected' && positionsResult.status === 'rejected') {
            log.warn('Both getHoldings() and getPositions() failed — returning empty snapshot');
            return new Map();
        }

        // ── Cache result ──────────────────────────────────────────────────
        if (this.redis) {
            try {
                const serializable = Object.fromEntries(snapshot);
                await this.redis.set(cacheKey, JSON.stringify(serializable), 'EX', 300);
            } catch (cacheErr) {
                log.warn({ err: cacheErr.message }, 'Holdings snapshot cache write failed — non-fatal');
            }
        }

        log.debug({ count: snapshot.size }, 'Holdings snapshot built');
        return snapshot;
    }

    /**
     * Return the exposure entry for a single symbol, or null if none.
     *
     * @param {string} symbol
     * @returns {Promise<{ symbol: string, quantity: number, avgPrice: number, source: string } | null>}
     */
    async getExposure(symbol) {
        try {
            const snapshot = await this.getSnapshot();
            return snapshot.get(symbol) ?? null;
        } catch (err) {
            log.warn({ symbol, err: err.message }, 'getExposure failed — returning null');
            return null;
        }
    }

    /**
     * Return total market value of all holdings + positions.
     *
     * @returns {Promise<{ totalValue: number, holdings: Object[] }>}
     */
    async getTotalExposureValue() {
        try {
            const snapshot = await this.getSnapshot();
            const holdings = [...snapshot.values()];
            const totalValue = holdings.reduce(
                (sum, h) => sum + h.quantity * h.avgPrice,
                0
            );
            return { totalValue, holdings };
        } catch (err) {
            log.warn({ err: err.message }, 'getTotalExposureValue failed — returning zeros');
            return { totalValue: 0, holdings: [] };
        }
    }
}
