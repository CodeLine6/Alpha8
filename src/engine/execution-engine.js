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
 * UPGRADED: Now accepts an optional `pipeline` (EnhancedSignalPipeline).
 *   When provided, the raw strategy signals from consensus pass through
 *   4 additional gates before the risk manager:
 *     - Adaptive weighted consensus (trust-weighted strategy votes)
 *     - Trend filter (SMA20 + SMA50)
 *     - Regime detector (market weather)
 *     - News sentiment (Claude API)
 *
 * @module execution-engine
 */

export class ExecutionEngine {
  /**
   * @param {Object} deps
   * @param {import('../risk/risk-manager.js').RiskManager}         deps.riskManager
   * @param {import('../risk/kill-switch.js').KillSwitch}           deps.killSwitch
   * @param {import('./signal-consensus.js').SignalConsensus}        deps.consensus
   * @param {import('../intelligence/enhanced-pipeline.js').EnhancedSignalPipeline} [deps.pipeline]
   * @param {Object}  [deps.broker] - BrokerManager (null in paper mode)
   * @param {boolean} [deps.paperMode=true]
   * @param {number}  [deps.maxRetries]
   * @param {number}  [deps.retryDelayMs]
   */
  constructor(deps) {
    this.riskManager = deps.riskManager;
    this.killSwitch = deps.killSwitch;
    this.consensus = deps.consensus;
    this.pipeline = deps.pipeline || null;   // ← NEW: enhanced pipeline (optional)
    this.broker = deps.broker || null;
    this.paperMode = deps.paperMode ?? true;
    this.maxRetries = deps.maxRetries ?? MAX_ORDER_RETRIES;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;

    /** @type {Map<string, Object>} Active orders by ID */
    this._orders = new Map();

    /** @type {Set<string>} Symbols with PENDING orders (duplicate guard) */
    this._pendingSymbols = new Set();

    /** @type {Set<string>} Symbols with FILLED positions today */
    this._filledPositions = new Set();

    /**
     * @type {Map<string, string[]>}
     * Tracks which strategy names fired for each symbol's last BUY.
     * Used by recordPositionOutcome() to attribute outcomes to strategies.
     */
    this._lastSignalStrategies = new Map();

    /** @type {boolean} */
    this._initialized = false;

    log.info({
      paperMode: this.paperMode,
      maxRetries: this.maxRetries,
      strategies: this.consensus.strategies.length,
      pipelineEnabled: !!this.pipeline,
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

    const integrity = await this.killSwitch.verifyIntegrity();

    if (this.killSwitch.isEngaged()) {
      log.error({ integrity, killSwitchStatus: this.killSwitch.getStatus() },
        'Engine startup BLOCKED — kill switch is engaged');
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
   * Process candle data through the consensus + pipeline layers and execute.
   * Main entry point called by the scheduler every 5 minutes.
   *
   * Flow:
   *   1. SignalConsensus runs all 4 strategies on today's candles
   *   2. EnhancedSignalPipeline runs the results through 4 additional gates
   *   3. If all gates pass → RiskManager validates → ExecutionEngine places order
   *
   * @param {string}   symbol
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @param {number}   currentPrice
   * @param {number}   quantity
   * @returns {Promise<{ action: string, order: Object|null, consensus: Object, pipelineLog?: string[] }>}
   */
  async processSignal(symbol, candles, currentPrice, quantity) {
    if (!this._initialized) {
      return { action: 'ENGINE_NOT_INITIALIZED', order: null, consensus: null };
    }

    // ── Step 1: Run all strategies via existing consensus layer ──────────
    const consensusResult = this.consensus.evaluate(candles);

    // Persist all individual strategy signals to DB (fire-and-forget)
    this._persistSignals(symbol, consensusResult).catch((err) =>
      log.error({ symbol, err: err.message }, 'Signal persistence failed')
    );

    // If no strategy fired anything (all HOLD), skip the pipeline entirely
    if (consensusResult.signal === 'HOLD') {
      return { action: 'HOLD', order: null, consensus: consensusResult };
    }

    // ── Step 2: Run through enhanced pipeline (4 gates) ─────────────────
    let finalSignal = consensusResult;
    let adjustedQuantity = quantity;
    let pipelineLog = null;

    if (this.pipeline) {
      // Pass raw strategy-level results (details) to the pipeline.
      // The pipeline re-evaluates them with adaptive weights as Gate 1.
      const pipelineResult = await this.pipeline.process(symbol, consensusResult.details || []);
      pipelineLog = pipelineResult.log;

      if (!pipelineResult.allowed) {
        log.info({
          symbol,
          blockedBy: pipelineResult.blockedBy,
          pipelineLog: pipelineResult.log,
        }, `Signal BLOCKED by pipeline gate: ${pipelineResult.blockedBy}`);

        return {
          action: `BLOCKED:${pipelineResult.blockedBy}`,
          order: null,
          consensus: consensusResult,
          pipelineLog: pipelineResult.log,
        };
      }

      // Apply regime detector's position size multiplier
      if (pipelineResult.positionSizeMult < 1.0) {
        const original = adjustedQuantity;
        adjustedQuantity = Math.max(1, Math.floor(quantity * pipelineResult.positionSizeMult));
        log.info({
          symbol,
          originalQty: original,
          adjustedQty: adjustedQuantity,
          multiplier: pipelineResult.positionSizeMult,
        }, 'Position size reduced by regime detector');
      }

      // Use pipeline's final signal (may have news-based confidence boost)
      if (pipelineResult.signal) {
        finalSignal = { ...consensusResult, ...pipelineResult.signal };
      }
    }

    // ── Step 3: Execute ─────────────────────────────────────────────────
    // Track which strategies fired this BUY (for outcome attribution later)
    if (finalSignal.signal === 'BUY') {
      const firingStrategies = (consensusResult.details || [])
        .filter(d => d.signal === 'BUY')
        .map(d => d.strategy)
        .filter(Boolean);
      this._lastSignalStrategies.set(symbol, firingStrategies);
    }

    const order = await this.executeOrder({
      symbol,
      side: finalSignal.signal,
      quantity: adjustedQuantity,
      price: currentPrice,
      strategy: finalSignal.reason || consensusResult.reason,
    });

    const acted = order.state === ORDER_STATE.FILLED;

    if (acted) {
      this._markSignalActedOn(symbol, finalSignal.signal).catch(() => { });
    }

    return {
      action: acted ? 'EXECUTED' : order.state,
      order,
      consensus: consensusResult,
      pipelineLog,
    };
  }

  // ═══════════════════════════════════════════════════════
  // POSITION OUTCOME RECORDING (for adaptive weights)
  // ═══════════════════════════════════════════════════════

  /**
   * Record the outcome of a closed position.
   * Call this when a SELL fills and you know the P&L.
   * Feeds data to the adaptive weight system for weekly recalibration.
   *
   * @param {string} symbol
   * @param {number} pnl  - positive = profit, negative = loss
   */
  async recordPositionOutcome(symbol, pnl) {
    if (!this.pipeline) return;

    const strategies = this._lastSignalStrategies.get(symbol) || [];
    if (strategies.length === 0) return;

    for (const strategy of strategies) {
      await this.pipeline.recordTradeOutcome(strategy, 'BUY', symbol, pnl);
    }

    this._lastSignalStrategies.delete(symbol);
  }

  // ═══════════════════════════════════════════════════════
  // ORDER EXECUTION — The core loop
  // ═══════════════════════════════════════════════════════

  /**
   * Execute an order through the full pipeline:
   * Risk gate → Duplicate check → State machine → Broker (with retries)
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
   * @returns {Promise<Object>}
   */
  async executeOrder(params) {
    const order = createOrder(params);
    this._orders.set(order.id, order);

    // Requirement #5: Duplicate pending guard
    if (this._pendingSymbols.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Duplicate: existing PENDING order for ${params.symbol}`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        'Order REJECTED — duplicate PENDING order for symbol');
      return order;
    }

    // H1: Duplicate filled position guard (BUY only)
    if (params.side === 'BUY' && this._filledPositions.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Already holding position in ${params.symbol}`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        'Order REJECTED — already holding position for symbol');
      return order;
    }

    // Requirement #1: Risk gate
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
      log.warn({ orderId: order.id, symbol: params.symbol, riskReason: riskDecision.reason },
        'Order REJECTED by risk manager');
      return order;
    }

    this._pendingSymbols.add(params.symbol);

    try {
      return await this._placeWithRetry(order);
    } finally {
      this._pendingSymbols.delete(params.symbol);
    }
  }

  /**
   * Place order with retry logic.
   * Only retries transient/network errors — not deterministic broker rejections.
   * @private
   */
  async _placeWithRetry(order) {
    let lastError = null;

    for (let attempt = 1; attempt <= this.maxRetries; attempt++) {
      if (this.killSwitch.isEngaged()) {
        transitionOrder(order, ORDER_STATE.REJECTED, {
          rejectionReason: 'Kill switch engaged during retry cycle',
        });
        log.warn({ orderId: order.id }, 'Order REJECTED — kill switch engaged during retry');
        return order;
      }

      try {
        const result = this.paperMode
          ? await this._paperPlaceOrder(order)
          : await this._livePlaceOrder(order);

        transitionOrder(order, ORDER_STATE.PLACED, { brokerId: result.orderId });
        transitionOrder(order, ORDER_STATE.FILLED);

        this.riskManager.addPosition();
        this._filledPositions.add(order.symbol);

        this._persistTrade(order).catch((err) =>
          log.error({ orderId: order.id, err: err.message }, 'Failed to persist trade to DB')
        );

        return order;
      } catch (err) {
        lastError = err;

        // Requirement #4: Log broker rejection verbatim
        log.error({
          orderId: order.id,
          attempt,
          maxRetries: this.maxRetries,
          error: err.message,
          brokerResponse: err.response?.data || err.brokerResponse || null,
          statusCode: err.response?.status || err.statusCode || null,
          retryable: this._isRetryable(err),
        }, `Broker placement failed (attempt ${attempt}/${this.maxRetries}): ${err.message}`);

        if (!this._isRetryable(err)) {
          log.warn({ orderId: order.id, error: err.message },
            'Broker REJECTED order — not retrying (deterministic failure)');
          transitionOrder(order, ORDER_STATE.REJECTED, {
            rejectionReason: `Broker rejected: ${err.message}`,
          });
          return order;
        }

        if (attempt < this.maxRetries) {
          await this._delay(this.retryDelayMs * attempt);
        }
      }
    }

    transitionOrder(order, ORDER_STATE.REJECTED, {
      rejectionReason: `Broker unreachable after ${this.maxRetries} retries: ${lastError?.message}`,
    });
    return order;
  }

  /** @private */
  _isRetryable(err) {
    const RETRYABLE_CODES = [
      'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT',
      'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH',
    ];
    if (err.code && RETRYABLE_CODES.includes(err.code)) return true;
    const status = err.response?.status || err.statusCode;
    if (status) {
      if (status >= 500) return true;
      if (status >= 400 && status < 500) return false;
    }
    const msg = (err.message || '').toLowerCase();
    if (msg.includes('timeout') || msg.includes('timed out') || msg.includes('network')) return true;
    return false;
  }

  /** @private */
  async _paperPlaceOrder(order) {
    log.info({
      orderId: order.id, symbol: order.symbol,
      side: order.side, qty: order.quantity, price: order.price, mode: 'PAPER',
    }, '[PAPER] Order placed');
    return { orderId: `PAPER-${order.id}`, status: 'COMPLETE', broker: 'paper' };
  }

  /** @private */
  async _livePlaceOrder(order) {
    if (!this.broker) throw new Error('Live trading requires a broker instance');
    return this.broker.placeOrder({
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      price: order.price,
      product: order.product,
    });
  }

  // ═══════════════════════════════════════════════════════
  // ORDER MANAGEMENT
  // ═══════════════════════════════════════════════════════

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

  getOrder(orderId) { return this._orders.get(orderId) || null; }
  getAllOrders() { return Array.from(this._orders.values()); }
  getActiveOrders() { return this.getAllOrders().filter((o) => !isTerminal(o)); }
  hasPendingOrder(sym) { return this._pendingSymbols.has(sym); }

  getStatus() {
    const orders = this.getAllOrders();
    return {
      initialized: this._initialized,
      paperMode: this.paperMode,
      pipelineEnabled: !!this.pipeline,
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

  resetDaily() {
    this._filledPositions.clear();
    this._orders.clear();
    this._pendingSymbols.clear();
    this._lastSignalStrategies.clear();
    log.info('Execution engine daily state reset');
  }

  markPositionClosed(symbol) {
    this._filledPositions.delete(symbol);
  }

  /** @private */
  _delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /** @private */
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

  /** @private */
  async _persistSignals(symbol, consensus) {
    try {
      for (const detail of (consensus.details || [])) {
        await query(
          `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
          [symbol, detail.strategy || 'unknown', detail.signal || 'HOLD',
            detail.confidence || 0, false, (detail.reason || '').slice(0, 500)]
        );
      }
      await query(
        `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, NOW())`,
        [symbol, 'CONSENSUS', consensus.signal || 'HOLD',
          consensus.confidence || 0, false, (consensus.reason || '').slice(0, 500)]
      );
    } catch (err) {
      log.error({ symbol, err: err.message }, 'Failed to persist signals to DB');
    }
  }

  /** @private */
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