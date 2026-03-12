/**
 * @fileoverview Position Manager for Alpha8
 *
 * Runs every 5 minutes BEFORE the strategy scan.
 * Checks each open position independently against three exit conditions:
 *
 *   1. STOP_LOSS     — price dropped below entry * (1 - stopPct/100)
 *                      Exit immediately. No consensus required.
 *
 *   2. TRAILING_STOP — price pulled back from session high beyond trail %
 *                      Only fires if high water mark > entry (position went green first).
 *                      Locks in profit.
 *
 *   3. TIME_EXIT     — position open > MAX_HOLD_MINUTES AND pnlPct < 0.3%
 *                      Do NOT time-exit profitable positions — let trailing stop handle those.
 *
 * Priority: STOP_LOSS > TRAILING_STOP > TIME_EXIT
 * If multiple conditions are true, only one exit fires (highest priority).
 *
 * High water mark is updated by MUTATING the existing posCtx reference in
 * _filledPositions — never replacing the entire entry (would lose strategies[]).
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('position-manager');

export class PositionManager {
    /**
     * @param {Object} opts
     * @param {import('../engine/execution-engine.js').ExecutionEngine} opts.engine
     * @param {import('../api/broker-manager.js').BrokerManager | null} opts.broker
     * @param {Object} opts.config - Validated env config object
     */
    constructor({ engine, broker, config }) {
        this.engine = engine;
        this.broker = broker;
        this.enabled = config.POSITION_MGMT_ENABLED ?? true;
        this.maxHoldMinutes = config.MAX_HOLD_MINUTES ?? 90;

        log.info({
            enabled: this.enabled,
            maxHoldMinutes: this.maxHoldMinutes,
        }, 'PositionManager initialized');
    }

    /**
     * Check all open positions against exit conditions.
     * Called every scan cycle BEFORE the strategy scan, awaited.
     *
     * Must complete before strategy scan so force-exited symbols are removed
     * from _filledPositions before new signals are evaluated.
     *
     * @returns {Promise<{ checked: number, exits: Object[] }>}
     */
    async checkAll() {
        if (!this.enabled) return { checked: 0, exits: [] };

        const positions = this.engine._filledPositions;
        if (positions.size === 0) return { checked: 0, exits: [] };

        const symbols = Array.from(positions.keys());
        const priceMap = await this._fetchPrices(symbols);

        const exits = [];

        for (const [symbol, posCtx] of positions) {
            try {
                const currentPrice = priceMap[symbol];

                if (!currentPrice || currentPrice <= 0) {
                    log.warn({ symbol }, 'Position check skipped — could not fetch price');
                    continue;
                }

                // Update high water mark if price has risen — always, every scan.
                // Mutates posCtx in place — does NOT replace the map entry.
                if (currentPrice > posCtx.highWaterMark) {
                    posCtx.highWaterMark = currentPrice;

                    // Calculate raw trailing stop
                    let newTrailStop = currentPrice * (1 - posCtx.trailPct / 100);

                    // Break-Even Protection: 
                    // If the High Water Mark is > 0.5% above Entry, 
                    // the Trailing Stop can NEVER fall below the Entry Price.
                    const isSignificantlyProfitable = posCtx.highWaterMark >= posCtx.entryPrice * 1.005;
                    if (isSignificantlyProfitable && newTrailStop < posCtx.entryPrice) {
                        newTrailStop = posCtx.entryPrice;
                    }

                    posCtx.trailStopPrice = newTrailStop;

                    log.debug({
                        symbol,
                        newHighWaterMark: currentPrice,
                        newTrailStop: posCtx.trailStopPrice.toFixed(2),
                        breakEvenLocked: isSignificantlyProfitable && newTrailStop === posCtx.entryPrice
                    }, 'High water mark updated');
                }

                const exitReason = this._getExitReason(symbol, posCtx, currentPrice);

                if (exitReason) {
                    const result = await this.engine.forceExit(symbol, currentPrice, exitReason);
                    exits.push({ symbol, reason: exitReason, ...result });

                    // Telegram alert for every position manager exit
                    if (this.engine.telegram?.enabled) {
                        const emoji = result.pnl >= 0 ? '✅' : '🛑';
                        const pnlStr = result.pnl >= 0
                            ? `+₹${result.pnl.toFixed(2)}`
                            : `-₹${Math.abs(result.pnl).toFixed(2)}`;

                        this.engine.telegram.sendRaw(
                            `${emoji} <b>Position Exit — ${symbol}</b>\n\n` +
                            `📌 Reason: ${exitReason.replace(/_/g, ' ')}\n` +
                            `📥 Entry: ₹${posCtx.entryPrice.toFixed(2)}\n` +
                            `📤 Exit:  ₹${currentPrice.toFixed(2)}\n` +
                            `💰 P&L:   ${pnlStr}\n` +
                            `📦 Qty:   ${posCtx.quantity}\n` +
                            `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
                        ).catch(() => { });
                    }
                }
            } catch (err) {
                log.error({ symbol, err: err.message }, 'Position check failed for symbol — skipping');
            }
        }

        if (exits.length > 0) {
            log.info({
                exits: exits.map(e => `${e.symbol}(${e.reason})`),
            }, `Position manager: ${exits.length} exit(s) triggered`);
        }

        return { checked: symbols.length, exits };
    }

    /**
     * Determine exit reason for a position. Pure synchronous logic — no I/O.
     *
     * Priority: STOP_LOSS > TRAILING_STOP > TIME_EXIT
     *
     * @param {string} symbol
     * @param {Object} posCtx - Position context from _filledPositions
     * @param {number} currentPrice
     * @returns {'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_EXIT' | null}
     */
    _getExitReason(symbol, posCtx, currentPrice) {
        // ── Priority 1: Hard stop loss ──────────────────────────────────────
        if (currentPrice <= posCtx.stopPrice) {
            log.warn({
                symbol,
                currentPrice,
                stopPrice: posCtx.stopPrice.toFixed(2),
                entryPrice: posCtx.entryPrice.toFixed(2),
                dropPct: (((posCtx.entryPrice - currentPrice) / posCtx.entryPrice) * 100).toFixed(2),
            }, `🛑 STOP LOSS triggered: ${symbol}`);
            return 'STOP_LOSS';
        }

        // ── Priority 2: Trailing stop ────────────────────────────────────────
        // Only fires if highWaterMark > entryPrice (position went green at least once).
        // Prevents trail from triggering on a position that went straight down —
        // that's the hard stop's job.
        if (currentPrice <= posCtx.trailStopPrice && posCtx.highWaterMark > posCtx.entryPrice) {
            const lockedInPnL = (posCtx.trailStopPrice - posCtx.entryPrice) * posCtx.quantity;
            log.warn({
                symbol,
                currentPrice,
                trailStopPrice: posCtx.trailStopPrice.toFixed(2),
                highWaterMark: posCtx.highWaterMark.toFixed(2),
                lockedInPnL: lockedInPnL.toFixed(2),
            }, `📉 TRAILING STOP triggered: ${symbol}`);
            return 'TRAILING_STOP';
        }

        // ── Priority 3: Time exit ─────────────────────────────────────────────
        // Only for flat or losing positions (pnlPct < 0.3%).
        // Profitable positions should be let run — trailing stop will capture the exit.
        const holdMinutes = (Date.now() - posCtx.timestamp) / 60000;
        const pnlPct = ((currentPrice - posCtx.entryPrice) / posCtx.entryPrice) * 100;

        if (holdMinutes >= this.maxHoldMinutes && pnlPct < 0.3) {
            log.warn({
                symbol,
                holdMinutes: holdMinutes.toFixed(0),
                maxHoldMinutes: this.maxHoldMinutes,
                pnlPct: pnlPct.toFixed(2),
            }, `⏰ TIME EXIT triggered: ${symbol}`);
            return 'TIME_EXIT';
        }

        return null; // Hold
    }

    /**
     * Fetch current prices for all held symbols in one broker call.
     * Failure is non-fatal — returns empty map, position checks are skipped.
     *
     * Response shape: ltp['NSE:SYMBOL'].last_price
     *
     * @param {string[]} symbols
     * @returns {Promise<Record<string, number>>}
     */
    async _fetchPrices(symbols) {
        const priceMap = {};
        if (!this.broker || symbols.length === 0) return priceMap;

        try {
            const keys = symbols.map(s => `NSE:${s}`);
            const ltp = await this.broker.getLTP(keys);

            for (const symbol of symbols) {
                const price = ltp?.[`NSE:${symbol}`]?.last_price;
                if (price && price > 0) priceMap[symbol] = price;
            }
        } catch (err) {
            log.error({ symbols, err: err.message }, 'Position manager price fetch failed — position checks skipped');
        }

        return priceMap;
    }
}
