/**
 * @fileoverview Exit Strategy Logic for Alpha8 Position Manager
 *
 * Supports both LONG and SHORT positions with full symmetry.
 *
 * SHORT POSITION MATH (inverted from long):
 *   - Stop loss    : price ABOVE entry  (entry × (1 + stop%))
 *   - Profit target: price BELOW entry  (entry × (1 - target%))
 *   - Trail stop   : low-water mark — moves DOWN as price falls, never back up
 *   - Break-even   : trail can never go ABOVE entry once profitable
 *   - Signal reversal: opening strategy fires BUY (not SELL)
 *
 * EXIT PRIORITY ORDER (same for long and short):
 *   1. STOP_LOSS
 *   2. PROFIT_TARGET (full exit)
 *   3. PARTIAL_EXIT
 *   4. TRAILING_STOP
 *   5. SIGNAL_REVERSAL
 *   6. TIME_EXIT
 *
 * STRATEGY SHORT ELIGIBILITY:
 *   EMA_CROSSOVER     ✅ — bearish crossover is a textbook short
 *   VWAP_MOMENTUM     ✅ — break below VWAP with volume
 *   BREAKOUT_VOLUME   ✅ — breakdown below support with volume
 *   RSI_MEAN_REVERSION ❌ — overbought shorts have poor R/R; stays as exit signal only
 */

// ── Strategy classification ────────────────────────────────────────────────

/** Strategies that use mean-reversion fixed % targets (longs only) */
const MEAN_REVERSION_STRATEGIES = new Set(['RSI_MEAN_REVERSION']);

/** Strategies allowed to open short positions */
export const SHORT_ELIGIBLE_STRATEGIES = new Set([
    'EMA_CROSSOVER',
    'VWAP_MOMENTUM',
    'BREAKOUT_VOLUME',
]);

// ── Regime multipliers for ATR-based trail ────────────────────────────────

const REGIME_TRAIL_MULTIPLIER = {
    TRENDING: 1.0,
    SIDEWAYS: 1.2,
    VOLATILE: 1.6,
    UNKNOWN: 1.2,
};

// ═══════════════════════════════════════════════════════
// PUBLIC: Position initialisation
// ═══════════════════════════════════════════════════════

/**
 * Compute all exit levels for a new position at entry time.
 * Works for both LONG ('BUY') and SHORT ('SELL') positions.
 *
 * @param {Object} params
 * @param {number}   params.entryPrice
 * @param {number}   params.quantity
 * @param {'BUY'|'SELL'} params.direction      - 'BUY' for long, 'SELL' for short
 * @param {string}   params.openingStrategy
 * @param {string[]} params.allStrategies
 * @param {string}   params.regime
 * @param {number[]} [params.recentCloses]
 * @param {number[]} [params.recentHighs]
 * @param {number[]} [params.recentLows]
 * @param {Object}   params.config
 * @returns {Object} exitLevels to merge into posCtx
 */
export function computeExitLevels({
    entryPrice,
    quantity,
    direction = 'BUY',
    openingStrategy,
    allStrategies,
    regime,
    recentCloses = [],
    recentHighs = [],
    recentLows = [],
    config,
}) {
    const isShort = direction === 'SELL';

    const stopLossPct         = config.stopLossPct         ?? config.STOP_LOSS_PCT         ?? 1.0;
    const trailingStopPct     = config.trailingStopPct     ?? config.TRAILING_STOP_PCT     ?? 1.5;
    const profitTargetPct     = config.profitTargetPct     ?? config.PROFIT_TARGET_PCT     ?? 1.8;
    // Fix BUG-09: riskRewardRatio may be stored under different key names; default to 2.0
    const riskRewardRatio     = config.riskRewardRatio
      ?? config.RISK_REWARD_RATIO
      ?? config.riskReward
      ?? 2.0;
    const partialExitEnabled  = config.partialExitEnabled  ?? config.PARTIAL_EXIT_ENABLED  ?? true;
    const partialExitPct      = config.partialExitPct      ?? config.PARTIAL_EXIT_PCT      ?? 50;
    // Fix BUG-10: signalReversalEnabled must default to true; undefined would disable reversal exits
    const signalReversalEnabled = config.signalReversalEnabled
      ?? config.SIGNAL_REVERSAL_ENABLED
      ?? true;   // core feature — default ON

    // ── Stop loss ──────────────────────────────────────────────────────────
    // LONG:  stop below entry  (entry × (1 - stop%))
    // SHORT: stop above entry  (entry × (1 + stop%))
    const stopPrice = isShort
        ? entryPrice * (1 + stopLossPct / 100)
        : entryPrice * (1 - stopLossPct / 100);

    // ── Profit target ──────────────────────────────────────────────────────
    // RSI uses fixed % (mean reversion snaps back to a level)
    // All other strategies use risk/reward multiplier
    // SHORT: target is BELOW entry for both modes
    const targetMode = MEAN_REVERSION_STRATEGIES.has(openingStrategy)
        ? 'FIXED_PCT'
        : 'RISK_REWARD';

    let profitTargetPrice;
    if (isShort) {
        profitTargetPrice = targetMode === 'FIXED_PCT'
            ? entryPrice * (1 - profitTargetPct / 100)
            : entryPrice - (stopPrice - entryPrice) * riskRewardRatio;
        // stopPrice > entryPrice for shorts, so (stopPrice - entry) = risk distance
    } else {
        profitTargetPrice = targetMode === 'FIXED_PCT'
            ? entryPrice * (1 + profitTargetPct / 100)
            : entryPrice + (entryPrice - stopPrice) * riskRewardRatio;
    }

    // ── Partial exit quantity ──────────────────────────────────────────────
    const partialQty = partialExitEnabled
        ? Math.max(1, Math.floor(quantity * (partialExitPct / 100)))
        : 0;

    // ── Initial trail stop ─────────────────────────────────────────────────
    // LONG:  trail starts below entry, moves UP
    // SHORT: trail starts above entry, moves DOWN
    const atrPct = recentCloses.length >= 14
        ? computeAtrPct(recentHighs, recentLows, recentCloses)
        : null;

    const trailMultiplier = REGIME_TRAIL_MULTIPLIER[regime] ?? REGIME_TRAIL_MULTIPLIER.UNKNOWN;
    const effectiveTrailPct = (atrPct != null ? atrPct : trailingStopPct) * trailMultiplier;

    const initialTrailStop = isShort
        ? entryPrice * (1 + effectiveTrailPct / 100)   // above entry for shorts
        : entryPrice * (1 - effectiveTrailPct / 100);  // below entry for longs

    // ── Low-water mark (short equivalent of high-water mark) ──────────────
    // LONG:  highWaterMark — the best (highest) price seen since entry
    // SHORT: lowWaterMark  — the best (lowest)  price seen since entry
    // We store it as 'highWaterMark' for compatibility; for shorts it holds
    // the low-water value.
    const waterMark = entryPrice;

    return {
        direction,
        isShort,

        // Stop loss
        stopPrice,

        // Trailing stop (moves in favorable direction, never reverses)
        trailStopPrice: initialTrailStop,
        trailPct: effectiveTrailPct,
        highWaterMark: waterMark,   // for longs: highest price; for shorts: lowest price

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

        // Metadata
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
 * Handles both LONG and SHORT positions transparently.
 *
 * @param {Object} params
 * @param {string}   params.symbol
 * @param {Object}   params.posCtx
 * @param {number}   params.currentPrice
 * @param {number[]} [params.recentCloses]
 * @param {number[]} [params.recentHighs]
 * @param {number[]} [params.recentLows]
 * @param {string}   [params.regime]
 * @param {Object}   [params.latestSignals]
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
    const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';

    // ── Update trail stop before checking ─────────────────────────────────
    const updatedLevels = updateTrailStop(
        posCtx, currentPrice,
        recentCloses, recentHighs, recentLows,
        regime, config,
    );
    Object.assign(posCtx, updatedLevels);

    // ── 1. STOP_LOSS ───────────────────────────────────────────────────────
    // LONG:  stop fires when price drops BELOW stopPrice
    // SHORT: stop fires when price rises ABOVE stopPrice
    const stopHit = isShort
        ? currentPrice >= posCtx.stopPrice
        : currentPrice <= posCtx.stopPrice;

    if (stopHit) {
        return {
            exit: true, partial: false,
            reason: 'STOP_LOSS',
            qty: posCtx.quantity,
            meta: {
                trigger: posCtx.stopPrice,
                current: currentPrice,
                dropPct: pct(posCtx.entryPrice, currentPrice),
                isShort,
            },
        };
    }

    // ── 2. PROFIT_TARGET (full exit) ──────────────────────────────────────
    // LONG:  target fires when price rises ABOVE targetPrice
    // SHORT: target fires when price falls BELOW targetPrice
    const targetHit = isShort
        ? currentPrice <= posCtx.profitTargetPrice
        : currentPrice >= posCtx.profitTargetPrice;

    if (targetHit && (!posCtx.partialExitEnabled || posCtx.partialExitDone)) {
        return {
            exit: true, partial: false,
            reason: 'PROFIT_TARGET',
            qty: posCtx.quantity,
            meta: {
                target: posCtx.profitTargetPrice,
                current: currentPrice,
                gainPct: pct(posCtx.entryPrice, currentPrice),
                mode: posCtx.profitTargetMode,
                isShort,
            },
        };
    }

    // ── 3. PARTIAL_EXIT ───────────────────────────────────────────────────
    if (
        posCtx.partialExitEnabled &&
        !posCtx.partialExitDone &&
        targetHit &&
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
                isShort,
            },
        };
    }

    // ── 4. TRAILING_STOP ──────────────────────────────────────────────────
    // LONG:  trail fires when price drops BELOW trailStopPrice AND was profitable
    //        (highWaterMark > entryPrice)
    // SHORT: trail fires when price rises ABOVE trailStopPrice AND was profitable
    //        (lowWaterMark < entryPrice — stored in highWaterMark for shorts)
    const trailHit = isShort
        ? currentPrice >= posCtx.trailStopPrice &&
        posCtx.highWaterMark < posCtx.entryPrice
        : currentPrice <= posCtx.trailStopPrice &&
        posCtx.highWaterMark > posCtx.entryPrice;

    if (trailHit) {
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
                isShort,
            },
        };
    }

    // ── 5. SIGNAL_REVERSAL ────────────────────────────────────────────────
    // LONG:  opening strategy fires SELL → exit
    // SHORT: opening strategy fires BUY  → cover
    if (posCtx.signalReversalEnabled && posCtx.openingStrategy) {
        const reversalSignal = latestSignals[posCtx.openingStrategy];
        const reversalHit = isShort
            ? reversalSignal === 'BUY'
            : reversalSignal === 'SELL';

        if (reversalHit) {
            return {
                exit: true, partial: false,
                reason: 'SIGNAL_REVERSAL',
                qty: posCtx.quantity,
                meta: {
                    strategy: posCtx.openingStrategy,
                    signal: reversalSignal,
                    pnlPct: pct(posCtx.entryPrice, currentPrice),
                    isShort,
                },
            };
        }
    }

    // ── 6. TIME_EXIT ──────────────────────────────────────────────────────
    const holdMinutes = (Date.now() - posCtx.timestamp) / 60000;
    const pnlPct = isShort
        ? pct(currentPrice, posCtx.entryPrice)   // profit when price falls
        : pct(posCtx.entryPrice, currentPrice);
    const maxHold = config.maxHoldMinutes ?? 90;

    // Tier 1 (soft): flat or losing past max hold → exit
    if (holdMinutes >= maxHold && pnlPct < 0.3) {
        return {
            exit: true, partial: false,
            reason: 'TIME_EXIT',
            qty: posCtx.quantity,
            meta: { holdMinutes: +holdMinutes.toFixed(1), maxHold, pnlPct, tier: 'soft', isShort },
        };
    }

    // Tier 2 (hard): any position held > 2× maxHold (unless trail is in profit zone)
    const trailInProfitZone = isShort
        ? posCtx.trailStopPrice <= posCtx.entryPrice
        : posCtx.trailStopPrice >= posCtx.entryPrice;

    if (holdMinutes >= maxHold * 2 && !trailInProfitZone) {
        return {
            exit: true, partial: false,
            reason: 'TIME_EXIT',
            qty: posCtx.quantity,
            meta: { holdMinutes: +holdMinutes.toFixed(1), maxHold, pnlPct, tier: 'hard', isShort },
        };
    }

    return noExit;
}

// ═══════════════════════════════════════════════════════
// PUBLIC: Trail stop updater
// ═══════════════════════════════════════════════════════

/**
 * Recompute and ratchet trail stop given current price.
 * For LONG:  trail ratchets UP   — only moves when price makes new highs.
 * For SHORT: trail ratchets DOWN — only moves when price makes new lows.
 *
 * @param {Object}   posCtx
 * @param {number}   currentPrice
 * @param {number[]} recentCloses
 * @param {number[]} recentHighs
 * @param {number[]} recentLows
 * @param {string}   regime
 * @param {Object}   config
 * @returns {Partial<Object>}
 */
export function updateTrailStop(
    posCtx, currentPrice,
    recentCloses, recentHighs, recentLows,
    regime, config,
) {
    const updates = {};
    const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';

    // For longs, new high = new watermark.
    // For shorts, new low = new watermark (stored in same highWaterMark field).
    const newWatermark = isShort
        ? currentPrice < posCtx.highWaterMark  // new low for shorts
        : currentPrice > posCtx.highWaterMark; // new high for longs

    if (!newWatermark) return updates;

    updates.highWaterMark = currentPrice;
    updates.currentRegime = regime;

    // Recompute trail width
    const atrPct = recentCloses.length >= 14
        ? computeAtrPct(recentHighs, recentLows, recentCloses)
        : null;
    const multiplier = REGIME_TRAIL_MULTIPLIER[regime] ?? REGIME_TRAIL_MULTIPLIER.UNKNOWN;
    const trailPct = atrPct != null
        ? atrPct * multiplier
        : (posCtx.trailPct ?? config.trailingStopPct);

    let newTrailStop = isShort
        ? currentPrice * (1 + trailPct / 100)   // trail above current price for shorts
        : currentPrice * (1 - trailPct / 100);  // trail below current price for longs

    // Break-even protection — trail locked at entry once sufficiently profitable
    const significantlyProfitable = isShort
        ? currentPrice <= posCtx.entryPrice * 0.995   // 0.5% below entry for shorts
        : currentPrice >= posCtx.entryPrice * 1.005;  // 0.5% above entry for longs

    if (significantlyProfitable) {
        if (isShort && newTrailStop > posCtx.entryPrice) {
            newTrailStop = posCtx.entryPrice;
        } else if (!isShort && newTrailStop < posCtx.entryPrice) {
            newTrailStop = posCtx.entryPrice;
        }
    }

    // Trail only ratchets in the favorable direction — never reverses
    const trailImproved = isShort
        ? newTrailStop < posCtx.trailStopPrice   // lower trail stop = more profit locked for short
        : newTrailStop > posCtx.trailStopPrice;  // higher trail stop = more profit locked for long

    if (trailImproved) {
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
 */
export function computeAtrPct(highs, lows, closes, period = 14) {
    if (
        !highs?.length || !lows?.length || !closes?.length ||
        highs.length < period + 1 ||
        lows.length < period + 1 ||
        closes.length < period + 1
    ) return null;

    const trueRanges = [];
    for (let i = 1; i < closes.length; i++) {
        const hl = highs[i] - lows[i];
        const hpc = Math.abs(highs[i] - closes[i - 1]);
        const lpc = Math.abs(lows[i] - closes[i - 1]);
        trueRanges.push(Math.max(hl, hpc, lpc));
    }

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