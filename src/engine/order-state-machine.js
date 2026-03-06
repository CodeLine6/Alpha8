import { ORDER_STATE } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('order-state');

/**
 * Order State Machine.
 *
 * Valid transitions:
 *   PENDING → PLACED     (broker accepted)
 *   PENDING → REJECTED   (risk gate or broker rejected)
 *   PLACED  → FILLED     (execution confirmed)
 *   PLACED  → REJECTED   (broker rejected after acceptance)
 *   PLACED  → CANCELLED  (user/system cancelled)
 *
 * Invalid transitions throw — these indicate logic bugs.
 *
 * @module order-state-machine
 */

const VALID_TRANSITIONS = Object.freeze({
  [ORDER_STATE.PENDING]:   [ORDER_STATE.PLACED, ORDER_STATE.REJECTED],
  [ORDER_STATE.PLACED]:    [ORDER_STATE.FILLED, ORDER_STATE.REJECTED, ORDER_STATE.CANCELLED],
  [ORDER_STATE.FILLED]:    [],    // Terminal
  [ORDER_STATE.REJECTED]:  [],    // Terminal
  [ORDER_STATE.CANCELLED]: [],    // Terminal
});

/**
 * Create a new order object in PENDING state.
 *
 * @param {Object} params
 * @param {string} params.symbol
 * @param {string} params.side - 'BUY' or 'SELL'
 * @param {number} params.quantity
 * @param {number} params.price
 * @param {string} [params.orderType='MARKET']
 * @param {string} [params.exchange='NSE']
 * @param {string} [params.product='MIS']
 * @param {string} [params.strategy]
 * @returns {Object} Order object
 */
export function createOrder(params) {
  const order = {
    id: `ORD-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    symbol: params.symbol,
    side: params.side,
    quantity: params.quantity,
    price: params.price,
    orderType: params.orderType || 'MARKET',
    exchange: params.exchange || 'NSE',
    product: params.product || 'MIS',
    strategy: params.strategy || 'unknown',
    state: ORDER_STATE.PENDING,
    brokerId: null,
    rejectionReason: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    history: [{ state: ORDER_STATE.PENDING, at: new Date().toISOString() }],
  };

  log.info({ orderId: order.id, symbol: order.symbol, side: order.side, qty: order.quantity },
    'Order created in PENDING state');

  return order;
}

/**
 * Transition an order to a new state.
 * Throws if the transition is invalid (indicates a logic bug).
 *
 * @param {Object} order - The order object
 * @param {string} newState - Target state
 * @param {Object} [meta={}] - Additional metadata (brokerId, rejectionReason)
 * @returns {Object} Updated order
 */
export function transitionOrder(order, newState, meta = {}) {
  const allowed = VALID_TRANSITIONS[order.state];

  if (!allowed || !allowed.includes(newState)) {
    const msg = `Invalid order transition: ${order.state} → ${newState} (order: ${order.id})`;
    log.error({ orderId: order.id, from: order.state, to: newState }, msg);
    throw new Error(msg);
  }

  const now = new Date().toISOString();

  order.state = newState;
  order.updatedAt = now;
  order.history.push({ state: newState, at: now, ...meta });

  if (meta.brokerId) order.brokerId = meta.brokerId;
  if (meta.rejectionReason) order.rejectionReason = meta.rejectionReason;

  log.info({
    orderId: order.id,
    symbol: order.symbol,
    from: order.history[order.history.length - 2]?.state,
    to: newState,
    brokerId: meta.brokerId || null,
    rejectionReason: meta.rejectionReason || null,
  }, `Order ${order.id}: ${order.history[order.history.length - 2]?.state} → ${newState}`);

  return order;
}

/**
 * Check if an order is in a terminal state.
 * @param {Object} order
 * @returns {boolean}
 */
export function isTerminal(order) {
  return VALID_TRANSITIONS[order.state]?.length === 0;
}
