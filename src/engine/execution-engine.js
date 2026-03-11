/**
 * @fileoverview Order Execution Engine for Quant8
 *
 * CHANGES (Tier 1):
 *   Task 2 — _filledPositions converted from Set to Map. Stores BUY entry context
 *            (strategies, price, quantity, timestamp) so SELL fills can compute P\u0026L
 *            and feed data to the adaptive weight system via recordPositionOutcome().
 *
 *   Task 3 — Before calling pipeline.process(), fetches the current market regime
 *            via pipeline.regimeDetector.getRegime() (one call per scan cycle).
 *            The regime string is passed to process() so the pipeline can set the
 *            correct weighted consensus threshold without double-detecting regime.
 *
 *   Task 4A — _livePlaceOrder() fetches post-fill order history via getOrderHistory()
 *             to overwrite scan-time price with the actual executed price. Non-fatal.
 *
 *   Task 4B — _persistSignals() accepts currentPrice as 3rd param and inserts it
 *             into both per-strategy and CONSENSUS signal rows.
 */

import { createLogger } from '../lib/logger.js';
import { ORDER_STATE, MAX_ORDER_RETRIES, RETRY_DELAY_MS } from '../config/constants.js';
import { createOrder, transitionOrder, isTerminal } from './order-state-machine.js';
import { query } from '../lib/db.js';

const log = createLogger('execution-engine');


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
    this.pipeline = deps.pipeline || null;   // ← enhanced pipeline (optional)
    this.broker = deps.broker || null;
    this.paperMode = deps.paperMode ?? true;
    this.maxRetries = deps.maxRetries ?? MAX_ORDER_RETRIES;
    this.retryDelayMs = deps.retryDelayMs ?? RETRY_DELAY_MS;

    /** @type {Map<string, Object>} Active orders by ID */
    this._orders = new Map();

    /** @type {Set<string>} Symbols with PENDING orders (duplicate guard) */
    this._pendingSymbols = new Set();

    /**
     * BUY context for open positions — keyed by symbol.
     * Converted from Set to Map (Task 2) to store the entry data needed to
     * compute P&L when a SELL fill is later confirmed.
     *
     * @type {Map<string, { strategies: string[], price: number, quantity: number, timestamp: number }>}
     */
    this._filledPositions = new Map();

    /**
     * @type {Map<string, string[]>}
     * Tracks which strategy names fired for each symbol's last BUY.
     * Kept for backward-compat. Primary usage now via _filledPositions map.
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
   *   2. Regime is fetched once (Task 3) and passed to pipeline.process()
   *   3. EnhancedSignalPipeline runs results through 4 gates with regime-adaptive threshold
   *   4. If all gates pass → RiskManager validates → ExecutionEngine places order
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

    // Persist all individual strategy signals to DB (fire-and-forget).
    // Task 4B: currentPrice is now passed so the signals table price column is populated.
    this._persistSignals(symbol, consensusResult, currentPrice).catch((err) =>
      log.error({ symbol, err: err.message }, 'Signal persistence failed')
    );

    // If no strategy fired anything (all HOLD), skip the pipeline entirely
    if (consensusResult.signal === 'HOLD') {
      return { action: 'HOLD', order: null, consensus: consensusResult };
    }

    // ── Step 2: Fetch current market regime (Task 3) ─────────────────────
    // Fetched here (once per scan cycle) so the pipeline does not call getRegime()
    // twice per symbol. Both the positionSizeMult gate and the threshold gate share
    // the same value. Wrapped in try/catch — regime failure must never crash the loop.
    let regime = null;
    if (this.pipeline?.regimeDetector) {
      try {
        const regimeState = await this.pipeline.regimeDetector.getRegime();
        regime = regimeState?.regime ?? null;
      } catch (err) {
        log.warn({ symbol, err: err.message },
          'Could not fetch regime — pipeline will use default threshold (2.0)');
      }
    }

    // ── Step 3: Run through enhanced pipeline (4 gates) ──────────────────
    let finalSignal = consensusResult;
    let adjustedQuantity = quantity;
    let pipelineLog = null;

    if (this.pipeline) {
      // Pass raw strategy-level results (details) and current regime.
      // The pipeline uses regime to set the weighted consensus threshold:
      //   TRENDING=1.8 | SIDEWAYS=2.0 | VOLATILE=2.5 | null=2.0 (default)
      const pipelineResult = await this.pipeline.process(symbol, consensusResult.details || [], regime);
      pipelineLog = pipelineResult.log;

      if (!pipelineResult.allowed) {
        log.info({
          symbol,
          regime,
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

    // ── Step 4: Execute ──────────────────────────────────────────────────
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
   *
   * Called internally after a confirmed SELL fill (Task 2).
   * Also callable externally from the scheduler for manual square-off scenarios.
   * Feeds data to AdaptiveWeightManager for weekly weight recalibration.
   *
   * @param {string} symbol
   * @param {number} pnl  - positive = profit, negative = loss
   */
  async recordPositionOutcome(symbol, pnl) {
    if (!this.pipeline) {
      log.warn({ symbol }, 'recordPositionOutcome: pipeline not available — skipping outcome recording');
      return;
    }

    const strategies = this._lastSignalStrategies.get(symbol) || [];
    if (strategies.length === 0) {
      log.warn({ symbol }, 'recordPositionOutcome: no BUY strategies on record for symbol');
      return;
    }

    const outcome = pnl >= 0 ? 'WIN' : 'LOSS';
    log.info({ symbol, pnl, outcome, strategies }, 'Recording position outcome for adaptive weights');

    for (const strategy of strategies) {
      // Lightweight wrapper that calls adaptiveWeights.recordOutcome internally
      await this.pipeline.recordTradeOutcome(strategy, 'BUY', symbol, pnl);

      // Also call recordOutcome directly for guaranteed DB persistence
      if (this.pipeline.adaptiveWeights) {
        await this.pipeline.adaptiveWeights.recordOutcome({ strategy, signal: 'BUY', symbol, outcome, pnl });
      }
    }

    this._lastSignalStrategies.delete(symbol);
  }

  /**
   * Duplicate filled-position guard (BUY only).
   * Uses Map.has() — compatible with the new Map type for _filledPositions.
   */
  // NOTE: This is not a separate method — the check is inline in executeOrder below.

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

    // H1: Duplicate filled position guard (BUY only) — Map.has() works same as Set.has()
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

        // Task 2: Store BUY context in Map so we can compute P&L on SELL.
        // For SELL fills, record the outcome and clean up.
        if (order.side === 'BUY') {
          const strategies = this._lastSignalStrategies.get(order.symbol) || [];
          this._filledPositions.set(order.symbol, {
            strategies,
            price: order.price,       // entry price (actual fill price if live, scan-time for paper)
            quantity: order.quantity,
            timestamp: Date.now(),
          });
        } else if (order.side === 'SELL') {
          const posCtx = this._filledPositions.get(order.symbol);
          if (posCtx) {
            const sellPrice = order.price;
            const pnl = (sellPrice - posCtx.price) * posCtx.quantity;
            log.info({
              symbol: order.symbol,
              entryPrice: posCtx.price,
              sellPrice,
              quantity: posCtx.quantity,
              pnl,
            }, 'SELL filled — recording position outcome');

            // Fire-and-forget: outcome recording is non-critical
            this.recordPositionOutcome(order.symbol, pnl).catch((err) =>
              log.warn({ symbol: order.symbol, err: err.message },
                'Position outcome recording failed — adaptive weights not updated')
            );

            this._filledPositions.delete(order.symbol);
          }
        } else {
          // Any other side (shouldn't happen), just mark filled
          this._filledPositions.set(order.symbol, {
            strategies: [],
            price: order.price,
            quantity: order.quantity,
            timestamp: Date.now(),
          });
        }

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

    const response = await this.broker.placeOrder({
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      price: order.price,
      product: order.product,
    });

    // Task 4A: Fetch actual fill price from broker post-placement.
    // Kite MARKET orders return only { order_id } at placement time.
    // The real execution price is only available after the order reaches COMPLETE status.
    // Non-fatal: if this fails, the scan-time price already set on order.price is kept.
    try {
      const history = await this.broker.getOrderHistory(response.order_id);
      // History is an array of status updates; last entry has the final state.
      // average_price is the actual fill price for MARKET orders.
      const fillPrice = history?.average_price
        || (Array.isArray(history) ? history[history.length - 1]?.average_price : null)
        || null;
      if (fillPrice && fillPrice > 0) {
        log.info({
          orderId: response.order_id,
          scanPrice: order.price,
          fillPrice,
        }, 'Fill price fetched — overwriting scan-time price with actual executed price');
        order.price = fillPrice;  // overwrite with actual executed price
      }
    } catch (err) {
      log.warn({ orderId: response.order_id, err: err.message },
        'Could not fetch fill price — using scan-time price');
      // Non-fatal: order.price remains as scan-time price
    }

    return { orderId: response.order_id };
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
  async _persistSignals(symbol, consensus, currentPrice = null) {
    try {
      for (const detail of (consensus.details || [])) {
        await query(
          `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
          [
            symbol,
            detail.strategy || 'unknown',
            detail.signal || 'HOLD',
            detail.confidence || 0,
            false,
            (detail.reason || '').slice(0, 500),
            currentPrice || null,  // Task 4B: populate price column
          ]
        );
      }
      await query(
        `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())`,
        [
          symbol,
          'CONSENSUS',
          consensus.signal || 'HOLD',
          consensus.confidence || 0,
          false,
          (consensus.reason || '').slice(0, 500),
          currentPrice || null,  // Task 4B: populate price column
        ]
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