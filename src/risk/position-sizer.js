import { createLogger } from '../lib/logger.js';
import { RISK_DEFAULTS } from '../config/constants.js';

const log = createLogger('position-sizer');

/**
 * Position Sizing Module — Kelly Criterion + hard caps.
 *
 * Calculates optimal position size using the Kelly Criterion formula,
 * then clamps it to per-trade risk limits and capital constraints.
 *
 * Kelly Formula: f* = (bp - q) / b
 *   where b = odds ratio, p = win probability, q = loss probability (1-p)
 *
 * @module position-sizer
 */

/**
 * Calculate position size using Kelly Criterion.
 *
 * @param {Object} params
 * @param {number} params.capital - Total available capital
 * @param {number} params.winRate - Historical win rate (0.0–1.0)
 * @param {number} params.avgWin - Average winning trade P&L in absolute rupees
 * @param {number} params.avgLoss - Average losing trade P&L in absolute rupees (positive number)
 * @param {number} params.entryPrice - Expected entry price per share
 * @param {number} [params.maxRiskPct] - Max capital % to risk per trade (default from RISK_DEFAULTS)
 * @param {number} [params.kellyFraction=0.5] - Fractional Kelly (0.5 = half Kelly for safety)
 * @param {number} [params.maxPositionPct=20] - Max % of capital in any single position
 * @returns {{ quantity: number, riskAmount: number, kellyPct: number, positionValue: number, reasoning: string }}
 */
export function calculatePositionSize({
  capital,
  winRate,
  avgWin,
  avgLoss,
  entryPrice,
  maxRiskPct = RISK_DEFAULTS.PER_TRADE_STOP_LOSS_PCT,
  kellyFraction = 0.5,
  maxPositionPct = RISK_DEFAULTS.MAX_POSITION_VALUE_PCT,
}) {
  // Validate inputs
  if (!capital || capital <= 0 || !entryPrice || entryPrice <= 0) {
    log.warn({ capital, entryPrice }, 'Invalid inputs for position sizing');
    return {
      quantity: 0,
      riskAmount: 0,
      kellyPct: 0,
      positionValue: 0,
      reasoning: 'Invalid capital or entry price',
    };
  }

  let kellyPct = 0;
  const reasons = [];

  if (winRate > 0 && winRate < 1 && avgWin > 0 && avgLoss > 0) {
    // S1 FIX: guard against division by zero and NaN propagation.
    if (!Number.isFinite(avgWin) || !Number.isFinite(avgLoss) ||
        avgWin <= 0 || avgLoss <= 0) {
      kellyPct = maxRiskPct / 100;
      reasons.push(`Invalid win/loss inputs (avgWin=${avgWin}, avgLoss=${avgLoss}) — using fixed ${maxRiskPct}% risk`);
    } else {
      const avgWinFrac = avgWin / capital;
      const avgLossFrac = avgLoss / capital;
      const b = avgWinFrac / avgLossFrac; // Odds ratio (risk-reward)
      const p = winRate;
      const q = 1 - p;

      const fullKelly = ((b * p) - q) / b;

      // S1 FIX: explicit NaN/Infinity guard after Kelly formula
      if (!Number.isFinite(fullKelly)) {
        kellyPct = maxRiskPct / 100;
        reasons.push(`Kelly produced non-finite result (${fullKelly}) — using fixed ${maxRiskPct}% risk`);
      } else {
        kellyPct = fullKelly * kellyFraction; // Half Kelly for safety
        reasons.push(
          `Kelly: b=${b.toFixed(2)}, p=${p.toFixed(2)}, f*=${fullKelly.toFixed(4)}, ` +
          `${kellyFraction}×Kelly=${kellyPct.toFixed(4)}`
        );

        // Kelly can go negative (meaning don't trade)
        if (kellyPct <= 0) {
          log.info({ kellyPct, winRate, avgWin, avgLoss }, 'Kelly suggests no trade — negative or zero edge');
          return {
            quantity: 0,
            riskAmount: 0,
            kellyPct: +(kellyPct * 100).toFixed(2),
            positionValue: 0,
            kellyNegative: true, // L2 FIX: explicit flag for callers
            reasoning: `Kelly negative (${(kellyPct * 100).toFixed(2)}%) — edge is insufficient. Do not override with minimum quantity.`,
          };
        }
      }
    }
  } else {
    // No historical data — fall back to fixed fractional
    kellyPct = maxRiskPct / 100;
    reasons.push(`No history — using fixed ${maxRiskPct}% risk`);
  }

  // ─── Risk Amount ──────────────────────────────────────
  // Max capital at risk for this trade
  const maxRiskFromKelly = capital * kellyPct;
  const maxRiskFromCap = capital * (maxRiskPct / 100);
  const riskAmount = Math.min(maxRiskFromKelly, maxRiskFromCap);

  reasons.push(`Risk: min(Kelly ₹${maxRiskFromKelly.toFixed(0)}, Cap ₹${maxRiskFromCap.toFixed(0)}) = ₹${riskAmount.toFixed(0)}`);

  // ─── Position Value Cap ───────────────────────────────
  const maxPositionValue = capital * (maxPositionPct / 100);

  // ─── Quantity Calculation ─────────────────────────────
  // Shares = risk amount / (stop loss per share)
  // We assume stop loss = maxRiskPct% of entry price
  const stopLossPerShare = entryPrice * (maxRiskPct / 100);
  let quantity = Math.floor(riskAmount / stopLossPerShare);

  // Cap by max position value
  const maxAllowedByCapValue = Math.floor(maxPositionValue / entryPrice);
  if (quantity > maxAllowedByCapValue) {
    quantity = maxAllowedByCapValue;
    reasons.push(`Position capped at ${maxPositionPct}% of capital (max ${maxAllowedByCapValue} shares)`);
  }

  // Hard Cap: Total value must not exceed available capital
  const maxAllowedByTotalCapital = Math.floor(capital / entryPrice);
  if (quantity > maxAllowedByTotalCapital) {
    quantity = maxAllowedByTotalCapital;
    reasons.push(`Position capped by total capital (max ${maxAllowedByTotalCapital} shares)`);
  }

  // S1 FIX: guard against NaN quantity.
  if (!Number.isFinite(quantity)) quantity = 0;

  const finalPositionValue = quantity * entryPrice;

  log.info({
    quantity,
    riskAmount: +riskAmount.toFixed(2),
    kellyPct: +(kellyPct * 100).toFixed(2),
    positionValue: +finalPositionValue.toFixed(2),
  }, reasons.join('. '));

  return {
    quantity,
    riskAmount: +riskAmount.toFixed(2),
    kellyPct: +(kellyPct * 100).toFixed(2),
    positionValue: +finalPositionValue.toFixed(2),
    reasoning: reasons.join('. '),
  };
}
