/**
 * @fileoverview Rolling Tick Buffer for Alpha8
 *
 * Maintains a per-symbol circular buffer of the last N classified ticks.
 * Provides aggregated volume imbalance metrics for BAVI strategy.
 *
 * Memory: 200 ticks × ~5 fields × 8 bytes × 50 symbols ≈ 4MB — acceptable.
 *
 * Thread safety: Node.js is single-threaded. No locking needed.
 */

import { TICK_SIDE } from './tick-classifier.js';

const DEFAULT_WINDOW = 200;   // number of ticks in rolling window
const IMBALANCE_HISTORY = 10; // number of imbalance snapshots to track trend

/**
 * @typedef {Object} ImbalanceSnapshot
 * @property {number} imbalance   - -1.0 to +1.0
 * @property {number} buyVolume
 * @property {number} sellVolume
 * @property {number} totalVolume
 * @property {number} timestamp
 */

export class RollingTickBuffer {
    /**
     * @param {Object} [options]
     * @param {number} [options.windowSize=200]  ticks per symbol
     * @param {number} [options.historySize=10]  imbalance snapshots for trend
     */
    constructor(options = {}) {
        this._windowSize = options.windowSize ?? DEFAULT_WINDOW;
        this._historySize = options.historySize ?? IMBALANCE_HISTORY;

        // symbol → CircularBuffer of ClassifiedTick
        this._buffers = new Map();

        // symbol → rolling imbalance snapshots for trend detection
        this._imbalanceHistory = new Map();
    }

    // ── Write ────────────────────────────────────────────────────────────────

    /**
     * Add a classified tick to a symbol's buffer.
     * @param {string} symbol
     * @param {import('./tick-classifier.js').ClassifiedTick} tick
     */
    push(symbol, tick) {
        if (!this._buffers.has(symbol)) {
            this._buffers.set(symbol, []);
            this._imbalanceHistory.set(symbol, []);
        }

        const buf = this._buffers.get(symbol);
        buf.push(tick);

        // Trim to window size (circular buffer behaviour)
        if (buf.length > this._windowSize) {
            buf.shift();
        }

        // Snapshot imbalance every 10 ticks for trend tracking
        if (buf.length % 10 === 0) {
            const snap = this._computeImbalance(buf);
            const hist = this._imbalanceHistory.get(symbol);
            hist.push({ ...snap, timestamp: tick.timestamp });
            if (hist.length > this._historySize) hist.shift();
        }
    }

    // ── Read ─────────────────────────────────────────────────────────────────

    /**
     * Get current imbalance metrics for a symbol.
     *
     * @param {string} symbol
     * @returns {{
     *   imbalance:    number,   // -1.0 to +1.0 (positive = more buying)
     *   buyVolume:    number,
     *   sellVolume:   number,
     *   totalVolume:  number,
     *   tickCount:    number,
     *   trend:        'RISING'|'FALLING'|'FLAT'|'INSUFFICIENT',
     *   trendStrength: number,  // 0-1, how consistent the trend is
     *   isReliable:   boolean,  // false if < minTicks in buffer
     * } | null}
     */
    getImbalance(symbol) {
        const buf = this._buffers.get(symbol);
        if (!buf || buf.length < 20) {
            return {
                imbalance: 0,
                buyVolume: 0,
                sellVolume: 0,
                totalVolume: 0,
                tickCount: buf?.length ?? 0,
                trend: 'INSUFFICIENT',
                trendStrength: 0,
                isReliable: false,
            };
        }

        const snap = this._computeImbalance(buf);
        const hist = this._imbalanceHistory.get(symbol) ?? [];
        const trend = this._computeTrend(hist);

        return {
            ...snap,
            tickCount: buf.length,
            trend: trend.direction,
            trendStrength: trend.strength,
            isReliable: buf.length >= 50,   // at least 50 ticks for confidence
        };
    }

    /**
     * Get raw tick buffer for a symbol.
     * @param {string} symbol
     * @returns {Array}
     */
    getTicks(symbol) {
        return this._buffers.get(symbol) ?? [];
    }

    /**
     * Number of ticks buffered for a symbol.
     */
    size(symbol) {
        return this._buffers.get(symbol)?.length ?? 0;
    }

    /**
     * Reset buffer for a symbol (call at session start).
     */
    reset(symbol) {
        this._buffers.delete(symbol);
        this._imbalanceHistory.delete(symbol);
    }

    /**
     * Reset all symbols (call at market open 9:15 AM).
     */
    resetAll() {
        this._buffers.clear();
        this._imbalanceHistory.clear();
    }

    // ── Private ──────────────────────────────────────────────────────────────

    _computeImbalance(ticks) {
        let buyVolume = 0;
        let sellVolume = 0;

        for (const tick of ticks) {
            if (tick.side === TICK_SIDE.BUY) {
                buyVolume += tick.quantity;
            } else if (tick.side === TICK_SIDE.SELL) {
                sellVolume += tick.quantity;
            }
            // NEUTRAL ticks excluded from imbalance calculation
        }

        const totalVolume = buyVolume + sellVolume;
        const imbalance = totalVolume > 0
            ? (buyVolume - sellVolume) / totalVolume
            : 0;

        return {
            imbalance: +imbalance.toFixed(4),
            buyVolume,
            sellVolume,
            totalVolume,
        };
    }

    /**
     * Determine trend direction from imbalance history snapshots.
     * RISING  = imbalance consistently increasing (more buying pressure)
     * FALLING = imbalance consistently decreasing (more selling pressure)
     * FLAT    = no clear direction
     */
    _computeTrend(history) {
        if (history.length < 3) {
            return { direction: 'INSUFFICIENT', strength: 0 };
        }

        const recent = history.slice(-5);  // last 5 snapshots
        let rises = 0, falls = 0;

        for (let i = 1; i < recent.length; i++) {
            const delta = recent[i].imbalance - recent[i - 1].imbalance;
            if (delta > 0.02) rises++;
            else if (delta < -0.02) falls++;
        }

        const total = recent.length - 1;
        const strength = Math.max(rises, falls) / total;

        if (rises > falls && rises >= Math.ceil(total * 0.6)) {
            return { direction: 'RISING', strength: +strength.toFixed(2) };
        }
        if (falls > rises && falls >= Math.ceil(total * 0.6)) {
            return { direction: 'FALLING', strength: +strength.toFixed(2) };
        }
        return { direction: 'FLAT', strength: 0 };
    }
}