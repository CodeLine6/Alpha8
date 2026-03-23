/**
 * src/risk/square-off-job.js
 *
 * FIXES APPLIED:
 *
 *   Fix C1 — Square-off exits now call riskManager.recordTradePnL()
 *     Previously square-off P&L was completely invisible to the risk manager.
 *     The daily loss limit and kill switch drawdown threshold could never
 *     trigger from square-off losses, which are often the worst losses of the day.
 *     recordTradePnL() is now called for every symbol squared off.
 *
 *   Fix (broker product filter) — Square-off now only closes MIS positions
 *     Previously broker.getPositions() returned ALL positions including CNC
 *     (delivery) and NRML (F&O). The square-off loop would attempt to close
 *     delivery holdings and F&O positions at 3:15 PM. Now filtered to MIS only.
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('square-off');

/**
 * Execute end-of-day square-off for all open intraday positions.
 *
 * @param {Object} deps
 * @param {Object} deps.broker        - BrokerManager instance
 * @param {Object} deps.riskManager   - RiskManager instance
 * @param {Object} deps.engine        - ExecutionEngine instance
 * @param {Function} deps.getOpenPositions - Returns array of open position objects
 */
export async function executeSquareOff({ broker, riskManager, engine, getOpenPositions }) {
  log.warn('═══ SQUARE-OFF EXECUTING ═══');

  const isPaperMode = engine ? !engine._config?.LIVE_TRADING : !broker;

  let positions = [];

  const squaredOff = [];
  const errors = [];

  if (isPaperMode) {
    positions = await getOpenPositions().catch(() => []);
    
    // Paper mode: simulate exit for each position
    for (const pos of positions) {
      const symbol    = pos.tradingsymbol ?? pos.symbol;
      const posCtx    = engine._filledPositions?.get(symbol);
      if (!posCtx) continue;

      const isShort   = posCtx.isShort ?? posCtx.direction === 'SELL';
      const qty       = posCtx.quantity;
      const exitPrice = pos.average_price ?? posCtx.entryPrice ?? posCtx.price;
      
      const result = await engine.forceExit(symbol, exitPrice, 'SQUARE_OFF');
      if (result.success) {
        squaredOff.push({ symbol, qty, pnl: result.pnl, squareOffPrice: exitPrice });
      } else {
        errors.push({ symbol, error: result.reason || 'Paper exit failed' });
      }
    }
    return { squaredOff, errors };
  }

  // Live mode: fetch from broker
  try {
    const rawPositions = await broker.getPositions();
    const allPositions = rawPositions?.net || rawPositions || [];
    positions = allPositions.filter(pos => {
      const qty = Math.abs(pos.quantity || pos.netQuantity || 0);
      const product = (pos.product || '').toUpperCase();
      return qty > 0 && product === 'MIS';
    });
  } catch (err) {
    log.error({ err: err.message }, 'Failed to fetch broker positions for square-off');
    return { squaredOff, errors: [{ symbol: 'FETCH_ERROR', error: err.message }] };
  }

  if (positions.length === 0) {
    log.info('No open intraday positions to square off');
    return { squaredOff, errors };
  }

  // After fetching broker positions, find engine positions with no broker counterpart
  const brokerSymbols = new Set(positions.map(p => p.tradingsymbol || p.symbol));
  for (const [sym, posCtx] of engine._filledPositions) {
    if (!brokerSymbols.has(sym)) {
      log.warn({ sym }, 
        'Square-off: position in engine but not in broker — clearing ghost');
      engine._filledPositions.delete(sym);
      engine._clearOpenPosition(sym).catch(() => {});
      riskManager.removePosition();
    }
  }

  log.warn({
    count: positions.length,
    symbols: positions.map(p => p.tradingsymbol || p.symbol),
  }, `Squaring off ${positions.length} position(s) in live mode`);

  for (const pos of positions) {
    const symbol = pos.tradingsymbol || pos.tradingSymbol || pos.symbol;
    if (!symbol) continue;

    const qty = Math.abs(pos.quantity || pos.netQuantity || 0);
    if (qty === 0) continue;

    try {
      // 1. Determine exit price (freshest LTP possible)
      let exitPrice = 0;
      if (broker) {
        try {
          const ltp = await broker.getLTP([`NSE:${symbol}`]);   // ← array, not string
          exitPrice = ltp?.[`NSE:${symbol}`]?.last_price ?? 0;  // ← correct key lookup
        } catch (e) {
          log.warn({ symbol, err: e.message }, 'Failed to fetch LTP for square-off fallback');
        }
      }

      if (!exitPrice) {
        // Fallback to position data or engine context
        const posCtx = engine._filledPositions.get(symbol);
        exitPrice =
          pos.last_price ||
          pos.close_price ||
          pos.average_price ||
          posCtx?.price ||
          0;
      }

      // 2. Execute exit via engine.forceExit()
      // This handles: Order creation, Broker placement (live), State update, 
      // Risk Manager P&L logging, Outcome recording, and DB Persistence.
      const result = await engine.forceExit(symbol, exitPrice, 'SQUARE_OFF');

      if (result.success) {
        squaredOff.push({
          symbol,
          qty,
          pnl: result.pnl,
          squareOffPrice: result.order?.price || exitPrice
        });
      } else {
        // Fallback for live mode if engine is out-of-sync with broker
        if (!isPaperMode && broker) {
          log.warn({ symbol }, 'Engine out-of-sync: forceExit failed, attempting direct broker exit');

          const rawQty    = pos.quantity ?? pos.netQuantity ?? 0;
          const isShort   = rawQty < 0;  // Kite: negative = short position
          const absQty    = Math.abs(rawQty);
          // If rawQty is 0, the position is already closed perfectly, but we still need to clear engine
          const coverSide = isShort ? 'BUY' : 'SELL';

          let finalPrice = exitPrice;
          if (absQty > 0) {
            const squareOffResult = await broker.placeOrder({
              symbol,
              exchange: 'NSE',
              side: coverSide,
              quantity: absQty,
              orderType: 'MARKET',
              product: 'MIS',
            });
            finalPrice  = squareOffResult?.average_price 
                       ?? squareOffResult?.price 
                       ?? exitPrice;
          }
          
          // Kite's average_price field for MIS positions:
          const entryPrice  = pos.average_price ?? pos.sell_price ?? pos.buy_price ?? pos.buyPrice ?? 0;
          
          // Direction-aware P&L:
          const pnl = isShort
            ? (entryPrice - finalPrice) * absQty   // short: profit when price falls
            : (finalPrice - entryPrice) * absQty;  // long:  profit when price rises

          // Update engine state to prevent ghost positions
          if (engine._filledPositions.has(symbol)) {
            engine._filledPositions.delete(symbol);
            engine._clearOpenPosition(symbol).catch(() => {});
          }

          await riskManager.recordTradePnL(pnl, symbol).catch(() => {});
          riskManager.removePosition();

          squaredOff.push({ symbol, qty: absQty, pnl, squareOffPrice: finalPrice });
        } else {
          throw new Error('Square-off rejected by engine (no position context?)');
        }
      }
    } catch (err) {
      log.error({ symbol, err: err.message }, `Square-off FAILED for ${symbol}`);
      errors.push({ symbol, error: err.message });
    }
  }

  log.warn({
    squaredOff: squaredOff.length,
    errors: errors.length,
    totalPnL: squaredOff.reduce((s, x) => s + x.pnl, 0).toFixed(2),
  }, '═══ SQUARE-OFF COMPLETE ═══');

  return { squaredOff, errors };
}