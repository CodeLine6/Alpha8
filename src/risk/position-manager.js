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
import { getRedis } from '../lib/redis.js';
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
            // PnL-aware trailing stop params
            pnlTrailPct: config.PNL_TRAIL_PCT ?? 25,
            pnlTrailFloor: config.PNL_TRAIL_FLOOR ?? 0,
            trailMode: config.TRAIL_MODE ?? 'PNL_TRAIL',
            useAtrTrail: config.USE_ATR_TRAIL ?? true,
        };

        this._active = { ...this._base };
        this._getLiveSetting = getLiveSetting || null;

        this._checkAllInProgress = false; // M1 FIX: concurrency guard

        // ── Periodic peak PnL sync (bombproof fallback) ──────────────────
        // Runs every 10s independent of tick feed. Directly reads the latest
        // tick from position context and computes peak PnL. This catches ANY
        // case where evaluateTick doesn't fire (symbol mismatch, tick feed
        // disconnected, isExiting stuck, etc.)
        this._peakSyncInterval = setInterval(() => this._syncPeakPnl(), 3_000);
        this._peakSyncInterval.unref(); // Don't block process exit

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
                // PnL-aware trailing stop params wired to live settings
                pnlTrailPct: Number(await this._getLiveSetting('PNL_TRAIL_PCT', this._base.pnlTrailPct)),
                pnlTrailFloor: Number(await this._getLiveSetting('PNL_TRAIL_FLOOR', this._base.pnlTrailFloor)),
                trailMode: await this._getLiveSetting('TRAIL_MODE', this._base.trailMode),
                useAtrTrail: (await this._getLiveSetting('USE_ATR_TRAIL', this._base.useAtrTrail)) !== false
                    && (await this._getLiveSetting('USE_ATR_TRAIL', this._base.useAtrTrail)) !== 'false',
            };
        } catch (err) {
            log.warn({ err: err.message }, '_refreshParams failed — keeping current values');
        }
    }

    /**
     * Dynamically synchronizes global live risk parameters with all active open positions.
     * Overwrites the entry-time stop-loss and profit-target prices so that changing a 
     * setting mid-trade instantly scales the risk management levels for all active positions.
     */
    _syncActivePositionsToLiveParams() {
        const stopPct = this._active.stopLossPct ?? this._active.STOP_LOSS_PCT ?? 1.0;
        const targetPct = this._active.profitTargetPct ?? this._active.PROFIT_TARGET_PCT ?? 1.8;
        const rrRatio = this._active.riskRewardRatio ?? this._active.RISK_REWARD_RATIO ?? 2.0;

        for (const [symbol, posCtx] of this.engine._filledPositions.entries()) {
            const entry = posCtx.entryPrice ?? posCtx.price;
            const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';

            const newStop = isShort
                ? entry * (1 + stopPct / 100)
                : entry * (1 - stopPct / 100);

            const MEAN_REVERSION = new Set(['RSI_MEAN_REVERSION']);
            const targetMode = MEAN_REVERSION.has(posCtx.openingStrategy) ? 'FIXED_PCT' : 'RISK_REWARD';

            let newTarget;
            if (isShort) {
                newTarget = targetMode === 'FIXED_PCT'
                    ? entry * (1 - targetPct / 100)
                    : entry - (newStop - entry) * rrRatio;
            } else {
                newTarget = targetMode === 'FIXED_PCT'
                    ? entry * (1 + targetPct / 100)
                    : entry + (entry - newStop) * rrRatio;
            }

            // Static bounds sync natively on global change

            posCtx.profitTargetPrice = newTarget;
            posCtx.profitTargetMode = targetMode;

            if (posCtx.hydratedFromDB) {
                posCtx.stopPrice = newStop;
                posCtx.hydratedFromDB = false; // Synced!
            }
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
            this._syncActivePositionsToLiveParams(); // Fix: sync global live params to open positions

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

                    // Redis Trail Persistence Hook — execute synchronously so memory matches Redis
                    if (!result.exit || result.partial) {
                        // Self-healing safeguard (same as evaluateTick):
                        // If updateTrailStop didn't advance peak, force-compute it here
                        const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';
                        const entry   = posCtx.entryPrice ?? posCtx.price;
                        const unrealizedPnl = isShort
                            ? (entry - data.price) * posCtx.quantity
                            : (data.price - entry)  * posCtx.quantity;
                        const currentPeak = posCtx.peakUnrealizedPnl ?? 0;
                        if (unrealizedPnl > currentPeak) {
                            if (currentPeak <= 0 && unrealizedPnl > 0) {
                                log.warn({ symbol, unrealizedPnl, peak: currentPeak,
                                    trailMode: posCtx.trailMode },
                                    'checkAll: SELF-HEAL — peak was stuck, forcing update');
                            }
                            posCtx.peakUnrealizedPnl = unrealizedPnl;
                            posCtx.peakPnlAt = Date.now();
                        }

                        if (posCtx.peakUnrealizedPnl !== undefined && posCtx.pnlTrailStop !== undefined) {
                            getRedis().hset(`trail:${symbol}`,
                                'peakUnrealizedPnl', String(posCtx.peakUnrealizedPnl),
                                'pnlTrailStop', String(posCtx.pnlTrailStop)
                            ).catch(e => log.debug({ err: e.message }, 'Failed to save trail to Redis'));
                        }
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

    // ═══════════════════════════════════════════════════════
    // PERIODIC SAFETY NET (bombproof fallback)
    // ═══════════════════════════════════════════════════════

    /**
     * Comprehensive safety net that runs every 3 seconds.
     * Fetches prices from the BROKER (not tick feed), so it works even when
     * evaluateTick never fires for a symbol (symbol mapping mismatch, tick
     * feed disconnected, etc.).
     *
     * On every cycle it:
     *  1. Gets LTP from broker for all open positions
     *  2. Updates peak PnL in memory
     *  3. Ratchets trail stop in memory
     *  4. ALWAYS writes peak + trail to Redis (not just when peak advances)
     *  5. Triggers exits if trail stop or hard stop is breached
     */
    async _syncPeakPnl() {
        if (!this.enabled) return;
        if (this._syncInProgress) return;  // concurrency guard
        this._syncInProgress = true;

        try {
            const positions = this.engine._filledPositions;
            if (!positions || positions.size === 0) return;

            const symbols = Array.from(positions.keys());

            // ── 1. Get prices: broker LTP first (guaranteed), tick cache fallback ──
            const prices = {};

            // Broker LTP — single API call for all symbols
            if (this.broker) {
                try {
                    const keys = symbols.map(s => `NSE:${s}`);
                    const ltp = await Promise.race([
                        this.broker.getLTP(keys),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('LTP timeout')), 5000)),
                    ]);
                    for (const sym of symbols) {
                        const p = ltp?.[`NSE:${sym}`]?.last_price;
                        if (p && p > 0) prices[sym] = p;
                    }
                } catch (err) {
                    log.debug({ err: err.message }, '_syncPeakPnl: broker LTP failed, using tick cache');
                }
            }

            // Tick cache fallback for symbols broker missed
            for (const sym of symbols) {
                if (prices[sym]) continue;
                const posCtx = positions.get(sym);
                if (posCtx?._lastTickPrice > 0) {
                    prices[sym] = posCtx._lastTickPrice;
                    continue;
                }
                // Try tick feed latestTicks
                if (this.tickFeed?.latestTicks && this.tickFeed?.symbolMap) {
                    for (const [tok, mappedSym] of Object.entries(this.tickFeed.symbolMap)) {
                        if (mappedSym === sym) {
                            const tick = this.tickFeed.latestTicks.get(Number(tok))
                                || this.tickFeed.latestTicks.get(tok);
                            if (tick?.ltp > 0) { prices[sym] = tick.ltp; break; }
                        }
                    }
                }
            }

            // ── 2. Process each position ──────────────────────────────────────────
            for (const [symbol, posCtx] of positions) {
                try {
                    const currentPrice = prices[symbol];
                    if (!currentPrice || currentPrice <= 0) continue;

                    // Store for evaluateTick fallback
                    posCtx._lastTickPrice = posCtx._lastTickPrice || currentPrice;

                    const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';
                    const entry   = posCtx.entryPrice ?? posCtx.price;
                    const qty     = posCtx.quantity;
                    if (!entry || !qty) continue;

                    const unrealizedPnl = isShort
                        ? (entry - currentPrice) * qty
                        : (currentPrice - entry) * qty;

                    // ── 2a. Advance peak ──────────────────────────────────────────
                    const currentPeak = posCtx.peakUnrealizedPnl ?? 0;
                    if (unrealizedPnl > currentPeak) {
                        posCtx.peakUnrealizedPnl = unrealizedPnl;
                        posCtx.peakPnlAt = Date.now();
                        log.info({ symbol, pnl: +unrealizedPnl.toFixed(2),
                            oldPeak: +currentPeak.toFixed(2), price: currentPrice },
                            '📈 _syncPeakPnl: peak advanced');
                    }

                    // ── 2b. Ratchet trail stop ────────────────────────────────────
                    const trailMode = posCtx.trailMode ?? 'PNL_TRAIL';
                    if (trailMode === 'PNL_TRAIL' || trailMode === 'HYBRID') {
                        const pnlFloor = posCtx.pnlTrailFloor ?? (entry * qty * 0.005);
                        const effectivePeak = posCtx.peakUnrealizedPnl ?? 0;
                        const pnlTrailPct = posCtx.pnlTrailPct ?? 25;

                        if (effectivePeak >= pnlFloor && effectivePeak > 0) {
                            const newTrailStop = effectivePeak * (1 - pnlTrailPct / 100);
                            if (newTrailStop > (posCtx.pnlTrailStop ?? -Infinity)) {
                                posCtx.pnlTrailStop = newTrailStop;
                                posCtx.pnlTrailActivated = true;
                            }
                        }
                    }

                    // ── 2c. ALWAYS persist to Redis (every cycle) ─────────────────
                    getRedis().hset(`trail:${symbol}`,
                        'peakUnrealizedPnl', String(posCtx.peakUnrealizedPnl ?? 0),
                        'pnlTrailStop', String(posCtx.pnlTrailStop ?? -Infinity)
                    ).catch(() => { });

                    // ── 2d. Check exits — skip if already exiting ─────────────────
                    if (posCtx.isExiting) continue;

                    // Trail stop breach
                    const trailActive = posCtx.pnlTrailActivated || (posCtx.pnlTrailStop ?? -Infinity) > -Infinity;
                    if (trailActive && unrealizedPnl < (posCtx.pnlTrailStop ?? -Infinity)
                        && (posCtx.peakUnrealizedPnl ?? 0) > 0) {
                        posCtx.isExiting = true;
                        posCtx._isExitingSetAt = Date.now();
                        log.info({ symbol, pnl: +unrealizedPnl.toFixed(2),
                            peak: +(posCtx.peakUnrealizedPnl).toFixed(2),
                            trailStop: +(posCtx.pnlTrailStop).toFixed(2), currentPrice },
                            '🚨 _syncPeakPnl: PnL trail BREACHED — forcing exit!');
                        this.engine.forceExit(symbol, currentPrice, 'TRAILING_STOP')
                            .then(res => this._notifyExit(symbol, posCtx, currentPrice, 'TRAILING_STOP', {
                                trailType: 'PNL_TRAIL',
                                currentPnl: +unrealizedPnl.toFixed(2),
                                peakPnl: +(posCtx.peakUnrealizedPnl).toFixed(2),
                                pnlFloor: +(posCtx.pnlTrailStop).toFixed(2),
                            }, res))
                            .catch(err => log.error({ symbol, err: err.message }, '_syncPeakPnl trail exit failed'))
                            .finally(() => { posCtx.isExiting = false; });
                        continue; // don't also check stop loss
                    }

                    // Hard stop loss breach
                    const stopHit = isShort
                        ? currentPrice >= posCtx.stopPrice
                        : currentPrice <= posCtx.stopPrice;
                    if (stopHit && posCtx.stopPrice > 0) {
                        posCtx.isExiting = true;
                        posCtx._isExitingSetAt = Date.now();
                        log.info({ symbol, currentPrice, stopPrice: posCtx.stopPrice },
                            '🚨 _syncPeakPnl: STOP LOSS hit — forcing exit!');
                        this.engine.forceExit(symbol, currentPrice, 'STOP_LOSS')
                            .then(res => this._notifyExit(symbol, posCtx, currentPrice, 'STOP_LOSS', {
                                trigger: posCtx.stopPrice, current: currentPrice,
                            }, res))
                            .catch(err => log.error({ symbol, err: err.message }, '_syncPeakPnl stop exit failed'))
                            .finally(() => { posCtx.isExiting = false; });
                    }
                } catch (err) {
                    log.debug({ symbol, err: err.message }, '_syncPeakPnl position error');
                }
            }
        } catch (err) {
            log.warn({ err: err.message }, '_syncPeakPnl cycle failed');
        } finally {
            this._syncInProgress = false;
        }
    }

    /**
     * Instantly evaluate trailing stops, hard stops, and profit targets on every incoming tick.
     * Bypasses the 5-minute schedule to prevent catastrophic slippage.
     */
    evaluateTick(symbol, tick) {
        if (!this.enabled || this.engine._filledPositions.size === 0) return;

        const posCtx = this.engine._filledPositions.get(symbol);
        if (!posCtx) return;

        const currentPrice = tick.ltp || tick.lastPrice || tick.close || 0;
        if (currentPrice <= 0) return;

        // Store for _syncPeakPnl fallback (runs even if evaluateTick returns early)
        posCtx._lastTickPrice = currentPrice;

        // Concurrency guard — auto-reset after 30s to prevent permanent freeze.
        // CRITICAL: if _isExitingSetAt is undefined (set before this fix was deployed),
        // treat as stuck immediately since we have no idea when it was set.
        if (posCtx.isExiting) {
            const now = Date.now();
            const setAt = posCtx._isExitingSetAt;
            const stuckMs = setAt ? (now - setAt) : Infinity;  // undefined → treat as stuck
            if (stuckMs > 30_000) {
                log.warn({ symbol, stuckMs: stuckMs === Infinity ? 'unknown' : stuckMs },
                    'evaluateTick: isExiting stuck — auto-resetting');
                posCtx.isExiting = false;
                // fall through to normal evaluation
            } else {
                return;
            }
        }

        try {
            // ══════════════════════════════════════════════════════════════════
            // 1. INSTANT PEAK PnL TRACKING & TRAIL RATCHET
            // ══════════════════════════════════════════════════════════════════
            // We do this immediately here to guarantee Redis/memory consistency
            // without waiting for evaluateExits to process and assign objects.
            const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';
            const entry   = posCtx.entryPrice ?? posCtx.price;
            const qty     = posCtx.quantity;
            const unrealizedPnl = isShort
                ? (entry - currentPrice) * qty
                : (currentPrice - entry) * qty;
            
            const currentPeak = posCtx.peakUnrealizedPnl ?? 0;

            if (unrealizedPnl > currentPeak) {
                // Peak advanced! Apply instantly to memory.
                posCtx.peakUnrealizedPnl = unrealizedPnl;
                posCtx.peakPnlAt = Date.now();

                // Instantly ratchet the trailing stop floor if we've crossed the threshold
                const trailMode = posCtx.trailMode ?? 'PNL_TRAIL';
                if (trailMode === 'PNL_TRAIL' || trailMode === 'HYBRID') {
                    const pnlFloor = posCtx.pnlTrailFloor ?? (entry * qty * 0.005);
                    if (unrealizedPnl >= pnlFloor && unrealizedPnl > 0) {
                        const newFloor = unrealizedPnl * (1 - (posCtx.pnlTrailPct ?? 25) / 100);
                        if (newFloor > (posCtx.pnlTrailStop ?? -Infinity)) {
                            posCtx.pnlTrailStop = newFloor;
                            posCtx.pnlTrailActivated = true;
                        }
                    }
                }

                // Instantly persist the new peak and floor to Redis
                posCtx._lastSavedPeak = posCtx.peakUnrealizedPnl;
                getRedis().hset(`trail:${symbol}`,
                    'peakUnrealizedPnl', String(posCtx.peakUnrealizedPnl),
                    'pnlTrailStop', String(posCtx.pnlTrailStop ?? -Infinity)
                ).catch(() => { });
            }

            // ══════════════════════════════════════════════════════════════════
            // 2. EXIT EVALUATION
            // ══════════════════════════════════════════════════════════════════
            const result = evaluateExits({
                symbol,
                posCtx,
                currentPrice,
                recentCloses: [],
                recentHighs: [],
                recentLows: [],
                regime: null,
                latestSignals: {},
                config: this._active,
            });

            // ══════════════════════════════════════════════════════════════════
            // 3. EXIT BRANCHING
            // ══════════════════════════════════════════════════════════════════
            if (result.partial) {
                posCtx.isExiting = true;
                posCtx._isExitingSetAt = Date.now();
                this._executePartialExit(symbol, posCtx, currentPrice, result)
                    .finally(() => { posCtx.isExiting = false; });
            } else if (result.exit) {
                if (posCtx._simProtectedUntil && Date.now() < posCtx._simProtectedUntil) {
                    const secsLeft = Math.ceil((posCtx._simProtectedUntil - Date.now()) / 1000);
                    log.debug({ symbol, reason: result.reason, secsLeft }, '[SIM] Exit suppressed during protected hold window');
                } else {
                    posCtx.isExiting = true;
                    posCtx._isExitingSetAt = Date.now();
                    posCtx._exitReason = result.reason;
                    log.info({ symbol, currentPrice, reason: result.reason }, '🚨 Real-time TICK breached trailing/stop-loss floor! Force exiting immediately!');
                    this.engine.forceExit(symbol, currentPrice, result.reason)
                        .then(exitResult => this._notifyExit(symbol, posCtx, currentPrice, result.reason, result.meta, exitResult))
                        .catch(err => log.error({ symbol, err: err.message }, 'Real-time tick exit failed'))
                        .finally(() => { posCtx.isExiting = false; });
                }
            }
        } catch (err) {
            log.error({ symbol, err: err.message }, 'Tick evaluation failed');
        }
    }

    async initPosition(symbol, posCtx, recentCloses = [], recentHighs = [], recentLows = []) {
        await this._refreshParams();
        const regime = await this._getCurrentRegime();

        const levels = computeExitLevels({
            entryPrice: posCtx.entryPrice ?? posCtx.price,
            quantity: posCtx.quantity,
            direction: posCtx.direction ?? (posCtx.isShort ? 'SELL' : 'BUY'),   // FIX: was missing → defaulted to 'BUY' for all positions, causing inverted stop/target for shorts
            openingStrategy: posCtx.openingStrategy || (posCtx.strategies?.[0] ?? 'UNKNOWN'),
            allStrategies: posCtx.strategies || [],
            regime,
            recentCloses,
            recentHighs,
            recentLows,
            config: this._active,
        });

        Object.assign(posCtx, levels);

        // Explicitly create the initial trail data in Redis instantly, removing the
        // dependency on the lazy check in evaluateTick() or the 5-minute cron.
        try {
            await getRedis().hset(`trail:${symbol}`,
                'peakUnrealizedPnl', String(levels.peakUnrealizedPnl),
                'pnlTrailStop', String(levels.pnlTrailStop)
            );
            posCtx._lastSavedPeak = levels.peakUnrealizedPnl;
        } catch (err) {
            log.debug({ err: err.message }, 'Failed to set initial trail in Redis');
        }

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

            // Break-even protection: after partial exit, lock trail stop at entry (direction-aware)
            // LONG:  trail is below price; break-even = trail can never go BELOW entry
            // SHORT: trail is above price; break-even = trail can never go ABOVE entry
            const isShortPos = posCtx.isShort ?? posCtx.direction === 'SELL';
            const trailAtBreakEven = isShortPos
                ? posCtx.trailStopPrice > posCtx.entryPrice   // SHORT: trail above entry = beyond break-even
                : posCtx.trailStopPrice < posCtx.entryPrice;  // LONG:  trail below entry = beyond break-even
            if (trailAtBreakEven) {
                posCtx.trailStopPrice = posCtx.entryPrice;
                log.info({ symbol, isShort: isShortPos }, 'Trail stop moved to break-even after partial exit');
            }

            if (this.engine.telegram?.enabled) {
                const grossPnl = isShortPos
                    ? (posCtx.entryPrice - currentPrice) * result.qty   // SHORT profit: sold high, bought low
                    : (currentPrice - posCtx.entryPrice) * result.qty;  // LONG profit:  bought low, sold high
                const pnlStr = grossPnl >= 0 ? `+₹${grossPnl.toFixed(2)}` : `-₹${Math.abs(grossPnl).toFixed(2)}`;
                const trailLine = trailAtBreakEven
                    ? `🎯 Trail stop → break-even: ₹${posCtx.entryPrice.toFixed(2)}\n`
                    : `🎯 Trail stop: ₹${posCtx.trailStopPrice.toFixed(2)}\n`;
                this.engine.telegram.sendRaw(
                    `📊 <b>Partial Exit — ${symbol}</b>\n\n` +
                    `📌 Sold ${result.qty} shares at ₹${currentPrice.toFixed(2)}\n` +
                    `💰 Locked in: ${pnlStr} (+${result.meta?.gainPct}%)\n` +
                    `📦 Remaining: ${posCtx.quantity} shares still open\n` +
                    trailLine +
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

        const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';

        const grossFallback = isShort
            ? (posCtx.entryPrice - exitPrice) * posCtx.quantity
            : (exitPrice - posCtx.entryPrice) * posCtx.quantity;

        const grossPnl = exitResult?.order?.grossPnl ?? grossFallback;
        const charges = exitResult?.order?.costPaid ?? 0;
        const netPnl = exitResult?.order?.pnl ?? (grossPnl - charges);

        // pnlPct sign must also match direction
        const pnlPct = posCtx.entryPrice > 0
            ? (isShort
                ? ((posCtx.entryPrice - exitPrice) / posCtx.entryPrice * 100)
                : ((exitPrice - posCtx.entryPrice) / posCtx.entryPrice * 100)
            ).toFixed(2)
            : '0.00';

        const emoji = netPnl >= 0 ? '✅' : '🛑';
        const pnlSign = grossPnl >= 0 ? '+' : '-';
        const pnlStr = `${pnlSign}₹${Math.abs(grossPnl).toFixed(2)} (${grossPnl >= 0 ? '+' : ''}${pnlPct}%)`;

        const reasonDetails = {
            STOP_LOSS: `🛑 Hard stop hit at ₹${meta?.trigger?.toFixed(2)}`,
            PROFIT_TARGET: `🎯 Target hit (${meta?.mode === 'FIXED_PCT' ? 'fixed %' : `${posCtx.riskRewardRatio ?? '?'}× R/R`})`,
            TRAILING_STOP: meta?.trailType === 'PNL_TRAIL'
                ? `📉 Trail stop (PnL) — peak was ₹${meta?.peakPnl?.toFixed(2) ?? '?'}, retained ${meta?.retainedPct ?? '?'}%`
                : `📉 Trail stop (Price) — high was ₹${meta?.highWaterMark?.toFixed(2)}, locked ${meta?.lockedPnlPct ?? '?'}%`,
            SIGNAL_REVERSAL: `🔄 ${meta?.strategy} fired ${meta?.signal} — reversal detected`,
            TIME_EXIT: `⏰ Max hold time (${meta?.holdMinutes}min) — P&amp;L was ${meta?.pnlPct}%`,
        }[reason] ?? reason;

        const netPnlStr = `${netPnl >= 0 ? '+' : '-'}₹${Math.abs(netPnl).toFixed(2)} (${netPnl >= 0 ? '+' : ''}${pnlPct}%)`;

        await this.engine.telegram.sendRaw(
            `${emoji} <b>Position Exit — ${symbol}</b>\n\n` +
            `${reasonDetails}\n\n` +
            `📥 Entry:  ₹${posCtx.entryPrice.toFixed(2)}\n` +
            `📤 Exit:   ₹${exitPrice.toFixed(2)}\n` +
            `💰 P&amp;L:    ${pnlStr}\n` +
            `💰 Net P&amp;L: ${netPnlStr}\n` +
            `💸 Charges:  ₹${charges.toFixed(2)}\n` +
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
                async function withTimeout(promise, ms, errorMsg) {
                    let timer;
                    const timeout = new Promise((_, reject) => {
                        timer = setTimeout(() => reject(new Error(errorMsg)), ms);
                    });
                    try {
                        return await Promise.race([promise, timeout]);
                    } finally {
                        clearTimeout(timer); // ← always clear
                    }
                }

                // Usage:
                const ltp = await withTimeout(
                    this.broker.getLTP(keys),
                    LTP_TIMEOUT_MS,
                    `LTP fetch timed out after ${LTP_TIMEOUT_MS}ms`
                );

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