import { createLogger } from '../lib/logger.js';
import { ORDER_STATE, MAX_ORDER_RETRIES, RETRY_DELAY_MS } from '../config/constants.js';
import { createOrder, transitionOrder, isTerminal } from './order-state-machine.js';
import { query } from '../lib/db.js';

const log = createLogger('execution-engine');

/**
 * Order Execution Engine.
 *
 * Central orchestrator for trade execution. All 7 requirements:
 *   1. Always calls riskManager.validateOrder() BEFORE placing
 *   2. Full state machine: PENDING → PLACED → FILLED | REJECTED | CANCELLED
 *   3. Paper mode mirrors live — only broker.placeOrder() is swapped
 *   4. Logs broker rejection reason verbatim
 *   5. Blocks duplicate PENDING orders per symbol
 *   6. Integrates SignalConsensus — min 2 strategies agree
 *   7. Calls killSwitch.verifyIntegrity() at startup
 *
 * @module execution-engine
 */

export class ExecutionEngine {
  /**
   * @param {Object} deps
   * @param {import('../risk/risk-manager.js').RiskManager} deps.riskManager
   * @param {import('../risk/kill-switch.js').KillSwitch} deps.killSwitch
   * @param {import('./signal-consensus.js').SignalConsensus} deps.consensus
   * @param {Object} [deps.broker] - BrokerManager (null in paper mode)
   * @param {boolean} [deps.paperMode=true]
   * @param {number} [deps.maxRetries]
   * @param {number} [deps.retryDelayMs]
   */
  constructor(deps) {
    this.riskManager = deps.riskManager;
    this.killSwitch = deps.killSwitch;
    this.consensus = deps.consensus;
    this.broker = deps.broker || null;
    this.paperMode = deps.paperMode ?? true;
    this.maxRetries = deps.maxRetries ?? MAX_ORDER_RETRIES;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;

    /** @type {Map<string, Object>} Active orders by ID */
    this._orders = new Map();

    /** @type {Set<string>} Symbols with PENDING orders (duplicate guard) */
    this._pendingSymbols = new Set();

    /** @type {Set<string>} Symbols with FILLED positions today (H1: duplicate signal guard) */
    this._filledPositions = new Set();

    /** @type {boolean} Whether the engine has been initialized */
    this._initialized = false;

    log.info({
      paperMode: this.paperMode,
      maxRetries: this.maxRetries,
      strategies: this.consensus.strategies.length,
    }, 'ExecutionEngine created');
  }

  // ═══════════════════════════════════════════════════════
  // STARTUP
  // ═══════════════════════════════════════════════════════

  /**
   * Initialize the engine. MUST be called before any trading.
   * Requirement #7: calls killSwitch.verifyIntegrity() at startup.
   *
   * @returns {Promise<{ ready: boolean, integrity: Object }>}
   */
  async initialize() {
    log.info('Initializing execution engine...');

    // Requirement #7: verify kill switch integrity
    const integrity = await this.killSwitch.verifyIntegrity();

    if (this.killSwitch.isEngaged()) {
      log.error({
        integrity,
        killSwitchStatus: this.killSwitch.getStatus(),
      }, 'Engine startup BLOCKED — kill switch is engaged');

      this._initialized = false;
      return { ready: false, integrity };
    }

    this._initialized = true;
    log.info({ integrity, paperMode: this.paperMode },
      'Execution engine initialized and ready');

    return { ready: true, integrity };
  }

  // ═══════════════════════════════════════════════════════
  // SIGNAL PROCESSING
  // ═══════════════════════════════════════════════════════

  /**
   * Process candle data through the consensus layer and execute if signal fires.
   * This is the main entry point called by the scheduler.
   *
   * @param {string} symbol
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @param {number} currentPrice
   * @param {number} quantity
   * @returns {Promise<{ action: string, order: Object|null, consensus: Object }>}
   */
  async processSignal(symbol, candles, currentPrice, quantity) {
    if (!this._initialized) {
      return { action: 'ENGINE_NOT_INITIALIZED', order: null, consensus: null };
    }

    // Requirement #6: signal consensus
    const consensus = this.consensus.evaluate(candles);

    // ─── Persist all signals to DB (fire-and-forget) ──────
    this._persistSignals(symbol, consensus).catch((err) =>
      log.error({ symbol, err: err.message }, 'Signal persistence failed')
    );

    if (consensus.signal === 'HOLD') {
      return { action: 'HOLD', order: null, consensus };
    }

    // Execute the trade based on consensus signal
    const order = await this.executeOrder({
      symbol,
      side: consensus.signal,
      quantity,
      price: currentPrice,
      strategy: consensus.reason,
    });

    const acted = order.state === ORDER_STATE.FILLED;

    // Update the consensus signal record to mark it as acted on
    if (acted) {
      this._markSignalActedOn(symbol, consensus.signal).catch(() => {});
    }

    return {
      action: acted ? 'EXECUTED' : order.state,
      order,
      consensus,
    };
  }

  // ═══════════════════════════════════════════════════════
  // ORDER EXECUTION — The core loop
  // ═══════════════════════════════════════════════════════

  /**
   * Execute an order through the full pipeline:
   * Risk gate → Duplicate check → State machine → Broker (with retries)
   *
   * Paper and live modes follow the SAME code path.
   * Only the broker call is swapped (Requirement #3).
   *
   * @param {Object} params
   * @param {string} params.symbol
   * @param {string} params.side
   * @param {number} params.quantity
   * @param {number} params.price
   * @param {string} [params.orderType='MARKET']
   * @param {string} [params.exchange='NSE']
   * @param {string} [params.product='MIS']
   * @param {string} [params.strategy]
   * @returns {Promise<Object>} Final order object
   */
  async executeOrder(params) {
    // ─── Create order in PENDING state ────────────────────
    const order = createOrder(params);
    this._orders.set(order.id, order);

    // ─── Requirement #5: Duplicate pending guard ─────────
    if (this._pendingSymbols.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Duplicate: existing PENDING order for ${params.symbol}`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        'Order REJECTED — duplicate PENDING order for symbol');
      return order;
    }

    // ─── H1: Duplicate filled position guard (BUY only) ──
    if (params.side === 'BUY' && this._filledPositions.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Already holding position in ${params.symbol}`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        'Order REJECTED — already holding position for symbol');
      return order;
    }

    // ─── Requirement #1: Risk gate ───────────────────────
    const riskDecision = this.riskManager.validateOrder({
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      price: params.price,
      strategy: params.strategy,
    });

    if (!riskDecision.allowed) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Risk gate: ${riskDecision.reason}`,
      });
      log.warn({
        orderId: order.id,
        symbol: params.symbol,
        riskReason: riskDecision.reason,
      }, 'Order REJECTED by risk manager');
      return order;
    }

    // ─── Mark symbol as pending ──────────────────────────
    this._pendingSymbols.add(params.symbol);

    // ─── Place order (with retries) ──────────────────────
    try {
      const brokerResult = await this._placeWithRetry(order);
      return brokerResult;
    } finally {
      // Always clear pending guard
      this._pendingSymbols.delete(params.symbol);
    }
  }

  /**
   * Place order with retry logic.
   *
   * ONLY retries transient/network errors (timeouts, 5xx, connection resets).
   * Broker rejections (4xx, insufficient margin, invalid qty) are NOT retried —
   * they fail deterministically and retrying is wasteful and noisy.
   *
   * @private
   * @param {Object} order
   * @returns {Promise<Object>}
   */
  async _placeWithRetry(order) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      // ─── C6: Kill switch check before each attempt ────
      if (this.killSwitch.isEngaged()) {
        transitionOrder(order, ORDER_STATE.REJECTED, {
          rejectionReason: 'Kill switch engaged during retry cycle',
        });
        log.warn({ orderId: order.id }, 'Order REJECTED — kill switch engaged during retry');
        return order;
      }

      try {
        // ─── Requirement #3: Paper mode mirrors live ─────
        const result = this.paperMode
          ? await this._paperPlaceOrder(order)
          : await this._livePlaceOrder(order);

        // Transition: PENDING → PLACED
        transitionOrder(order, ORDER_STATE.PLACED, {
          brokerId: result.orderId,
        });

        // Transition: PLACED → FILLED
        // Paper mode fills instantly. Live mode: we optimistically fill here;
        // a future order-update WebSocket handler can correct if needed.
        transitionOrder(order, ORDER_STATE.FILLED);

        // C5: Increment position count in BOTH paper and live mode
        this.riskManager.addPosition();

        // H1: Track filled position to prevent duplicate BUY signals
        this._filledPositions.add(order.symbol);

        // C1: Write trade to database
        this._persistTrade(order).catch((err) =>
          log.error({ orderId: order.id, err: err.message }, 'Failed to persist trade to DB')
        );

        return order;
      } catch (err) {
        lastError = err;

        // ─── Requirement #4: Log broker rejection verbatim ──
        log.error({
          orderId: order.id,
          attempt,
          maxRetries: this.maxRetries,
          error: err.message,
          brokerResponse: err.response?.data || err.brokerResponse || null,
          statusCode: err.response?.status || err.statusCode || null,
          retryable: this._isRetryable(err),
        }, `Broker placement failed (attempt ${attempt}/${this.maxRetries}): ${err.message}`);

        // ─── Non-retryable = immediate REJECT ────────────
        if (!this._isRetryable(err)) {
          log.warn({
            orderId: order.id,
            error: err.message,
          }, 'Broker REJECTED order — not retrying (deterministic failure)');

          transitionOrder(order, ORDER_STATE.REJECTED, {
            rejectionReason: `Broker rejected: ${err.message}`,
          });
          return order;
        }

        if (attempt < this.maxRetries) {
          await this._delay(this.retryDelayMs * attempt); // Linear backoff
        }
      }
    }

    // All retries exhausted on transient errors — REJECTED
    transitionOrder(order, ORDER_STATE.REJECTED, {
      rejectionReason: `Broker unreachable after ${this.maxRetries} retries: ${lastError?.message}`,
    });

    return order;
  }

  /**
   * Classify whether a broker error is retryable.
   *
   * Retryable (transient):
   *   - Network: ECONNRESET, ECONNREFUSED, ETIMEDOUT, ENOTFOUND, EAI_AGAIN
   *   - HTTP 5xx (server errors)
   *   - Timeouts (response timeout, socket timeout)
   *
   * NOT retryable (deterministic):
   *   - HTTP 4xx (client errors: bad request, insufficient margin, invalid qty)
   *   - Explicit broker rejection messages
   *   - Missing broker instance
   *   - Any other programmatic error (TypeError, etc.)
   *
   * @private
   * @param {Error} err
   * @returns {boolean}
   */
  _isRetryable(err) {
    // Network-level errors (Node.js)
    const RETRYABLE_CODES = [
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
      'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
    ];

    if (err.code && RETRYABLE_CODES.includes(err.code)) {
      return true;
    }

    // HTTP status-based classification
    const status = err.response?.status || err.statusCode;
    if (status) {
      // 5xx = server error = retryable
      if (status >= 500) return true;
      // 4xx = client error = NOT retryable (bad request, forbidden, etc.)
      if (status >= 400 && status < 500) return false;
    }

    // Timeout patterns in error messages
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('network')) {
      return true;
    }

    // Everything else: NOT retryable (includes TypeError, missing broker, etc.)
    return false;
  }

  /**
   * Paper trading order placement.
   * Mirrors the broker interface but executes instantly.
   * @private
   */
  async _paperPlaceOrder(order) {
    log.info({
      orderId: order.id,
      symbol: order.symbol,
      side: order.side,
      qty: order.quantity,
      price: order.price,
      mode: 'PAPER',
    }, '[PAPER] Order placed');

    return {
      orderId: `PAPER-${order.id}`,
      status: 'COMPLETE',
      broker: 'paper',
    };
  }

  /**
   * Live trading order placement via the broker.
   * @private
   */
  async _livePlaceOrder(order) {
    if (!this.broker) {
      throw new Error('Live trading requires a broker instance');
    }

    const result = await this.broker.placeOrder({
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      price: order.price,
      product: order.product,
    });

    return result;
  }

  // ═══════════════════════════════════════════════════════
  // ORDER MANAGEMENT
  // ═══════════════════════════════════════════════════════

  /**
   * Cancel a pending or placed order.
   * @param {string} orderId
   * @returns {Object|null}
   */
  cancelOrder(orderId) {
    const order = this._orders.get(orderId);
    if (!order) return null;

    if (isTerminal(order)) {
      log.warn({ orderId, state: order.state }, 'Cannot cancel — order is terminal');
      return order;
    }

    transitionOrder(order, ORDER_STATE.CANCELLED);
    this._pendingSymbols.delete(order.symbol);
    return order;
  }

  /**
   * Get an order by ID.
   * @param {string} orderId
   * @returns {Object|null}
   */
  getOrder(orderId) {
    return this._orders.get(orderId) || null;
  }

  /**
   * Get all orders.
   * @returns {Object[]}
   */
  getAllOrders() {
    return Array.from(this._orders.values());
  }

  /**
   * Get active (non-terminal) orders.
   * @returns {Object[]}
   */
  getActiveOrders() {
    return this.getAllOrders().filter((o) => !isTerminal(o));
  }

  /**
   * Check if a symbol has a pending order (for external callers).
   * @param {string} symbol
   * @returns {boolean}
   */
  hasPendingOrder(symbol) {
    return this._pendingSymbols.has(symbol);
  }

  /**
   * Get engine status for monitoring.
   * @returns {Object}
   */
  getStatus() {
    const orders = this.getAllOrders();
    return {
      initialized: this._initialized,
      paperMode: this.paperMode,
      totalOrders: orders.length,
      pendingSymbols: Array.from(this._pendingSymbols),
      ordersByState: {
        pending: orders.filter((o) => o.state === ORDER_STATE.PENDING).length,
        placed: orders.filter((o) => o.state === ORDER_STATE.PLACED).length,
        filled: orders.filter((o) => o.state === ORDER_STATE.FILLED).length,
        rejected: orders.filter((o) => o.state === ORDER_STATE.REJECTED).length,
        cancelled: orders.filter((o) => o.state === ORDER_STATE.CANCELLED).length,
      },
      riskStatus: this.riskManager.getStatus(),
    };
  }

  /**
   * C1: Persist a filled trade to the database.
   * @private
   */
  async _persistTrade(order) {
    try {
      await query(
        `INSERT INTO trades (order_id, symbol, side, quantity, price, strategy, status, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         ON CONFLICT (order_id) DO NOTHING`,
        [order.id, order.symbol, order.side, order.quantity, order.price, order.strategy, order.state]
      );
      log.debug({ orderId: order.id, symbol: order.symbol }, 'Trade persisted to DB');
    } catch (err) {
      log.error({ orderId: order.id, err: err.message }, 'CRITICAL: Trade DB write failed');
    }
  }

  /**
   * Clear filled positions tracking (call at end of day for daily reset).
   */
  resetDaily() {
    this._filledPositions.clear();
    this._orders.clear();
    this._pendingSymbols.clear();
    log.info('Execution engine daily state reset');
  }

  /**
   * Remove a symbol from filled positions (e.g., after SELL closes position).
   * @param {string} symbol
   */
  markPositionClosed(symbol) {
    this._filledPositions.delete(symbol);
  }

  /**
   * Helper: async delay for retry backoff.
   * @private
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  /**
   * Persist all strategy signals + consensus to the signals DB table.
   * @private
   * @param {string} symbol
   * @param {Object} consensus - Result from SignalConsensus.evaluate()
   */
  async _persistSignals(symbol, consensus) {
    try {
      // 1. Write individual strategy signals
      for (const detail of (consensus.details || [])) {
        await query(
          `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [
            symbol,
            detail.strategy || 'unknown',
            detail.signal || 'HOLD',
            detail.confidence || 0,
            false,
            (detail.reason || '').slice(0, 500),
          ]
        );
      }

      // 2. Write consensus result
      await query(
        `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [
          symbol,
          'CONSENSUS',
          consensus.signal || 'HOLD',
          consensus.confidence || 0,
          false,
          (consensus.reason || '').slice(0, 500),
        ]
      );
    } catch (err) {
      log.error({ symbol, err: err.message }, 'Failed to persist signals to DB');
    }
  }

  /**
   * Mark the latest consensus signal for a symbol as acted on (trade filled).
   * @private
   * @param {string} symbol
   * @param {string} signal - BUY or SELL
   */
  async _markSignalActedOn(symbol, signal) {
    try {
      await query(
        `UPDATE signals SET acted_on = true
         WHERE symbol = $1 AND strategy = 'CONSENSUS' AND signal = $2
           AND created_at = (
             SELECT MAX(created_at) FROM signals
             WHERE symbol = $1 AND strategy = 'CONSENSUS' AND signal = $2
           )`,
        [symbol, signal]
      );
    } catch (err) {
      log.error({ symbol, err: err.message }, 'Failed to mark signal as acted on');
    }
  }
}
