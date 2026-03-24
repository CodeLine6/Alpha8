/**
 * @fileoverview Exit Strategy Logic for Alpha8 — PnL-Aware Trailing Stop
 *
 * KEY CHANGE: Trailing stop is now calculated on PEAK UNREALIZED PnL (₹)
 * rather than peak price percentage. This correctly accounts for position
 * quantity — a 500-share position profits/loses 5x more per rupee move
 * than a 100-share position at the same price, and the trail must reflect that.
 *
 * TRAIL MODES:
 *   PNL_TRAIL (new default):
 *     - Tracks peak unrealized PnL in ₹
 *     - Trail = retain at least (100 - trailPct)% of peak PnL
 *     - Example: peak ₹10,000, trail 25% → exit if PnL drops below ₹7,500
 *     - Quantity-aware by nature (PnL = price_diff × qty)
 *
 *   PRICE_TRAIL (legacy, kept for backward compat):
 *     - Original behavior: trail % below high water mark price
 *     - Used only when PNL_TRAIL cannot be computed
 *
 * HYBRID PROTECTION (always active):
 *   Both price floor AND PnL floor are computed.
 *   Exit triggers when EITHER is breached.
 *   This prevents a thinly-priced high-qty stock from ignoring price completely.
 */

// ── Trail mode constants ───────────────────────────────────────────────────

export const TRAIL_MODE = Object.freeze({
    PNL_TRAIL: 'PNL_TRAIL',   // protect ₹ profits (quantity-aware) — DEFAULT
    PRICE_TRAIL: 'PRICE_TRAIL', // protect price % (legacy)
    HYBRID: 'HYBRID',      // both must hold (most conservative)
});

// ── Regime multipliers (unchanged) ────────────────────────────────────────

const REGIME_TRAIL_MULTIPLIER = {
    TRENDING: 1.0,
    SIDEWAYS: 1.2,
    VOLATILE: 1.6,
    UNKNOWN: 1.2,
};

// ─────────────────────────────────────────────────────────────────────────────
// computeExitLevels — add PnL trail fields
// ─────────────────────────────────────────────────────────────────────────────

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

    const stopLossPct = config.stopLossPct ?? config.STOP_LOSS_PCT ?? 1.0;
    const trailingStopPct = config.trailingStopPct ?? config.TRAILING_STOP_PCT ?? 1.5;
    const profitTargetPct = config.profitTargetPct ?? config.PROFIT_TARGET_PCT ?? 1.8;
    const riskRewardRatio = config.riskRewardRatio ?? config.RISK_REWARD_RATIO ?? 2.0;
    const partialExitEnabled = config.partialExitEnabled ?? config.PARTIAL_EXIT_ENABLED ?? true;
    const partialExitPct = config.partialExitPct ?? config.PARTIAL_EXIT_PCT ?? 50;
    const signalReversalEnabled = config.signalReversalEnabled ?? config.SIGNAL_REVERSAL_ENABLED ?? true;

    // ── NEW: PnL trail configuration ──────────────────────────────────────────
    // pnlTrailPct: what % of peak PnL to give back before exiting
    //   e.g. 25 means "exit if PnL drops 25% from its peak"
    //   Higher = more room to breathe, captures bigger moves
    //   Lower  = locks in more profit, exits earlier on pullbacks
    const pnlTrailPct = config.pnlTrailPct ?? config.PNL_TRAIL_PCT ?? 25;

    // pnlTrailFloor: minimum ₹ PnL that must be protected before trail activates
    //   Trail only kicks in once we're profitable beyond this floor
    //   Prevents trail from triggering on noise before any real profit exists
    //   Default: protect at least 0.5% of position value
    const pnlTrailFloor = config.pnlTrailFloor
        ?? config.PNL_TRAIL_FLOOR
        ?? entryPrice * quantity * 0.005; // 0.5% of position value

    // Trail mode: PNL_TRAIL | PRICE_TRAIL | HYBRID
    const trailMode = config.trailMode ?? config.TRAIL_MODE ?? TRAIL_MODE.PNL_TRAIL;

    // ── Hard stop loss ────────────────────────────────────────────────────────
    const stopPrice = isShort
        ? entryPrice * (1 + stopLossPct / 100)
        : entryPrice * (1 - stopLossPct / 100);

    // ── Profit target ─────────────────────────────────────────────────────────
    const MEAN_REVERSION = new Set(['RSI_MEAN_REVERSION']);
    const targetMode = MEAN_REVERSION.has(openingStrategy) ? 'FIXED_PCT' : 'RISK_REWARD';

    let profitTargetPrice;
    if (isShort) {
        profitTargetPrice = targetMode === 'FIXED_PCT'
            ? entryPrice * (1 - profitTargetPct / 100)
            : entryPrice - (stopPrice - entryPrice) * riskRewardRatio;
    } else {
        profitTargetPrice = targetMode === 'FIXED_PCT'
            ? entryPrice * (1 + profitTargetPct / 100)
            : entryPrice + (entryPrice - stopPrice) * riskRewardRatio;
    }

    // ── Partial exit ──────────────────────────────────────────────────────────
    const partialQty = partialExitEnabled
        ? Math.max(1, Math.floor(quantity * (partialExitPct / 100)))
        : 0;

    // ── ATR for price-trail component ─────────────────────────────────────────
    const atrPct = recentCloses.length >= 14
        ? computeAtrPct(recentHighs, recentLows, recentCloses)
        : null;
    const trailMultiplier = REGIME_TRAIL_MULTIPLIER[regime] ?? REGIME_TRAIL_MULTIPLIER.UNKNOWN;
    const effectiveTrailPct = (atrPct != null ? atrPct : trailingStopPct) * trailMultiplier;

    // ── Initial price-trail stop (legacy component, still computed) ───────────
    const initialPriceTrailStop = isShort
        ? entryPrice * (1 + effectiveTrailPct / 100)
        : entryPrice * (1 - effectiveTrailPct / 100);

    // ── PnL trail initial values ───────────────────────────────────────────────
    // peakUnrealizedPnl: best unrealized PnL seen so far (₹)
    //   Starts at 0 (no profit at entry)
    // pnlTrailStop: minimum PnL we'll accept before exiting
    //   Starts at -Infinity (trail hasn't activated yet)
    const peakUnrealizedPnl = 0;
    const pnlTrailStop = -Infinity; // activates once pnlTrailFloor is breached

    return {
        direction,
        isShort,

        // ── Hard stop ──────────────────────────────────────────────────────────
        stopPrice,

        // ── Price trail (legacy, still computed for HYBRID mode) ───────────────
        trailStopPrice: initialPriceTrailStop,
        trailPct: effectiveTrailPct,
        highWaterMark: entryPrice,  // price high/low watermark

        // ── PnL trail (new — primary trail mechanism) ──────────────────────────
        trailMode,
        pnlTrailPct,
        pnlTrailFloor,                // minimum profit (₹) before trail activates
        peakUnrealizedPnl,            // peak profit seen so far (₹)
        pnlTrailStop,                 // current trail floor in ₹ (-Infinity = inactive)
        pnlTrailActivated: false,     // has trail floor been crossed yet?

        // ── Profit target ──────────────────────────────────────────────────────
        profitTargetPrice,
        profitTargetMode: targetMode,

        // ── Partial exit ───────────────────────────────────────────────────────
        partialExitEnabled,
        partialExitQty: partialQty,
        partialExitDone: false,

        // ── Signal reversal ────────────────────────────────────────────────────
        signalReversalEnabled,
        openingStrategy,

        // ── Metadata ───────────────────────────────────────────────────────────
        entryAtrPct: atrPct,
        entryRegime: regime,
        entryTrailPct: effectiveTrailPct,
        trailMultiplier,

        // ── PnL trail metadata for dashboard ──────────────────────────────────
        peakPnlAt: null,  // timestamp when peak was hit
        pnlTrailHistory: [],    // [{pnl, price, ts}] for debugging
    };
}

// ─────────────────────────────────────────────────────────────────────────────
// updateTrailStop — PnL-aware ratchet
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Recompute and ratchet trail stops given current price.
 *
 * PRIMARY: PnL trail — tracks peak ₹ profit, exits if it drops by pnlTrailPct%
 * SECONDARY: Price trail — legacy behavior, used in HYBRID mode
 *
 * @param {Object}   posCtx
 * @param {number}   currentPrice
 * @param {number[]} recentCloses
 * @param {number[]} recentHighs
 * @param {number[]} recentLows
 * @param {string}   regime
 * @param {Object}   config
 * @returns {Partial<Object>} fields to merge back into posCtx
 */
export function updateTrailStop(
    posCtx, currentPrice,
    recentCloses, recentHighs, recentLows,
    regime, config,
) {
    const updates = {};
    const isShort = posCtx.isShort ?? posCtx.direction === 'SELL';
    const qty = posCtx.quantity;
    const entry = posCtx.entryPrice ?? posCtx.price;

    // ── Compute current unrealized PnL in ₹ ─────────────────────────────────
    const unrealizedPnl = isShort
        ? (entry - currentPrice) * qty   // short: profit when price falls
        : (currentPrice - entry) * qty;  // long:  profit when price rises

    const trailMode = posCtx.trailMode ?? TRAIL_MODE.PNL_TRAIL;
    const pnlTrailPct = posCtx.pnlTrailPct ?? 25;
    const pnlFloor = posCtx.pnlTrailFloor ?? (entry * qty * 0.005);

    // ── PnL Trail Update ─────────────────────────────────────────────────────

    if (trailMode === TRAIL_MODE.PNL_TRAIL || trailMode === TRAIL_MODE.HYBRID) {
        const currentPeak = posCtx.peakUnrealizedPnl ?? 0;

        // Update peak PnL if current is higher
        if (unrealizedPnl > currentPeak) {
            updates.peakUnrealizedPnl = unrealizedPnl;
            updates.peakPnlAt = Date.now();

            // Activate trail once profit crosses the floor threshold
            if (unrealizedPnl >= pnlFloor) {
                // PnL trail stop: retain (100 - pnlTrailPct)% of peak
                // Example: peak ₹10,000, trail 25% → floor = ₹7,500
                const newPnlTrailStop = unrealizedPnl * (1 - pnlTrailPct / 100);

                // Trail only ratchets UP (protects more profit as peak grows)
                // Never moves DOWN even if we recompute a lower value
                const currentPnlTrailStop = posCtx.pnlTrailStop ?? -Infinity;

                if (newPnlTrailStop > currentPnlTrailStop) {
                    updates.pnlTrailStop = newPnlTrailStop;
                    updates.pnlTrailActivated = true;

                    // Diagnostics for dashboard/Telegram
                    updates.pnlTrailHistory = [
                        ...(posCtx.pnlTrailHistory ?? []).slice(-9), // keep last 10
                        {
                            pnl: +unrealizedPnl.toFixed(2),
                            floor: +newPnlTrailStop.toFixed(2),
                            price: currentPrice,
                            pct: pnlTrailPct,
                            ts: Date.now(),
                        },
                    ];
                }
            }
        }
    }

    // ── Price Trail Update (legacy, for HYBRID mode) ─────────────────────────

    if (trailMode === TRAIL_MODE.PRICE_TRAIL || trailMode === TRAIL_MODE.HYBRID) {
        const newWatermark = isShort
            ? currentPrice < posCtx.highWaterMark   // new low for shorts
            : currentPrice > posCtx.highWaterMark;  // new high for longs

        if (newWatermark) {
            updates.highWaterMark = currentPrice;
            updates.currentRegime = regime;

            const atrPct = recentCloses.length >= 14
                ? computeAtrPct(recentHighs, recentLows, recentCloses)
                : null;
            const multiplier = REGIME_TRAIL_MULTIPLIER[regime] ?? REGIME_TRAIL_MULTIPLIER.UNKNOWN;
            const trailPct = (atrPct != null ? atrPct : posCtx.trailPct) * multiplier;

            let newPriceTrail = isShort
                ? currentPrice * (1 + trailPct / 100)
                : currentPrice * (1 - trailPct / 100);

            // Break-even protection
            const profitable = isShort
                ? currentPrice <= entry * 0.995
                : currentPrice >= entry * 1.005;

            if (profitable) {
                if (isShort && newPriceTrail > entry) newPriceTrail = entry;
                if (!isShort && newPriceTrail < entry) newPriceTrail = entry;
            }

            const trailImproved = isShort
                ? newPriceTrail < posCtx.trailStopPrice
                : newPriceTrail > posCtx.trailStopPrice;

            if (trailImproved) {
                updates.trailStopPrice = newPriceTrail;
                updates.trailPct = trailPct;
                updates.trailMultiplier = multiplier;
                updates.currentAtrPct = atrPct;
            }
        }
    }

    return updates;
}

// ─────────────────────────────────────────────────────────────────────────────
// evaluateExits — PnL trail check added
// ─────────────────────────────────────────────────────────────────────────────

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
    const qty = posCtx.quantity;
    const entry = posCtx.entryPrice ?? posCtx.price;

    // ── Update trail before checking ──────────────────────────────────────────
    const updatedLevels = updateTrailStop(
        posCtx, currentPrice,
        recentCloses, recentHighs, recentLows,
        regime, config,
    );
    Object.assign(posCtx, updatedLevels);

    // ── Current unrealized PnL ────────────────────────────────────────────────
    const unrealizedPnl = isShort
        ? (entry - currentPrice) * qty
        : (currentPrice - entry) * qty;

    // ── 1. STOP_LOSS (price-based hard floor — unchanged) ─────────────────────
    const stopHit = isShort
        ? currentPrice >= posCtx.stopPrice
        : currentPrice <= posCtx.stopPrice;

    if (stopHit) {
        return {
            exit: true, partial: false,
            reason: 'STOP_LOSS',
            qty,
            meta: {
                trigger: posCtx.stopPrice,
                current: currentPrice,
                lossRupees: +Math.abs(unrealizedPnl).toFixed(2),
                lossPct: +pct(entry, currentPrice, isShort).toFixed(2),
                isShort,
            },
        };
    }

    // ── 2. PROFIT_TARGET / PARTIAL_EXIT (unchanged) ───────────────────────────
    const targetHit = isShort
        ? currentPrice <= posCtx.profitTargetPrice
        : currentPrice >= posCtx.profitTargetPrice;

    if (targetHit && (!posCtx.partialExitEnabled || posCtx.partialExitDone)) {
        return {
            exit: true, partial: false,
            reason: 'PROFIT_TARGET',
            qty,
            meta: {
                target: posCtx.profitTargetPrice,
                current: currentPrice,
                gainRupees: +unrealizedPnl.toFixed(2),
                gainPct: +pct(entry, currentPrice, isShort).toFixed(2),
                mode: posCtx.profitTargetMode,
                isShort,
            },
        };
    }

    if (posCtx.partialExitEnabled && !posCtx.partialExitDone &&
        targetHit && posCtx.partialExitQty > 0 &&
        posCtx.partialExitQty < posCtx.quantity) {
        return {
            exit: false, partial: true,
            reason: 'PARTIAL_EXIT',
            qty: posCtx.partialExitQty,
            meta: {
                target: posCtx.profitTargetPrice,
                current: currentPrice,
                partialQty: posCtx.partialExitQty,
                remainingQty: posCtx.quantity - posCtx.partialExitQty,
                gainPct: +pct(entry, currentPrice, isShort).toFixed(2),
                isShort,
            },
        };
    }

    // ── 3. PNL TRAILING STOP (NEW — primary trail check) ─────────────────────
    //
    // Fires when ALL of these are true:
    //   a) Trail has been activated (peak profit crossed pnlTrailFloor)
    //   b) Current PnL has dropped below the trail floor
    //   c) We were profitable (peak > 0) — prevents firing on initial loss
    //
    const trailMode = posCtx.trailMode ?? TRAIL_MODE.PNL_TRAIL;
    const isPnlTrail = trailMode === TRAIL_MODE.PNL_TRAIL || trailMode === TRAIL_MODE.HYBRID;

    if (isPnlTrail && posCtx.pnlTrailActivated) {
        const pnlDroppedThroughFloor = unrealizedPnl < posCtx.pnlTrailStop;
        const wasEverProfitable = (posCtx.peakUnrealizedPnl ?? 0) > 0;

        if (pnlDroppedThroughFloor && wasEverProfitable) {
            const retainedPct = posCtx.peakUnrealizedPnl > 0
                ? (posCtx.pnlTrailStop / posCtx.peakUnrealizedPnl * 100).toFixed(1)
                : 0;

            return {
                exit: true, partial: false,
                reason: 'TRAILING_STOP',  // keeps same reason string for compatibility
                qty,
                meta: {
                    trailType: 'PNL_TRAIL',
                    currentPnl: +unrealizedPnl.toFixed(2),
                    peakPnl: +posCtx.peakUnrealizedPnl.toFixed(2),
                    pnlFloor: +posCtx.pnlTrailStop.toFixed(2),
                    pnlGivenBack: +(posCtx.peakUnrealizedPnl - unrealizedPnl).toFixed(2),
                    pnlGivenBackPct: +(100 - parseFloat(retainedPct)).toFixed(1),
                    retainedPct: +retainedPct,
                    currentPrice,
                    entryPrice: entry,
                    quantity: qty,
                    regime: posCtx.currentRegime ?? posCtx.entryRegime,
                    isShort,
                },
            };
        }
    }

    // ── 4. PRICE TRAILING STOP (legacy, or HYBRID second check) ──────────────
    //
    // In PNL_TRAIL mode:  only fires if position never became profitable
    //                     (PnL trail never activated) — acts as a backstop
    // In PRICE_TRAIL mode: fires as before
    // In HYBRID mode:      fires if EITHER PnL OR price trail is breached
    //
    const isPriceTrail = trailMode === TRAIL_MODE.PRICE_TRAIL || trailMode === TRAIL_MODE.HYBRID;
    const pnlTrailNeverActivated = !posCtx.pnlTrailActivated;

    const shouldCheckPriceTrail = isPriceTrail ||
        (trailMode === TRAIL_MODE.PNL_TRAIL && pnlTrailNeverActivated);

    if (shouldCheckPriceTrail) {
        const priceTrailHit = isShort
            ? currentPrice >= posCtx.trailStopPrice && posCtx.highWaterMark < entry
            : currentPrice <= posCtx.trailStopPrice && posCtx.highWaterMark > entry;

        if (priceTrailHit) {
            return {
                exit: true, partial: false,
                reason: 'TRAILING_STOP',
                qty,
                meta: {
                    trailType: 'PRICE_TRAIL',
                    trailStop: posCtx.trailStopPrice,
                    highWaterMark: posCtx.highWaterMark,
                    currentPrice,
                    currentPnl: +unrealizedPnl.toFixed(2),
                    lockedPnlPct: +pct(entry, posCtx.trailStopPrice, isShort).toFixed(2),
                    regime: posCtx.currentRegime ?? posCtx.entryRegime,
                    isShort,
                },
            };
        }
    }

    // ── 5–6. Signal reversal + Time exit (unchanged) ─────────────────────────
    if (posCtx.signalReversalEnabled && posCtx.openingStrategy) {
        const reversalSignal = latestSignals[posCtx.openingStrategy];
        const reversalHit = isShort
            ? reversalSignal === 'BUY'
            : reversalSignal === 'SELL';

        if (reversalHit) {
            return {
                exit: true, partial: false,
                reason: 'SIGNAL_REVERSAL',
                qty,
                meta: {
                    strategy: posCtx.openingStrategy,
                    signal: reversalSignal,
                    currentPnl: +unrealizedPnl.toFixed(2),
                    isShort,
                },
            };
        }
    }

    if (!isShort && latestSignals?.RSI_MEAN_REVERSION === 'SELL') {
        const rsiConfidence = latestSignals?._RSI_CONFIDENCE ?? 0;
        if (rsiConfidence >= 65) {
            return {
                exit: true, partial: false,
                reason: 'RSI_OVERBOUGHT_EXIT',
                qty,
                meta: { rsiConfidence, currentPnl: +unrealizedPnl.toFixed(2) },
            };
        }
    }

    const holdMinutes = (Date.now() - posCtx.timestamp) / 60000;
    const pnlPct = +pct(entry, currentPrice, isShort).toFixed(2);
    const maxHold = config.maxHoldMinutes ?? 90;

    if (holdMinutes >= maxHold && pnlPct < 0.3) {
        return {
            exit: true, partial: false,
            reason: 'TIME_EXIT',
            qty,
            meta: {
                holdMinutes: +holdMinutes.toFixed(1),
                maxHold,
                pnlPct,
                currentPnl: +unrealizedPnl.toFixed(2),
                tier: 'soft',
                isShort,
            },
        };
    }

    const trailInProfitZone = isShort
        ? posCtx.trailStopPrice <= entry
        : posCtx.trailStopPrice >= entry;

    if (holdMinutes >= maxHold * 2 && !trailInProfitZone) {
        return {
            exit: true, partial: false,
            reason: 'TIME_EXIT',
            qty,
            meta: {
                holdMinutes: +holdMinutes.toFixed(1),
                maxHold,
                pnlPct,
                currentPnl: +unrealizedPnl.toFixed(2),
                tier: 'hard',
                isShort,
            },
        };
    }

    return noExit;
}

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

function pct(entry, current, isShort = false) {
    if (entry <= 0) return 0;
    return isShort
        ? ((entry - current) / entry) * 100
        : ((current - entry) / entry) * 100;
}

export function computeAtrPct(highs, lows, closes, period = 14) {
    if (!highs?.length || !lows?.length || !closes?.length ||
        highs.length < period + 1 || closes.length < period + 1) return null;

    const trs = [];
    for (let i = 1; i < closes.length; i++) {
        const hl = highs[i] - lows[i];
        const hpc = Math.abs(highs[i] - closes[i - 1]);
        const lpc = Math.abs(lows[i] - closes[i - 1]);
        trs.push(Math.max(hl, hpc, lpc));
    }
    const recent = trs.slice(-period);
    const atr = recent.reduce((a, b) => a + b, 0) / recent.length;
    const last = closes[closes.length - 1];
    return last <= 0 ? null : (atr / last) * 100;
}