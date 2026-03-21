/**
 * @fileoverview Brokerage & Transaction Cost Calculator for Alpha8
 *
 * Zerodha pricing for intraday equity (MIS) trades:
 *   Brokerage   : ₹20 flat OR 0.03% of trade value — whichever is LOWER
 *   STT         : 0.025% of trade value on the SELL side only
 *   Exchange fee: 0.00345% (NSE) both sides
 *   SEBI fee    : ₹10 per crore (0.000001 of trade value) both sides
 *   Stamp duty  : 0.003% on BUY side only
 *   GST         : 18% on (brokerage + exchange fee + SEBI fee)
 *
 * All values rounded to 2 decimal places.
 *
 * Usage:
 *   import { calcTradeCost, calcRoundTripCost } from './brokerage.js';
 *
 *   // Cost for a single leg (BUY or SELL):
 *   const cost = calcTradeCost({ side: 'BUY', price: 2500, quantity: 10 });
 *
 *   // Total cost for a complete round-trip (BUY + SELL):
 *   const total = calcRoundTripCost({ entryPrice: 2500, exitPrice: 2600, quantity: 10 });
 */

// ── Constants ─────────────────────────────────────────────────────────────────

/** Zerodha flat brokerage cap per executed order */
const BROKERAGE_FLAT_CAP = 20;

/** Zerodha intraday brokerage rate (0.03%) */
const BROKERAGE_RATE = 0.0003;

/** Securities Transaction Tax — 0.025% on SELL side only (intraday equity) */
const STT_RATE = 0.00025;

/** NSE Exchange transaction fee — 0.00345% both sides */
const EXCHANGE_FEE_RATE = 0.0000345;

/** SEBI fee — ₹10 per crore = 0.000001 of trade value, both sides */
const SEBI_FEE_RATE = 0.000001;

/** Stamp duty — 0.003% on BUY side only */
const STAMP_DUTY_RATE = 0.00003;

/** GST rate — 18% on brokerage + exchange fee + SEBI fee */
const GST_RATE = 0.18;

// ── Core calculator ───────────────────────────────────────────────────────────

/**
 * Calculate total transaction cost for a single order leg.
 *
 * @param {Object} params
 * @param {'BUY'|'SELL'} params.side
 * @param {number}        params.price      - Execution price per share
 * @param {number}        params.quantity   - Number of shares
 * @returns {{
 *   brokerage:   number,
 *   stt:         number,
 *   exchangeFee: number,
 *   sebiFee:     number,
 *   stampDuty:   number,
 *   gst:         number,
 *   total:       number,
 *   tradeValue:  number,
 * }}
 */
export function calcTradeCost({ side, price, quantity }) {
    const tradeValue = price * quantity;

    // Brokerage: flat ₹20 or 0.03% — whichever is lower
    const brokerage = Math.min(BROKERAGE_FLAT_CAP, tradeValue * BROKERAGE_RATE);

    // STT: only on SELL side for intraday equity
    const stt = side === 'SELL' ? tradeValue * STT_RATE : 0;

    // Exchange transaction fee (both sides)
    const exchangeFee = tradeValue * EXCHANGE_FEE_RATE;

    // SEBI fee (both sides)
    const sebiFee = tradeValue * SEBI_FEE_RATE;

    // Stamp duty: only on BUY side
    const stampDuty = side === 'BUY' ? tradeValue * STAMP_DUTY_RATE : 0;

    // GST: 18% on brokerage + exchange fee + SEBI fee
    const gst = (brokerage + exchangeFee + sebiFee) * GST_RATE;

    const total = brokerage + stt + exchangeFee + sebiFee + stampDuty + gst;

    const r = (n) => +n.toFixed(2);
    return {
        brokerage: r(brokerage),
        stt: r(stt),
        exchangeFee: r(exchangeFee),
        sebiFee: r(sebiFee),
        stampDuty: r(stampDuty),
        gst: r(gst),
        total: r(total),
        tradeValue: r(tradeValue),
    };
}

/**
 * Calculate the total round-trip transaction cost (BUY leg + SELL leg).
 * Use this to compute net P&L after costs.
 *
 * @param {Object} params
 * @param {number} params.entryPrice
 * @param {number} params.exitPrice
 * @param {number} params.quantity
 * @returns {{
 *   buyLeg:    ReturnType<calcTradeCost>,
 *   sellLeg:   ReturnType<calcTradeCost>,
 *   total:     number,
 * }}
 */
export function calcRoundTripCost({ entryPrice, exitPrice, quantity }) {
    const buyLeg = calcTradeCost({ side: 'BUY', price: entryPrice, quantity });
    const sellLeg = calcTradeCost({ side: 'SELL', price: exitPrice, quantity });
    return {
        buyLeg,
        sellLeg,
        total: +(buyLeg.total + sellLeg.total).toFixed(2),
    };
}

/**
 * Compute net P&L after all transaction costs.
 *
 * @param {Object} params
 * @param {number} params.entryPrice
 * @param {number} params.exitPrice
 * @param {number} params.quantity
 * @returns {{
 *   grossPnl:  number,   - (exitPrice - entryPrice) * quantity
 *   totalCost: number,   - sum of all charges (both legs)
 *   netPnl:    number,   - grossPnl - totalCost
 *   costs:     ReturnType<calcRoundTripCost>,
 * }}
 */
export function calcNetPnl({ entryPrice, exitPrice, quantity }) {
    const grossPnl = (exitPrice - entryPrice) * quantity;
    const costs = calcRoundTripCost({ entryPrice, exitPrice, quantity });
    const netPnl = grossPnl - costs.total;
    return {
        grossPnl: +grossPnl.toFixed(2),
        totalCost: costs.total,
        netPnl: +netPnl.toFixed(2),
        costs,
    };
}

/**
 * Minimum price move (in ₹ per share) needed to break even after round-trip costs.
 * Useful for setting realistic profit targets.
 *
 * @param {number} entryPrice
 * @param {number} quantity
 * @returns {number} Break-even move per share in ₹
 */
export function breakEvenMove(entryPrice, quantity) {
    // Approximate using entry price as exit proxy (costs are very close for small moves)
    const costs = calcRoundTripCost({ entryPrice, exitPrice: entryPrice, quantity });
    return +(costs.total / quantity).toFixed(4);
}