import { createLogger } from '../lib/logger.js';
import { SQUARE_OFF_TIME } from '../config/constants.js';
import { isSquareOffTime, isTradingDay } from '../data/market-hours.js';
import { query } from '../lib/db.js';

const log = createLogger('square-off');

/**
 * Auto Square-Off Job — independent scheduled position closer.
 *
 * Per user requirement: this is a SEPARATE scheduled job, NOT triggered
 * by strategy signals. It runs on its own timer and closes all open
 * positions when the square-off window (3:15 PM IST) is reached.
 *
 * The job is designed to be called by node-cron at 3:15 PM IST
 * or polled every minute during the last 15 minutes of trading.
 *
 * @module square-off-job
 */

/**
 * Execute the auto square-off process.
 *
 * @param {Object} params
 * @param {Object} params.broker - BrokerManager instance
 * @param {import('./risk-manager.js').RiskManager} params.riskManager
 * @param {import('../engine/execution-engine.js').ExecutionEngine} [params.engine]
 * @param {Function} [params.getOpenPositions] - Function that returns current open positions
 * @param {boolean} [params.dryRun=false] - If true, log but don't execute
 * @returns {Promise<{ squaredOff: number, errors: string[] }>}
 */
export async function executeSquareOff({ broker, riskManager, engine, getOpenPositions, dryRun = false, force = false }) {
  const result = { squaredOff: 0, errors: [] };

  // ─── Pre-flight Checks ────────────────────────────────

  if (!force && !isTradingDay()) {
    log.info('Square-off skipped — not a trading day');
    return result;
  }

  if (!force && !isSquareOffTime()) {
    log.info('Square-off skipped — not in square-off window');
    return result;
  }

  log.warn('═══ AUTO SQUARE-OFF INITIATED ═══');

  // ─── Get Open Positions ───────────────────────────────

  let positions;
  try {
    if (getOpenPositions) {
      positions = await getOpenPositions();
    } else if (broker) {
      const rawPositions = await broker.getPositions();
      // Filter to only net open positions
      positions = (rawPositions?.net || rawPositions || []).filter(
        (p) => (p.quantity || p.netQuantity || 0) !== 0
      );
    } else {
      log.error('No position source available for square-off');
      result.errors.push('No position source');
      return result;
    }
  } catch (err) {
    log.error({ err: err.message }, 'Failed to fetch positions for square-off');
    result.errors.push(`Position fetch failed: ${err.message}`);
    return result;
  }

  if (!positions || positions.length === 0) {
    log.info('No open positions to square off');
    return result;
  }

  log.warn({ count: positions.length }, 'Open positions found — squaring off');

  // ─── Close Each Position ──────────────────────────────

  for (const pos of positions) {
    const symbol = pos.tradingsymbol || pos.tradingSymbol || pos.symbol;
    const qty = Math.abs(pos.quantity || pos.netQuantity || 0);
    const side = (pos.quantity || pos.netQuantity || 0) > 0 ? 'SELL' : 'BUY';

    if (qty === 0) continue;

    const orderContext = {
      symbol,
      quantity: qty,
      side,
      reason: `Auto square-off at ${SQUARE_OFF_TIME} IST`,
    };

    log.warn(orderContext, '🔄 Square-off order');

    if (dryRun) {
      log.info(orderContext, '[DRY RUN] Would close position');
      result.squaredOff++;
      continue;
    }

    try {
      let squareOffPrice = 0;
      let orderId;
      let paperMode = !broker;

      if (paperMode) {
        orderId = `SQOFF-${symbol}-${Date.now()}`;
        squareOffPrice = pos.last_price || pos.close_price || pos.average_price || 0;
      } else {
        const squareOffResult = await broker.placeOrder({
          symbol,
          exchange: pos.exchange || 'NSE',
          side,
          quantity: qty,
          orderType: 'MARKET',
          product: pos.product || 'MIS',
        });
        orderId = squareOffResult.order_id || squareOffResult.orderId || `SQOFF-${symbol}-${Date.now()}`;
        squareOffPrice = squareOffResult.price || squareOffResult.average_price || squareOffResult.raw?.average_price || squareOffResult.raw?.price || pos.last_price || pos.close_price || 0;
      }

      if (engine && riskManager) {
        const posCtx = engine._filledPositions?.get(symbol);
        engine.markPositionClosed(symbol);
        riskManager.removePosition();

        if (posCtx) {
          const pnl = (squareOffPrice - posCtx.price) * posCtx.quantity;
          await engine.recordPositionOutcome(symbol, pnl).catch(err => log.warn({ symbol, err: err.message }, 'Outcome recording failed'));
        }
      } else if (riskManager) {
        riskManager.removePosition();
      }

      result.squaredOff++;
      log.info({ symbol, qty, side }, '✅ Position squared off');

      // C3: Persist square-off trade to DB for audit trail
      try {
        await query(
          `INSERT INTO trades (order_id, symbol, side, quantity, price, strategy, status, paper_mode, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, NOW())
           ON CONFLICT (order_id) DO NOTHING`,
          [orderId, symbol, side, qty, squareOffPrice, 'SQUARE_OFF', 'FILLED', paperMode]
        );
      } catch (dbErr) {
        log.error({ symbol, err: dbErr.message }, 'Failed to persist square-off trade to DB');
      }
    } catch (err) {
      const errorMsg = `Failed to square off ${symbol}: ${err.message}`;
      log.error({ symbol, err: err.message }, errorMsg);
      result.errors.push(errorMsg);
    }
  }

  log.warn({
    squaredOff: result.squaredOff,
    errors: result.errors.length,
    total: positions.length,
  }, '═══ AUTO SQUARE-OFF COMPLETE ═══');

  return result;
}
