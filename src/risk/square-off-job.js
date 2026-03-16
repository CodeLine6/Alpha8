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

  if (isPaperMode) {
    // Paper mode: use engine's in-memory positions
    positions = await getOpenPositions().catch(() => []);
  } else {
    // Live mode: fetch from broker
    // Fix (product filter): only square off MIS positions.
    // CNC (delivery) and NRML (F&O) positions are NOT intraday and
    // should not be force-closed at 3:15 PM.
    try {
      const rawPositions = await broker.getPositions();
      const allPositions = rawPositions?.net || rawPositions || [];
      positions = allPositions.filter(pos => {
        const qty = Math.abs(pos.quantity || pos.netQuantity || 0);
        const product = (pos.product || '').toUpperCase();
        // Only MIS (intraday) positions; skip CNC, NRML, CO, BO
        return qty > 0 && product === 'MIS';
      });
    } catch (err) {
      log.error({ err: err.message }, 'Failed to fetch broker positions for square-off');
      return { squaredOff: [], errors: [{ symbol: 'FETCH_ERROR', error: err.message }] };
    }
  }

  if (positions.length === 0) {
    log.info('No open intraday positions to square off');
    return { squaredOff: [], errors: [] };
  }

  log.warn({
    count: positions.length,
    symbols: positions.map(p => p.tradingsymbol || p.symbol),
  }, `Squaring off ${positions.length} position(s)`);

  const squaredOff = [];
  const errors = [];

  for (const pos of positions) {
    const symbol = pos.tradingsymbol || pos.tradingSymbol || pos.symbol;
    if (!symbol) continue;

    const qty = Math.abs(pos.quantity || pos.netQuantity || 0);
    const posCtx = engine._filledPositions.get(symbol);

    if (qty === 0) continue;

    try {
      let squareOffPrice = 0;
      let squareOffResult = null;

      if (!isPaperMode && broker) {
        squareOffResult = await broker.placeOrder({
          symbol,
          exchange: 'NSE',
          side: 'SELL',
          quantity: qty,
          orderType: 'MARKET',
          product: 'MIS',
        }).catch(err => {
          throw new Error(`Broker order failed: ${err.message}`);
        });

        squareOffPrice =
          squareOffResult?.price ||
          squareOffResult?.average_price ||
          squareOffResult?.raw?.average_price ||
          squareOffResult?.raw?.price ||
          pos.last_price ||
          pos.close_price ||
          0;
      } else {
        // Paper mode: approximate with last known price
        squareOffPrice =
          pos.last_price ||
          pos.close_price ||
          pos.average_price ||
          posCtx?.price ||
          0;
      }

      const entryPrice = posCtx?.price ?? pos.average_price ?? pos.buyPrice ?? 0;
      const pnl = squareOffPrice > 0 ? (squareOffPrice - entryPrice) * qty : 0;

      log.warn({
        symbol,
        qty,
        entryPrice,
        squareOffPrice,
        pnl: pnl.toFixed(2),
        isPaperMode,
      }, `Squared off: ${symbol}`);

      // Fix C1: Record P&L so risk manager tracks drawdown from square-off exits.
      // recordTradePnL() is the ONLY mechanism that can auto-engage the kill switch.
      await riskManager.recordTradePnL(pnl, symbol).catch(err =>
        log.error({ symbol, err: err.message }, 'CRITICAL: recordTradePnL failed in square-off')
      );

      await engine.markPositionClosed(symbol);
      await riskManager.removePosition();

      if (posCtx) {
        await engine.recordPositionOutcome(symbol, pnl).catch(err =>
          log.warn({ symbol, err: err.message }, 'Outcome recording failed during square-off')
        );
      }

      squaredOff.push({ symbol, qty, pnl, squareOffPrice });
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