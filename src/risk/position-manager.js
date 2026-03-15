/**
 * @fileoverview Position Manager for Alpha8
 *
 * Monitors all open positions every scan cycle and executes exits
 * based on five exit strategies, in priority order:
 *
 *   1. STOP_LOSS       — hard floor, immediate exit
 *   2. PROFIT_TARGET   — full exit at target (strategy-aware)
 *   3. PARTIAL_EXIT    — sell 50% at target, let rest trail
 *   4. TRAILING_STOP   — ATR + regime-adjusted, never moves down
 *   5. SIGNAL_REVERSAL — opening strategy fires opposite signal
 *   6. TIME_EXIT       — max hold time on flat/losing positions
 *
 * LIVE SETTINGS (all tunable from dashboard or /set Telegram):
 *   STOP_LOSS_PCT, TRAILING_STOP_PCT, PROFIT_TARGET_PCT,
 *   RISK_REWARD_RATIO, PARTIAL_EXIT_ENABLED, PARTIAL_EXIT_PCT,
 *   SIGNAL_REVERSAL_ENABLED, MAX_HOLD_MINUTES
 */

import { createLogger } from '../lib/logger.js';
import {
    computeExitLevels,
    evaluateExits,
    updateTrailStop,
} from './exit-strategies.js';

const log = createLogger('position-manager');

export class PositionManager {
    /**
     * @param {Object} opts
     * @param {import('../engine/execution-engine.js').ExecutionEngine} opts.engine
     * @param {import('../api/broker-manager.js').BrokerManager|null}  opts.broker
     * @param {Object}   opts.config          - validated env config
     * @param {Function} [opts.getLiveSetting] - live settings reader fn(key, fallback)
     */
    constructor({ engine, broker, config, getLiveSetting }) {
        this.engine = engine;
        this.broker = broker;
        this.enabled = config.POSITION_MGMT_ENABLED ?? true;

        // ── Base defaults from config/env ────────────────────────────────────────
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

        // Active values (refreshed each checkAll cycle)
        this._active = { ...this._base };

        // Live settings provider
        this._getLiveSetting = getLiveSetting || null;

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
    // PUBLIC: called every scan cycle from market-scheduler
    // ═══════════════════════════════════════════════════════

    /**
     * Check all open positions against exit conditions.
     * Called before the strategy scan each cycle.
     *
     * @param {Object} [opts]
     * @param {Object} [opts.latestSignals] - { [strategy]: 'BUY'|'SELL'|'HOLD' }
     *   Passed in from the scheduler after strategies run their analysis.
     *   Used for signal reversal detection.
     * @returns {Promise<{ checked: number, exits: Object[], partials: Object[] }>}
     */
    async checkAll({ latestSignals = {} } = {}) {
        if (!this.enabled) return { checked: 0, exits: [], partials: [] };

        await this._refreshParams();

        const positions = this.engine._filledPositions;
        if (positions.size === 0) return { checked: 0, exits: [], partials: [] };

        const symbols = Array.from(positions.keys());
        const priceMap = await this._fetchPricesAndCandles(symbols);
        const exits = [];
        const partials = [];

        // Get current regime for trail stop adjustment
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
                    // ── Partial exit ──────────────────────────────────────────────────
                    await this._executePartialExit(symbol, posCtx, data.price, result);
                    partials.push({ symbol, ...result });
                } else if (result.exit) {
                    // ── Full exit ─────────────────────────────────────────────────────
                    const exitResult = await this.engine.forceExit(
                        symbol, data.price, result.reason
                    );
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
    }

    /**
     * Initialise exit levels for a newly opened position.
     * Call this immediately after a BUY is filled and posCtx is created.
     *
     * @param {string}   symbol
     * @param {Object}   posCtx             - position context to mutate in place
     * @param {string[]} recentCloses
     * @param {string[]} recentHighs
     * @param {string[]} recentLows
     * @returns {Promise<void>}
     */
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
            initialTrailStop: levels.trailStopPrice.toFixed(2),
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
            // Place a SELL for partialExitQty shares
            const sellResult = await this.engine.forceExit(
                symbol, currentPrice, 'PARTIAL_EXIT', result.qty
            );

            // Update posCtx: reduce quantity, mark partial done
            posCtx.quantity -= result.qty;
            posCtx.partialExitDone = true;

            // After partial exit, tighten the trail stop to entry price
            // (break-even protection — the remaining shares should not lose money)
            if (posCtx.trailStopPrice < posCtx.entryPrice) {
                posCtx.trailStopPrice = posCtx.entryPrice;
                log.info({ symbol }, 'Trail stop moved to break-even after partial exit');
            }

            if (this.engine.telegram?.enabled) {
                const pnl = (currentPrice - posCtx.entryPrice) * result.qty;
                const pnlStr = `+₹${pnl.toFixed(2)}`;
                this.engine.telegram.sendRaw(
                    `📊 <b>Partial Exit — ${symbol}</b>\n\n` +
                    `📌 Sold ${result.qty} of ${result.qty + posCtx.quantity} shares at ₹${currentPrice.toFixed(2)}\n` +
                    `💰 Locked in: ${pnlStr} (+${result.meta?.gainPct}%)\n` +
                    `📦 Remaining: ${posCtx.quantity} shares still open\n` +
                    `🎯 Trail stop moved to break-even: ₹${posCtx.entryPrice.toFixed(2)}\n` +
                    `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
                ).catch(() => { });
            }

            return sellResult;
        } catch (err) {
            log.error({ symbol, err: err.message }, 'Partial exit failed');
        }
    }

    /**
     * Send Telegram notification for a full exit.
     * @private
     */
    async _notifyExit(symbol, posCtx, exitPrice, reason, meta, exitResult) {
        if (!this.engine.telegram?.enabled) return;

        const pnl = exitResult?.pnl ?? (exitPrice - posCtx.entryPrice) * posCtx.quantity;
        const pnlPct = posCtx.entryPrice > 0
            ? ((exitPrice - posCtx.entryPrice) / posCtx.entryPrice * 100).toFixed(2)
            : '0.00';

        const emoji = pnl >= 0 ? '✅' : '🛑';
        const pnlStr = pnl >= 0
            ? `+₹${pnl.toFixed(2)} (+${pnlPct}%)`
            : `-₹${Math.abs(pnl).toFixed(2)} (${pnlPct}%)`;

        // Reason-specific context
        const reasonDetails = {
            STOP_LOSS: `🛑 Hard stop hit at ₹${meta?.trigger?.toFixed(2)}`,
            PROFIT_TARGET: `🎯 Target hit (${meta?.mode === 'FIXED_PCT' ? `${posCtx.profitTargetPct}% fixed` : `${posCtx.riskRewardRatio}× R/R`})`,
            TRAILING_STOP: `📉 Trail stop — high was ₹${meta?.highWaterMark?.toFixed(2)}, locked ${meta?.lockedPnlPct ?? '?'}%`,
            SIGNAL_REVERSAL: `🔄 ${meta?.strategy} fired ${meta?.signal} — reversal detected`,
            TIME_EXIT: `⏰ Max hold time (${meta?.holdMinutes}min) — P&L was ${meta?.pnlPct}%`,
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

    /**
     * Fetch current prices + recent OHLCV candles for all held symbols.
     * One LTP batch call + one candle fetch per symbol (candles cached).
     * @private
     */
    async _fetchPricesAndCandles(symbols) {
        const result = {};

        // ── Batch LTP fetch ───────────────────────────────────────────────────
        if (this.broker) {
            try {
                const keys = symbols.map(s => `NSE:${s}`);
                const ltp = await this.broker.getLTP(keys);
                for (const sym of symbols) {
                    const price = ltp?.[`NSE:${sym}`]?.last_price;
                    if (price && price > 0) {
                        result[sym] = { price, closes: [], highs: [], lows: [] };
                    }
                }
            } catch (err) {
                log.error({ err: err.message }, 'LTP fetch failed in position manager');
                return result;
            }
        }

        // ── Per-symbol candle fetch for ATR ────────────────────────────────────
        // Only fetch if we have a historical data fetcher on the engine
        if (this.engine._fetchCandles) {
            await Promise.allSettled(
                symbols
                    .filter(s => result[s])
                    .map(async (sym) => {
                        try {
                            const candles = await this.engine._fetchCandles(sym, 20);
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

    /**
     * Read current regime from pipeline's regime detector.
     * Falls back to 'UNKNOWN' if unavailable.
     * @private
     */
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