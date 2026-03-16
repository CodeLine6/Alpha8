/**
 * @fileoverview Exit Strategy Logic for Alpha8 Position Manager
 *
 * Pure functions — no Redis, no DB, no broker calls.
 * All I/O happens in position-manager.js. These functions
 * only decide WHETHER to exit and WHY.
 *
 * EXIT PRIORITY ORDER (highest wins):
 *   1. STOP_LOSS          — hard floor, always checked first
 *   2. PROFIT_TARGET      — full exit at target
 *   3. PARTIAL_EXIT       — half exit at target (if partial mode enabled)
 *   4. TRAILING_STOP      — volatility-adjusted trail
 *   5. SIGNAL_REVERSAL    — opening strategy fires opposite signal
 *   6. TIME_EXIT          — max hold time on flat/losing positions
 *
 * STRATEGY-AWARE PROFIT TARGETS:
 *   RSI_MEAN_REVERSION    → fixed % target (mean-reversion snaps back to a level)
 *   EMA_CROSSOVER         → 2× risk/reward (momentum can run further)
 *   VWAP_MOMENTUM         → 2× risk/reward
 *   BREAKOUT_VOLUME       → 2× risk/reward
 *
 * VOLATILITY-ADJUSTED TRAILING STOP:
 *   Base width = ATR % of price (computed from recent candles)
 *   Regime multiplier applied on top:
 *     TRENDING  × 1.0 (tight — ride the trend)
 *     SIDEWAYS  × 1.2 (slightly wider)
 *     VOLATILE  × 1.6 (wide — avoid noise stop-outs)
 *   Falls back to fixed TRAILING_STOP_PCT if ATR unavailable.
 */

// ── Strategy classification ────────────────────────────────────────────────

/** Strategies that use mean-reversion fixed % targets */
const MEAN_REVERSION_STRATEGIES = new Set(['RSI_MEAN_REVERSION']);

/** Strategies that use momentum risk/reward targets */
const MOMENTUM_STRATEGIES = new Set([
    'EMA_CROSSOVER',
    'VWAP_MOMENTUM',
    'BREAKOUT_VOLUME',
]);

// ── Regime multipliers for ATR-based trail ────────────────────────────────

const REGIME_TRAIL_MULTIPLIER = {
    TRENDING: 1.0,
    SIDEWAYS: 1.2,
    VOLATILE: 1.6,
    UNKNOWN: 1.2, // conservative default
};

// ═══════════════════════════════════════════════════════
// PUBLIC: Position initialisation
// ═══════════════════════════════════════════════════════

/**
 * Compute all exit levels for a new position at entry time.
 * Called once when BUY is filled. Levels are stored in posCtx
 * and never recalculated (except trail stop which moves up).
 *
 * @param {Object} params
 * @param {number}   params.entryPrice
 * @param {number}   params.quantity
 * @param {string}   params.openingStrategy   - which strategy fired the BUY
 * @param {string[]} params.allStrategies      - all strategies that contributed
 * @param {string}   params.regime             - current market regime
 * @param {number[]} [params.recentCloses]     - recent closes for ATR calc
 * @param {number[]} [params.recentHighs]
 * @param {number[]} [params.recentLows]
 * @param {Object}   params.config             - exit config (from live settings)
 * @returns {Object} exitLevels to merge into posCtx
 */
export function computeExitLevels({
    entryPrice,
    quantity,
    openingStrategy,
    allStrategies,
    regime,
    recentCloses = [],
    recentHighs = [],
    recentLows = [],
    config,
}) {
    const {
        stopLossPct,
        trailingStopPct,
        profitTargetPct,
        riskRewardRatio,
        partialExitEnabled,
        partialExitPct,
        signalReversalEnabled,
    } = config;

    // Hard stop — always fixed at entry
    const stopPrice = entryPrice * (1 - stopLossPct / 100);

    // Profit target — strategy-aware
    const targetMode = MEAN_REVERSION_STRATEGIES.has(openingStrategy)
        ? 'FIXED_PCT'
        : 'RISK_REWARD';

    const profitTargetPrice = targetMode === 'FIXED_PCT'
        ? entryPrice * (1 + profitTargetPct / 100)
        : entryPrice + (entryPrice - stopPrice) * riskRewardRatio;

    // Partial exit quantity (floor so we always sell whole shares)
    const partialQty = partialExitEnabled
        ? Math.max(1, Math.floor(quantity * (partialExitPct / 100)))
        : 0;

    // Initial trail stop — use ATR if available, else fixed %
    const atrPct = recentCloses.length >= 14
        ? computeAtrPct(recentHighs, recentLows, recentCloses)
        : null;

    const trailMultiplier = REGIME_TRAIL_MULTIPLIER[regime] ?? REGIME_TRAIL_MULTIPLIER.UNKNOWN;
    const effectiveTrailPct = (atrPct != null ? atrPct : trailingStopPct) * trailMultiplier;

    const initialTrailStop = entryPrice * (1 - effectiveTrailPct / 100);

    return {
        // Stop loss
        stopPrice,

        // Trailing stop (moves up, never down)
        trailStopPrice: initialTrailStop,
        trailPct: effectiveTrailPct,
        highWaterMark: entryPrice,

        // Profit target
        profitTargetPrice,
        profitTargetMode: targetMode,

        // Partial exit
        partialExitEnabled,
        partialExitQty: partialQty,
        partialExitDone: false,

        // Signal reversal
        signalReversalEnabled,
        openingStrategy,

        // Metadata for debugging
        entryAtrPct: atrPct,
        entryRegime: regime,
        entryTrailPct: effectiveTrailPct,
        trailMultiplier,
    };
}

// ═══════════════════════════════════════════════════════
// PUBLIC: Exit decision
// ═══════════════════════════════════════════════════════

/**
 * Determine if and how a position should exit.
 * Called every scan cycle for each held position.
 *
 * @param {Object} params
 * @param {string}   params.symbol
 * @param {Object}   params.posCtx       - position context from _filledPositions
 * @param {number}   params.currentPrice
 * @param {number[]} [params.recentCloses]
 * @param {number[]} [params.recentHighs]
 * @param {number[]} [params.recentLows]
 * @param {string}   [params.regime]     - current regime (may have changed since entry)
 * @param {Object}   [params.latestSignals] - { [strategy]: 'BUY'|'SELL'|'HOLD' }
 * @param {Object}   params.config
 * @returns {{ exit: boolean, partial: boolean, reason: string|null, qty: number }}
 */
export function evaluateExits({
    symbol,
    posCtx,
    currentPrice,
    recentCloses = [],
    recentHighs = [],
    recentLows = [],
    regime,
    latestSignals = {},
    config,
}) {
    const noExit = { exit: false, partial: false, reason: null, qty: posCtx.quantity };

    // ── Update trail stop before checking ─────────────────────────────────────
    // Recompute trail width using latest ATR + current regime
    // (regime may have shifted since position was opened)
    const updatedLevels = updateTrailStop(posCtx, currentPrice, recentCloses,
        recentHighs, recentLows, regime, config);
    Object.assign(posCtx, updatedLevels);

    // ── 1. STOP_LOSS ─────────────────────────────────────────────────────────
    if (currentPrice <= posCtx.stopPrice) {
        return {
            exit: true, partial: false,
            reason: 'STOP_LOSS',
            qty: posCtx.quantity,
            meta: {
                trigger: posCtx.stopPrice,
                current: currentPrice,
                dropPct: pct(posCtx.entryPrice, currentPrice),
            },
        };
    }

    // ── 2. PROFIT_TARGET (full exit) ─────────────────────────────────────────
    // Only fires if partial exit is disabled OR partial already done
    if (
        currentPrice >= posCtx.profitTargetPrice &&
        (!posCtx.partialExitEnabled || posCtx.partialExitDone)
    ) {
        return {
            exit: true, partial: false,
            reason: 'PROFIT_TARGET',
            qty: posCtx.quantity,
            meta: {
                target: posCtx.profitTargetPrice,
                current: currentPrice,
                gainPct: pct(posCtx.entryPrice, currentPrice),
                mode: posCtx.profitTargetMode,
            },
        };
    }

    // ── 3. PARTIAL_EXIT ───────────────────────────────────────────────────────
    if (
        posCtx.partialExitEnabled &&
        !posCtx.partialExitDone &&
        currentPrice >= posCtx.profitTargetPrice &&
        posCtx.partialExitQty > 0 &&
        posCtx.partialExitQty < posCtx.quantity
    ) {
        return {
            exit: false, partial: true,
            reason: 'PARTIAL_EXIT',
            qty: posCtx.partialExitQty,
            meta: {
                target: posCtx.profitTargetPrice,
                current: currentPrice,
                partialQty: posCtx.partialExitQty,
                remainingQty: posCtx.quantity - posCtx.partialExitQty,
                gainPct: pct(posCtx.entryPrice, currentPrice),
            },
        };
    }

    // ── 4. TRAILING_STOP ─────────────────────────────────────────────────────
    // Only triggers after position has gone green (highWaterMark > entryPrice)
    if (
        currentPrice <= posCtx.trailStopPrice &&
        posCtx.highWaterMark > posCtx.entryPrice
    ) {
        return {
            exit: true, partial: false,
            reason: 'TRAILING_STOP',
            qty: posCtx.quantity,
            meta: {
                trailStop: posCtx.trailStopPrice,
                highWaterMark: posCtx.highWaterMark,
                current: currentPrice,
                lockedPnlPct: pct(posCtx.entryPrice, posCtx.trailStopPrice),
                regime: posCtx.currentRegime || posCtx.entryRegime,
            },
        };
    }

    // ── 5. SIGNAL_REVERSAL ───────────────────────────────────────────────────
    if (posCtx.signalReversalEnabled && posCtx.openingStrategy) {
        const reversalSignal = latestSignals[posCtx.openingStrategy];
        if (reversalSignal === 'SELL') {
            const pnlPct = pct(posCtx.entryPrice, currentPrice);
            return {
                exit: true, partial: false,
                reason: 'SIGNAL_REVERSAL',
                qty: posCtx.quantity,
                meta: {
                    strategy: posCtx.openingStrategy,
                    signal: reversalSignal,
                    pnlPct,
                },
            };
        }
    }

    // ── 6. TIME_EXIT ─────────────────────────────────────────────────────────
    const holdMinutes = (Date.now() - posCtx.timestamp) / 60000;
    const pnlPct = pct(posCtx.entryPrice, currentPrice);
    const maxHold = config.maxHoldMinutes ?? 90;

    // Tier 1 (soft): flat or losing position past max hold → exit
    if (holdMinutes >= maxHold && pnlPct < 0.3) {
        return {
            exit: true, partial: false,
            reason: 'TIME_EXIT',
            qty: posCtx.quantity,
            meta: {
                holdMinutes: +holdMinutes.toFixed(1),
                maxHold,
                pnlPct,
                tier: 'soft',
            },
        };
    }

    // L1 FIX — Tier 2 (hard): any position held more than 2× maxHold gets exited
    // regardless of P&L — UNLESS trailing stop has moved above breakeven (meaning
    // the trail will handle the exit and we should let profit run).
    const trailAboveBreakeven = posCtx.trailStopPrice >= posCtx.entryPrice;
    if (holdMinutes >= maxHold * 2 && !trailAboveBreakeven) {
        return {
            exit: true, partial: false,
            reason: 'TIME_EXIT',
            qty: posCtx.quantity,
            meta: {
                holdMinutes: +holdMinutes.toFixed(1),
                maxHold,
                pnlPct,
                tier: 'hard', // hard timeout — exits profitable positions too
                note: 'Exceeded 2× maxHoldMinutes with trail stop below breakeven — hard exit',
            },
        };
    }

    return noExit;
}

// ═══════════════════════════════════════════════════════
// PUBLIC: Trail stop updater
// ═══════════════════════════════════════════════════════

/**
 * Recompute and update trail stop for a position given current price.
 * Returns only the fields that changed — merge into posCtx.
 *
 * @param {Object}   posCtx
 * @param {number}   currentPrice
 * @param {number[]} recentCloses
 * @param {number[]} recentHighs
 * @param {number[]} recentLows
 * @param {string}   regime
 * @param {Object}   config
 * @returns {Partial<Object>} fields to merge into posCtx
 */
export function updateTrailStop(
    posCtx, currentPrice,
    recentCloses, recentHighs, recentLows,
    regime, config,
) {
    const updates = {};

    if (currentPrice <= posCtx.highWaterMark) return updates;

    // New high water mark
    updates.highWaterMark = currentPrice;
    updates.currentRegime = regime;

    // Recompute trail width with latest ATR + regime
    const atrPct = recentCloses.length >= 14
        ? computeAtrPct(recentHighs, recentLows, recentCloses)
        : null;

    const multiplier = REGIME_TRAIL_MULTIPLIER[regime] ?? REGIME_TRAIL_MULTIPLIER.UNKNOWN;
    const trailPct = atrPct != null
        ? atrPct * multiplier
        : (posCtx.trailPct ?? config.trailingStopPct);

    let newTrailStop = currentPrice * (1 - trailPct / 100);

    // Break-even protection — trail can never go below entry once 0.5% profitable
    const isSignificantlyProfitable = currentPrice >= posCtx.entryPrice * 1.005;
    if (isSignificantlyProfitable && newTrailStop < posCtx.entryPrice) {
        newTrailStop = posCtx.entryPrice;
    }

    // Trail stop only ever moves up
    if (newTrailStop > posCtx.trailStopPrice) {
        updates.trailStopPrice = newTrailStop;
        updates.trailPct = trailPct;
        updates.trailMultiplier = multiplier;
        updates.currentAtrPct = atrPct;
    }

    return updates;
}

// ═══════════════════════════════════════════════════════
// PUBLIC: ATR calculation
// ═══════════════════════════════════════════════════════

/**
 * Compute ATR as a percentage of current price.
 * Uses standard 14-period ATR formula.
 *
 * @param {number[]} highs
 * @param {number[]} lows
 * @param {number[]} closes
 * @param {number}   [period=14]
 * @returns {number|null} ATR as % of last close, or null if insufficient data
 */
export function computeAtrPct(highs, lows, closes, period = 14) {
    if (
        !highs?.length || !lows?.length || !closes?.length ||
        highs.length < period + 1 ||
        lows.length < period + 1 ||
        closes.length < period + 1
    ) {
        return null;
    }

    const trueRanges = [];
    for (let i = 1; i < closes.length; i++) {
        const hl = highs[i] - lows[i];
        const hpc = Math.abs(highs[i] - closes[i - 1]);
        const lpc = Math.abs(lows[i] - closes[i - 1]);
        trueRanges.push(Math.max(hl, hpc, lpc));
    }

    // Simple average of last `period` true ranges
    const recent = trueRanges.slice(-period);
    const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
    const last = closes[closes.length - 1];

    if (last <= 0) return null;
    return (atr / last) * 100;
}

// ═══════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════

/** % change from a to b, rounded to 2dp */
function pct(from, to) {
    return from > 0 ? +((to - from) / from * 100).toFixed(2) : 0;
}