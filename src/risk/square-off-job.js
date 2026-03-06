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
 * @param {Function} [params.getOpenPositions] - Function that returns current open positions
 * @param {boolean} [params.dryRun=false] - If true, log but don't execute
 * @returns {Promise<{ squaredOff: number, errors: string[] }>}
 */
export async function executeSquareOff({ broker, riskManager, getOpenPositions, dryRun = false, force = false }) {
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
      const squareOffResult = await broker.placeOrder({
        symbol,
        exchange: pos.exchange || 'NSE',
        side,
        quantity: qty,
        orderType: 'MARKET',
        product: pos.product || 'MIS',
      });

      riskManager.removePosition();
      result.squaredOff++;
      log.info({ symbol, qty, side }, '✅ Position squared off');

      // C3: Persist square-off trade to DB for audit trail
      const orderId = `SQR-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      try {
        await query(
          `INSERT INTO trades (order_id, symbol, side, quantity, price, strategy, status, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
           ON CONFLICT (order_id) DO NOTHING`,
          [orderId, symbol, side, qty, 0, 'SQUARE_OFF', 'FILLED']
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
