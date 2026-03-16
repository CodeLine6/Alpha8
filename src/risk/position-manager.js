/**
 * @fileoverview Position Manager for Alpha8
 *
 * FIXES APPLIED:
 *
 *   Fix 19 — _executePartialExit guards on forceExit success before mutating posCtx
 *     Previously posCtx.quantity and posCtx.partialExitDone were mutated even
 *     when forceExit() returned { success: false } (broker order failed).
 *     Engine would then believe it held fewer shares than it actually did,
 *     corrupting all subsequent stop/trail/target calculations.
 *
 *   Fix 22 — checkAll() is now a standalone method callable regardless of
 *     the scheduler's _scanning flag. It was previously embedded inside
 *     _strategyScan() which returns early when _scanning=false (after 3:10 PM).
 *     Positions were unmonitored between square-off warning and square-off,
 *     meaning a stop-loss breach in that 5-minute window was silently ignored.
 *     The scheduler now calls checkAll() in a separate dedicated cron path.
 *     (No change needed here — checkAll() was already standalone; the fix
 *     is in market-scheduler.js which calls it unconditionally.)
 */

import { createLogger } from '../lib/logger.js';
import {
    computeExitLevels,
    evaluateExits,
    updateTrailStop,
} from './exit-strategies.js';

const log = createLogger('position-manager');

export class PositionManager {
    constructor({ engine, broker, config, getLiveSetting }) {
        this.engine = engine;
        this.broker = broker;
        this.enabled = config.POSITION_MGMT_ENABLED ?? true;

        this._base = {
            stopLossPct: config.STOP_LOSS_PCT ?? 1.0,
            trailingStopPct: config.TRAILING_STOP_PCT ?? 1.5,
            profitTargetPct: config.PROFIT_TARGET_PCT ?? 1.8,
            riskRewardRatio: config.RISK_REWARD_RATIO ?? 2.0,
            partialExitEnabled: config.PARTIAL_EXIT_ENABLED ?? true,
            partialExitPct: config.PARTIAL_EXIT_PCT ?? 50,
            signalReversalEnabled: config.SIGNAL_REVERSAL_ENABLED ?? true,
            maxHoldMinutes: config.MAX_HOLD_MINUTES ?? 90,
        };

        this._active = { ...this._base };
        this._getLiveSetting = getLiveSetting || null;

        this._checkAllInProgress = false; // M1 FIX: concurrency guard

        log.info({ enabled: this.enabled, ...this._active }, 'PositionManager initialized');
    }

    // ═══════════════════════════════════════════════════════
    // LIVE SETTINGS REFRESH
    // ═══════════════════════════════════════════════════════

    async _refreshParams() {
        if (!this._getLiveSetting) return;
        try {
            this._active = {
                stopLossPct: await this._getLiveSetting('STOP_LOSS_PCT', this._base.stopLossPct),
                trailingStopPct: await this._getLiveSetting('TRAILING_STOP_PCT', this._base.trailingStopPct),
                profitTargetPct: await this._getLiveSetting('PROFIT_TARGET_PCT', this._base.profitTargetPct),
                riskRewardRatio: await this._getLiveSetting('RISK_REWARD_RATIO', this._base.riskRewardRatio),
                partialExitEnabled: await this._getLiveSetting('PARTIAL_EXIT_ENABLED', this._base.partialExitEnabled),
                partialExitPct: await this._getLiveSetting('PARTIAL_EXIT_PCT', this._base.partialExitPct),
                signalReversalEnabled: await this._getLiveSetting('SIGNAL_REVERSAL_ENABLED', this._base.signalReversalEnabled),
                maxHoldMinutes: await this._getLiveSetting('MAX_HOLD_MINUTES', this._base.maxHoldMinutes),
            };
        } catch (err) {
            log.warn({ err: err.message }, '_refreshParams failed — keeping current values');
        }
    }

    // ═══════════════════════════════════════════════════════
    // PUBLIC
    // ═══════════════════════════════════════════════════════

    /**
     * Check all open positions against exit conditions.
     *
     * Fix 22: This method is intentionally standalone and does not depend on
     * the scheduler's _scanning flag. The scheduler calls it unconditionally
     * (including after _squareOffWarning() deactivates scanning) so that
     * stop-loss and trailing stop exits continue to fire in the 3:10–3:15 window.
     *
     * @param {Object} [opts]
     * @param {Object} [opts.latestSignals] - { [strategy]: 'BUY'|'SELL'|'HOLD' }
     */
    async checkAll({ latestSignals = {} } = {}) {
        if (!this.enabled) return { checked: 0, exits: [], partials: [] };

        // M1 FIX: prevent concurrent checkAll() calls from racing on the same posCtx.
        if (this._checkAllInProgress) {
            log.warn('checkAll() called while already in progress — skipping to prevent race condition');
            return { checked: 0, exits: [], partials: [], skipped: true };
        }
        this._checkAllInProgress = true;

        try {
            await this._refreshParams();

            const positions = this.engine._filledPositions;
            if (positions.size === 0) return { checked: 0, exits: [], partials: [] };

            const symbols = Array.from(positions.keys());
            const priceMap = await this._fetchPricesAndCandles(symbols);
            const exits = [];
            const partials = [];
            const regime = await this._getCurrentRegime();

            for (const [symbol, posCtx] of positions) {
                try {
                    const data = priceMap[symbol];
                    if (!data?.price || data.price <= 0) {
                        log.warn({ symbol }, 'Position check skipped — no price available');
                        continue;
                    }

                    const result = evaluateExits({
                        symbol,
                        posCtx,
                        currentPrice: data.price,
                        recentCloses: data.closes || [],
                        recentHighs: data.highs || [],
                        recentLows: data.lows || [],
                        regime,
                        latestSignals,
                        config: this._active,
                    });

                    if (result.partial) {
                        await this._executePartialExit(symbol, posCtx, data.price, result);
                        partials.push({ symbol, ...result });
                    } else if (result.exit) {
                        const exitResult = await this.engine.forceExit(symbol, data.price, result.reason);
                        exits.push({ symbol, reason: result.reason, meta: result.meta, ...exitResult });
                        await this._notifyExit(symbol, posCtx, data.price, result.reason, result.meta, exitResult);
                    }
                } catch (err) {
                    log.error({ symbol, err: err.message }, 'Position check failed — skipping');
                }
            }

            if (exits.length > 0 || partials.length > 0) {
                log.info({
                    exits: exits.map(e => `${e.symbol}(${e.reason})`),
                    partials: partials.map(p => `${p.symbol}(${p.qty})`),
                }, `PositionManager: ${exits.length} exit(s), ${partials.length} partial(s)`);
            }

            return { checked: symbols.length, exits, partials };
        } finally {
            this._checkAllInProgress = false; // M1 FIX: always release
        }
    }

    async initPosition(symbol, posCtx, recentCloses = [], recentHighs = [], recentLows = []) {
        await this._refreshParams();
        const regime = await this._getCurrentRegime();

        const levels = computeExitLevels({
            entryPrice: posCtx.entryPrice ?? posCtx.price,
            quantity: posCtx.quantity,
            openingStrategy: posCtx.openingStrategy || (posCtx.strategies?.[0] ?? 'UNKNOWN'),
            allStrategies: posCtx.strategies || [],
            regime,
            recentCloses,
            recentHighs,
            recentLows,
            config: this._active,
        });

        Object.assign(posCtx, levels);

        log.info({
            symbol,
            entryPrice: posCtx.entryPrice,
            stopPrice: levels.stopPrice.toFixed(2),
            profitTarget: levels.profitTargetPrice.toFixed(2),
            targetMode: levels.profitTargetMode,
            trailStop: levels.trailStopPrice.toFixed(2),
            trailPct: levels.trailPct?.toFixed(2),
            regime,
            partialEnabled: levels.partialExitEnabled,
            partialQty: levels.partialExitQty,
            signalReversal: levels.signalReversalEnabled,
            openingStrategy: levels.openingStrategy,
        }, `✅ Position levels set for ${symbol}`);
    }

    // ═══════════════════════════════════════════════════════
    // PRIVATE
    // ═══════════════════════════════════════════════════════

    /**
     * Execute a partial exit — sell partialExitQty shares, update posCtx.
     *
     * Fix 19: posCtx is only mutated (quantity reduced, partialExitDone set)
     * AFTER confirming forceExit() returned success:true. Previously the
     * mutation happened unconditionally, causing the engine to believe it held
     * fewer shares than it actually did whenever the broker order failed.
     * @private
     */
    async _executePartialExit(symbol, posCtx, currentPrice, result) {
        log.info({
            symbol,
            partialQty: result.qty,
            remainingQty: posCtx.quantity - result.qty,
            currentPrice,
            gainPct: result.meta?.gainPct,
        }, `📊 PARTIAL EXIT triggered: ${symbol}`);

        try {
            const sellResult = await this.engine.forceExit(
                symbol, currentPrice, 'PARTIAL_EXIT', result.qty
            );

            // Fix 19: Only mutate posCtx state if the broker order actually succeeded.
            if (!sellResult.success) {
                log.error({ symbol, sellResult },
                    'Partial exit broker order failed — posCtx NOT mutated, position state preserved');
                return null;
            }

            // Order confirmed — now it is safe to update in-memory state
            posCtx.quantity -= result.qty;
            posCtx.partialExitDone = true;

            // Break-even protection: trail stop can never go below entry after partial exit
            if (posCtx.trailStopPrice < posCtx.entryPrice) {
                posCtx.trailStopPrice = posCtx.entryPrice;
                log.info({ symbol }, 'Trail stop moved to break-even after partial exit');
            }

            if (this.engine.telegram?.enabled) {
                const pnl = (currentPrice - posCtx.entryPrice) * result.qty;
                const pnlStr = `+₹${pnl.toFixed(2)}`;
                this.engine.telegram.sendRaw(
                    `📊 <b>Partial Exit — ${symbol}</b>\n\n` +
                    `📌 Sold ${result.qty} shares at ₹${currentPrice.toFixed(2)}\n` +
                    `💰 Locked in: ${pnlStr} (+${result.meta?.gainPct}%)\n` +
                    `📦 Remaining: ${posCtx.quantity} shares still open\n` +
                    `🎯 Trail stop → break-even: ₹${posCtx.entryPrice.toFixed(2)}\n` +
                    `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
                ).catch(() => { });
            }

            return sellResult;
        } catch (err) {
            log.error({ symbol, err: err.message }, 'Partial exit threw — posCtx NOT mutated');
            return null;
        }
    }

    /** @private */
    async _notifyExit(symbol, posCtx, exitPrice, reason, meta, exitResult) {
        if (!this.engine.telegram?.enabled) return;

        const pnl = exitResult?.pnl ?? (exitPrice - posCtx.entryPrice) * posCtx.quantity;
        const pnlPct = posCtx.entryPrice > 0
            ? ((exitPrice - posCtx.entryPrice) / posCtx.entryPrice * 100).toFixed(2)
            : '0.00';

        const emoji = pnl >= 0 ? '✅' : '🛑';
        // P&amp;L correctly escaped for Telegram HTML mode
        const pnlStr = pnl >= 0
            ? `+₹${pnl.toFixed(2)} (+${pnlPct}%)`
            : `-₹${Math.abs(pnl).toFixed(2)} (${pnlPct}%)`;

        const reasonDetails = {
            STOP_LOSS: `🛑 Hard stop hit at ₹${meta?.trigger?.toFixed(2)}`,
            PROFIT_TARGET: `🎯 Target hit (${meta?.mode === 'FIXED_PCT' ? 'fixed %' : `${posCtx.riskRewardRatio}× R/R`})`,
            TRAILING_STOP: `📉 Trail stop — high was ₹${meta?.highWaterMark?.toFixed(2)}, locked ${meta?.lockedPnlPct ?? '?'}%`,
            SIGNAL_REVERSAL: `🔄 ${meta?.strategy} fired ${meta?.signal} — reversal detected`,
            TIME_EXIT: `⏰ Max hold time (${meta?.holdMinutes}min) — P&amp;L was ${meta?.pnlPct}%`,
        }[reason] ?? reason;

        await this.engine.telegram.sendRaw(
            `${emoji} <b>Position Exit — ${symbol}</b>\n\n` +
            `${reasonDetails}\n\n` +
            `📥 Entry:  ₹${posCtx.entryPrice.toFixed(2)}\n` +
            `📤 Exit:   ₹${exitPrice.toFixed(2)}\n` +
            `💰 P&amp;L:   ${pnlStr}\n` +
            `📦 Qty:    ${posCtx.quantity}\n` +
            `🏦 Strategy: ${posCtx.openingStrategy || 'unknown'}\n` +
            `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
        ).catch(() => { });
    }

    /** @private */
    async _fetchPricesAndCandles(symbols) {
        const result = {};

        if (this.broker) {
            try {
                const keys = symbols.map(s => `NSE:${s}`);
                // C5 FIX: hard 10-second timeout on LTP fetch to prevent unbounded blocking.
                const LTP_TIMEOUT_MS = 10000;
                const ltp = await Promise.race([
                  this.broker.getLTP(keys),
                  new Promise((_, reject) =>
                    setTimeout(
                      () => reject(new Error(`LTP fetch timed out after ${LTP_TIMEOUT_MS}ms`)),
                      LTP_TIMEOUT_MS
                    )
                  ),
                ]);

                for (const sym of symbols) {
                    const price = ltp?.[`NSE:${sym}`]?.last_price;
                    if (price && price > 0) {
                        result[sym] = { price, closes: [], highs: [], lows: [] };
                    }
                }
            } catch (err) {
                log.error({ err: err.message, symbols },
                  'LTP fetch failed/timed out in position manager — positions skipped this cycle');
                return result;
            }
        }

        if (this.engine._fetchCandles) {
            await Promise.allSettled(
                symbols
                    .filter(s => result[s])
                    .map(async (sym) => {
                        try {
                            // C5 FIX: Also apply timeout to candle fetches
                            const CANDLE_TIMEOUT_MS = 8000;
                            const candles = await Promise.race([
                              this.engine._fetchCandles(sym, 20),
                              new Promise((_, reject) =>
                                setTimeout(() => reject(new Error('Candle fetch timed out')), CANDLE_TIMEOUT_MS)
                              ),
                            ]);

                            if (candles?.length >= 15) {
                                result[sym].closes = candles.map(c => c.close);
                                result[sym].highs = candles.map(c => c.high);
                                result[sym].lows = candles.map(c => c.low);
                            }
                        } catch { /* ATR falls back to fixed % */ }
                    })
            );
        }

        return result;
    }

    /** @private */
    async _getCurrentRegime() {
        try {
            const detector = this.engine?.pipeline?.regimeDetector;
            if (detector?.getRegime) {
                const r = await detector.getRegime();
                return r?.regime || 'UNKNOWN';
            }
        } catch { /* */ }
        return 'UNKNOWN';
    }
}