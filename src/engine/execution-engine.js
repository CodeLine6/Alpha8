/**
 * @fileoverview Order Execution Engine for Alpha8
 *
 * CHANGES (Tier 1):
 *   Task 2 — _filledPositions converted from Set to Map. Stores BUY entry context
 *            (strategies, price, quantity, timestamp) so SELL fills can compute P&L
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
 *
 * BUG FIXES:
 *   Bug 1 — acted_on race condition: _persistSignals() is now awaited before order
 *            execution and returns the CONSENSUS signal row ID. _markSignalActedOn()
 *            uses that ID directly (no timestamp-based lookup race).
 *
 *   Bug 2 — SELL without BUY: Added hydratePositions() for startup DB hydration.
 *            Added SELL guard in executeOrder() — rejects if symbol not in _filledPositions.
 *
 *   Bug 3 — Counter drift: removePosition() is now called on SELL fills. hydratePositions()
 *            returns the hydrated count so the caller can sync the risk manager.
 */

import { createLogger } from '../lib/logger.js';
import { ORDER_STATE, MAX_ORDER_RETRIES, RETRY_DELAY_MS } from '../config/constants.js';
import { createOrder, transitionOrder, isTerminal } from './order-state-machine.js';
import { query } from '../lib/db.js';
import { ShadowRecorder } from '../intelligence/shadow-recorder.js';

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
   * @param {import('../intelligence/shadow-recorder.js').ShadowRecorder} [deps.shadowRecorder]
   * @param {import('../data/holdings.js').HoldingsManager} [deps.holdingsManager]
   * @param {import('../notifications/telegram-bot.js').TelegramBot} [deps.telegram]
   * @param {import('ioredis').Redis} [deps.redis] - For conflict alert rate limiting
   * @param {Object} [deps.config] - Validated env config (for position management parameters)
   */
  constructor(deps) {
    this.riskManager = deps.riskManager;
    this.killSwitch = deps.killSwitch;
    this.consensus = deps.consensus;
    this.pipeline = deps.pipeline || null;
    this.broker = deps.broker || null;
    this.shadowRecorder = deps.shadowRecorder || null;
    this.holdingsManager = deps.holdingsManager || null;
    this.telegram = deps.telegram || null;
    this.redis = deps.redis || null;
    this._config = deps.config || null;
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
     */
    this._lastSignalStrategies = new Map();

    /**
     * @type {Map<string, number>}
     * Bug Fix 1: Tracks the DB row ID of the most recently inserted CONSENSUS signal
     * per symbol. Used by _markSignalActedOn() to avoid the race condition where the
     * UPDATE ran before the INSERT committed (fire-and-forget timing issue).
     */
    this._pendingSignalIds = new Map();

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

  /**
   * Bug Fix 2: Hydrate _filledPositions from DB on startup.
   *
   * Queries the trades table for BUY orders placed today (IST) that have no
   * corresponding SELL. Reconstructs the in-memory position Map so the engine
   * has accurate state after a server restart or Render redeploy.
   *
   * MUST be awaited in src/index.js before scheduler.start() is called.
   * Throws if DB is unreachable — the caller must handle this and block startup.
   *
   * @returns {Promise<number>} Number of open positions hydrated
   */
  async hydratePositions() {
    log.info('Hydrating open positions from DB...');

    const isPaperMode = !this._config?.LIVE_TRADING;
    const result = await query(`
      SELECT symbol, price, quantity, strategy, created_at
      FROM (
        SELECT DISTINCT ON (symbol)
          symbol, side, price, quantity, strategy, created_at, id
        FROM trades
        WHERE status = 'FILLED'
          AND paper_mode = $1
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date =
              (NOW() AT TIME ZONE 'Asia/Kolkata')::date
        ORDER BY symbol, created_at DESC, id DESC
      ) AS latest_trades
      WHERE side = 'BUY'
    `, [isPaperMode]);

    this._filledPositions.clear();

    // Re-use the same stopPct/trailPct we'd use at fill time.
    // Hydrated positions are fully protected from the first scan after restart.
    const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
    const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;

    for (const row of result.rows) {
      const entryPrice = parseFloat(row.price);
      this._filledPositions.set(row.symbol, {
        strategies: [],                                         // not stored in trades table
        entryPrice,
        price: entryPrice,                                 // backward compat for SELL path
        quantity: parseInt(row.quantity, 10),
        timestamp: new Date(row.created_at).getTime(),
        stopPrice: entryPrice * (1 - stopPct / 100),
        highWaterMark: entryPrice,                                 // conservative — assume no gain yet
        trailStopPrice: entryPrice * (1 - trailPct / 100),
        trailPct,
        stopPct,
      });
    }

    const count = this._filledPositions.size;
    const symbols = Array.from(this._filledPositions.keys());

    log.info({ count, symbols },
      `✅ Position hydration complete — ${count} open position(s) restored from DB`);

    return count;
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
   *   2. _persistSignals is AWAITED and returns the CONSENSUS signal DB id (Bug Fix 1)
   *   3. Regime is fetched once (Task 3) and passed to pipeline.process()
   *   4. EnhancedSignalPipeline runs results through 4 gates with regime-adaptive threshold
   *   5. If all gates pass → RiskManager validates → ExecutionEngine places order
   *   6. _markSignalActedOn uses the stored signal ID — no race condition
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

    // Bug Fix 1: _persistSignals is now AWAITED (not fire-and-forget).
    // It returns the DB row ID of the CONSENSUS signal row, which we store
    // in _pendingSignalIds so _markSignalActedOn can use it directly —
    // eliminating the race where the UPDATE ran before the INSERT committed.
    const consensusSignalId = await this._persistSignals(symbol, consensusResult, currentPrice)
      .catch((err) => {
        log.error({ symbol, err: err.message }, 'Signal persistence failed');
        return null;
      });

    if (consensusSignalId) {
      this._pendingSignalIds.set(symbol, consensusSignalId);
    }

    // If no strategy fired anything (all HOLD), skip the pipeline entirely.
    // Still record shadow signals — strategies did run, their votes just cancelled out.
    if (consensusResult.signal === 'HOLD') {
      // Feature 9: Conflict detection — alert when strategies actively disagree
      if (consensusResult.isConflicted && this.telegram && this.redis) {
        this._alertConflict(symbol, consensusResult).catch(() => { });
      }

      if (this.shadowRecorder && (consensusResult.details?.length ?? 0) > 0) {
        this.shadowRecorder.recordSignals(
          symbol, consensusResult.details, consensusResult, false, currentPrice, null
        ).catch(err => log.warn({ symbol, err: err.message }, 'Shadow signal (HOLD) recording failed'));
      }
      return { action: 'HOLD', order: null, consensus: consensusResult };
    }

    // ── Step 2: Fetch current market regime (Task 3) ─────────────────────
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

      if (pipelineResult.signal) {
        finalSignal = { ...consensusResult, ...pipelineResult.signal };
      }
    }

    // ── Step 4: Execute ──────────────────────────────────────────────────
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
      // Bug Fix 1: Pass the stored signal ID — avoids the timestamp race condition.
      const signalId = this._pendingSignalIds.get(symbol);
      await this._markSignalActedOn(signalId, symbol, finalSignal.signal);
      this._pendingSignalIds.delete(symbol);
    }

    // Record shadow signals fire-and-forget — captures all strategy votes including
    // those that didn't reach consensus, enabling unbiased accuracy measurement.
    // Must never block or throw into the trading loop.
    if (this.shadowRecorder) {
      this.shadowRecorder.recordSignals(
        symbol,
        consensusResult.details || [],
        consensusResult,
        acted,
        currentPrice,
        regime,
      ).catch(err => log.warn({ symbol, err: err.message }, 'Shadow signal recording failed'));
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
   * Called internally after a confirmed SELL fill.
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
      await this.pipeline.recordTradeOutcome(strategy, 'BUY', symbol, pnl);

      if (this.pipeline.adaptiveWeights) {
        await this.pipeline.adaptiveWeights.recordOutcome({ strategy, signal: 'BUY', symbol, outcome, pnl });
      }
    }

    this._lastSignalStrategies.delete(symbol);
  }

  // ═══════════════════════════════════════════════════════
  // FORCE EXIT — Position manager bypass path
  // ═══════════════════════════════════════════════════════

  /**
   * Force-exit an open position, bypassing consensus and pipeline gates.
   * Used exclusively by PositionManager for stop loss, trailing stop, and time exits.
   *
   * Does NOT go through executeOrder() risk gate — it is an exit, not an entry,
   * and must never be blocked by position count or daily loss checks.
   *
   * Full state update still happens: _filledPositions, riskManager, DB trades table,
   * adaptive weight recording, signal acted_on mark.
   *
   * @param {string} symbol
   * @param {number} currentPrice - current market price for the exit
   * @param {string} reason - 'STOP_LOSS' | 'TRAILING_STOP' | 'TIME_EXIT'
   * @returns {Promise<{ success: boolean, pnl: number, order: Object | null }>}
   */
  async forceExit(symbol, currentPrice, reason) {
    const posCtx = this._filledPositions.get(symbol);
    if (!posCtx) {
      log.warn({ symbol, reason }, 'forceExit called but no position found — already closed?');
      return { success: false, pnl: 0, order: null };
    }

    const unrealisedPnL = (currentPrice - posCtx.entryPrice) * posCtx.quantity;

    log.warn({
      symbol,
      reason,
      entryPrice: posCtx.entryPrice,
      currentPrice,
      quantity: posCtx.quantity,
      unrealisedPnL: unrealisedPnL.toFixed(2),
    }, `🚨 Position manager forcing exit: ${symbol} — ${reason}`);

    // Place SELL order directly — bypass executeOrder() risk gate
    // but still go through the broker/paper path and state machine.
    const order = createOrder({
      symbol,
      side: 'SELL',
      quantity: posCtx.quantity,
      price: currentPrice,
      strategy: reason,  // recorded in trades table as the exit reason
    });

    this._orders.set(order.id, order);

    try {
      const result = this.paperMode
        ? await this._paperPlaceOrder(order)
        : await this._livePlaceOrder(order);

      transitionOrder(order, ORDER_STATE.PLACED, { brokerId: result.orderId });
      transitionOrder(order, ORDER_STATE.FILLED);

      const pnl = (currentPrice - posCtx.entryPrice) * posCtx.quantity;

      // Update all state — mirror what _placeWithRetry does on SELL fill
      this._filledPositions.delete(symbol);
      this.riskManager.removePosition();
      await this.riskManager.recordTradePnL(pnl, symbol);

      // Record outcome for adaptive weights — fire-and-forget
      this.recordPositionOutcome(symbol, pnl).catch(err =>
        log.warn({ symbol, err: err.message }, 'Outcome recording failed after force exit')
      );

      // Persist to trades table — fire-and-forget
      this._persistTrade(order).catch(err =>
        log.error({ symbol, err: err.message }, 'Trade persist failed after force exit')
      );

      // Mark signal acted on using stored ID (if present)
      const signalId = this._pendingSignalIds.get(symbol);
      if (signalId) {
        this._markSignalActedOn(signalId, symbol, 'SELL').catch(() => { });
        this._pendingSignalIds.delete(symbol);
      }

      log.info({
        symbol,
        reason,
        pnl: pnl.toFixed(2),
        entryPrice: posCtx.entryPrice,
        exitPrice: currentPrice,
        quantity: posCtx.quantity,
      }, `✅ Force exit complete: ${symbol} | PnL: ₹${pnl.toFixed(2)}`);

      return { success: true, pnl, order };

    } catch (err) {
      log.error({ symbol, reason, err: err.message }, 'Force exit FAILED — position may still be open');
      transitionOrder(order, ORDER_STATE.REJECTED, { rejectionReason: err.message });
      return { success: false, pnl: 0, order };
    }
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

    // Feature 5: Holdings awareness — block BUY if exposure exists in broker
    // (delivery holdings or intraday positions opened outside this engine).
    // Non-fatal on failure — a broken holdings check must never block a trade.
    if (params.side === 'BUY' && this.holdingsManager) {
      try {
        const existing = await this.holdingsManager.getExposure(params.symbol);
        if (existing && existing.quantity > 0) {
          transitionOrder(order, ORDER_STATE.REJECTED, {
            rejectionReason: `Holdings check: already hold ${existing.quantity} units of ${params.symbol} (source: ${existing.source})`,
          });
          log.warn({ symbol: params.symbol, existing, orderId: order.id },
            'BUY rejected — existing holding detected via HoldingsManager');
          return order;
        }
      } catch (err) {
        // Non-fatal — log and continue. Never block a trade on a holdings check failure.
        log.warn({ symbol: params.symbol, err: err.message },
          'Holdings check failed — proceeding without exposure check');
      }
    }

    // Bug Fix 2: SELL guard — reject if no open position exists after DB hydration.
    // Prevents phantom SELLs when the engine restarts and _filledPositions is empty.
    if (params.side === 'SELL' && !this._filledPositions.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `SELL rejected — no open position found for ${params.symbol} after DB hydration`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        `SELL rejected — no open position found for ${params.symbol} after DB hydration`);
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

        if (order.side === 'BUY') {
          // Track BUY context for P&L calculation on SELL and for position manager.
          // entryPrice is the canonical field for position manager calculations.
          // price is retained for backward compat — existing SELL path uses posCtx.price.
          const strategies = this._lastSignalStrategies.get(order.symbol) || [];
          const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
          const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;

          this._filledPositions.set(order.symbol, {
            strategies,
            entryPrice: order.price,
            price: order.price,                                  // backward compat
            quantity: order.quantity,
            timestamp: Date.now(),
            stopPrice: order.price * (1 - stopPct / 100),
            highWaterMark: order.price,
            trailStopPrice: order.price * (1 - trailPct / 100),
            trailPct,
            stopPct,
          });

          log.debug({
            symbol: order.symbol,
            entryPrice: order.price,
            stopPrice: +(order.price * (1 - stopPct / 100)).toFixed(2),
            trailStop: +(order.price * (1 - trailPct / 100)).toFixed(2),
            stopPct,
            trailPct,
          }, 'Position opened — stop/trail levels set');

          // Bug Fix 3: Sync position count to risk manager after map change
          this.riskManager.addPosition();

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

            this.recordPositionOutcome(order.symbol, pnl).catch((err) =>
              log.warn({ symbol: order.symbol, err: err.message },
                'Position outcome recording failed — adaptive weights not updated')
            );

            this._filledPositions.delete(order.symbol);
            // Bug Fix 3: Decrement position count on SELL fill
            this.riskManager.removePosition();
          }
        }

        this._persistTrade(order).catch((err) =>
          log.error({ orderId: order.id, err: err.message }, 'Failed to persist trade to DB')
        );

        return order;
      } catch (err) {
        lastError = err;

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

    // Task 4A: Fetch actual fill price post-placement. Non-fatal.
    try {
      const history = await this.broker.getOrderHistory(response.order_id);
      const fillPrice = history?.average_price
        || (Array.isArray(history) ? history[history.length - 1]?.average_price : null)
        || null;
      if (fillPrice && fillPrice > 0) {
        log.info({
          orderId: response.order_id,
          scanPrice: order.price,
          fillPrice,
        }, 'Fill price fetched — overwriting scan-time price with actual executed price');
        order.price = fillPrice;
      }
    } catch (err) {
      log.warn({ orderId: response.order_id, err: err.message },
        'Could not fetch fill price — using scan-time price');
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

  /** Bug Fix 3: Expose open position count derived from _filledPositions Map */
  getOpenPositionCount() { return this._filledPositions.size; }

  getStatus() {
    const orders = this.getAllOrders();
    return {
      initialized: this._initialized,
      paperMode: this.paperMode,
      pipelineEnabled: !!this.pipeline,
      totalOrders: orders.length,
      pendingSymbols: Array.from(this._pendingSymbols),
      openPositions: this._filledPositions.size,
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

  async reconcilePositions(broker) {
    if (this.paperMode || !broker) {
      log.debug('Skipping position reconciliation (Paper Mode or No Broker)');
      return { checked: 0, reconciled: 0, stillOpen: 0 };
    }

    if (this._filledPositions.size === 0) {
      return { reconciled: [], stillOpen: [...this._filledPositions.keys()] };
    }

    try {
      const heldSymbols = Array.from(this._filledPositions.keys());
      const ltpKeys = heldSymbols.map(s => `NSE:${s}`);
      const ltp = await broker.getLTP(ltpKeys);
      // A symbol is considered closed externally if getLTP returns null/0 for it
      // AND the broker's net positions don't contain it
      const rawPositions = await broker.getPositions();
      const brokerSymbols = new Set(
        (rawPositions?.net || rawPositions || [])
          .filter(p => (p.quantity || p.netQuantity || 0) !== 0)
          .map(p => p.tradingsymbol || p.tradingSymbol || p.symbol)
      );

      const reconciled = [];
      const stillOpen = [];

      // Format as YYYY-MM-DD in IST
      const formatter = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit' });
      const todayIST = formatter.format(new Date());

      for (const [symbol, posCtx] of this._filledPositions.entries()) {
        const posDateIST = formatter.format(new Date(posCtx.timestamp));
        if (posDateIST === todayIST && !brokerSymbols.has(symbol)) {
          log.warn(`Position reconciliation: ${symbol} closed externally — removing from engine state`);
          this.markPositionClosed(symbol);
          if (this.riskManager) {
            this.riskManager.removePosition();
          }
          if (this.telegram?.enabled) {
            this.telegram.sendRaw(
              `⚠️ <b>Position Closed Externally — ${symbol}</b>\n` +
              `Removed from engine state via reconciliation.\n` +
              `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
            ).catch(() => {});
          }
          reconciled.push(symbol);
        } else {
          stillOpen.push(symbol);
        }
      }

      log.info({
        checked: this._filledPositions.size + reconciled.length,
        reconciled: reconciled.length,
        stillOpen: stillOpen.length
      }, 'Position reconciliation complete');

      return { reconciled, stillOpen };
    } catch (err) {
      log.error({ err: err.message }, 'Reconciliation failed to fetch positions from broker');
      return { reconciled: [], stillOpen: [...this._filledPositions.keys()] };
    }
  }

  resetDaily() {
    this._filledPositions.clear();
    this._orders.clear();
    this._pendingSymbols.clear();
    this._lastSignalStrategies.clear();
    this._pendingSignalIds.clear();
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

  /**
   * Bug Fix 1: Now AWAITED in processSignal (not fire-and-forget).
   * Returns the DB row ID of the CONSENSUS signal row so _markSignalActedOn
   * can update by ID instead of by timestamp (eliminates the race condition).
   *
   * @private
   * @returns {Promise<number|null>} CONSENSUS signal row ID, or null on failure
   */
  async _persistSignals(symbol, consensus, currentPrice = null) {
    let consensusSignalId = null;

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
            currentPrice || null,
          ]
        );
      }

      // Insert CONSENSUS row and capture its ID
      const consensusRow = await query(
        `INSERT INTO signals (symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, NOW())
         RETURNING id`,
        [
          symbol,
          'CONSENSUS',
          consensus.signal || 'HOLD',
          consensus.confidence || 0,
          false,
          (consensus.reason || '').slice(0, 500),
          currentPrice || null,
        ]
      );

      consensusSignalId = consensusRow.rows?.[0]?.id ?? null;
    } catch (err) {
      log.error({ symbol, err: err.message }, 'Failed to persist signals to DB');
    }

    return consensusSignalId;
  }

  /**
   * Bug Fix 1: Uses signal row ID directly — no timestamp-based lookup race.
   * Falls back to timestamp query if ID is unavailable (e.g. persist failed).
   *
   * @private
   * @param {number|null} signalId - DB row ID from _persistSignals
   * @param {string} symbol - For fallback query and error logging
   * @param {string} signal - 'BUY' or 'SELL' — for fallback query only
   */
  async _markSignalActedOn(signalId, symbol, signal) {
    try {
      if (signalId) {
        // Fast path: use the ID we captured at insert time — no race condition
        const result = await query(
          `UPDATE signals SET acted_on = true WHERE id = $1`,
          [signalId]
        );
        if (result.rowCount === 0) {
          log.error({ signalId, symbol }, 'Failed to mark signal acted_on — row not found by ID');
        } else {
          log.debug({ signalId, symbol }, 'Signal marked acted_on by ID');
        }
      } else {
        // Fallback: timestamp-based lookup (less reliable, kept for safety)
        log.warn({ symbol, signal }, 'No signal ID available — falling back to timestamp lookup');
        const result = await query(
          `UPDATE signals SET acted_on = true
           WHERE symbol = $1 AND strategy = 'CONSENSUS' AND signal = $2
             AND created_at = (
               SELECT MAX(created_at) FROM signals
               WHERE symbol = $1 AND strategy = 'CONSENSUS' AND signal = $2
             )`,
          [symbol, signal]
        );
        if (result.rowCount === 0) {
          log.error({ symbol, signal }, 'Fallback: failed to mark signal acted_on — no matching row found');
        }
      }
    } catch (err) {
      log.error({ signalId, symbol, err: err.message },
        `CRITICAL: Failed to mark signal as acted_on — manual reconciliation needed (signalId=${signalId})`);
    }
  }

  /**
   * Feature 9: Send a Telegram conflict alert when BUY and SELL strategies cancel exactly.
   * Rate-limited per symbol to one alert per 30 minutes via Redis.
   * Fire-and-forget — caller uses .catch(() => {}).
   *
   * @private
   * @param {string} symbol
   * @param {Object} consensusResult - from SignalConsensus.evaluate()
   */
  async _alertConflict(symbol, consensusResult) {
    const rateLimitKey = `conflict:alerted:${symbol}`;
    try {
      const alreadyAlerted = await this.redis.get(rateLimitKey);
      if (alreadyAlerted) return;

      await this.redis.setex(rateLimitKey, 1800, '1');

      const { buyStrategies, sellStrategies } = consensusResult.conflictDetails;
      const msg =
        `⚡ <b>Signal Conflict — ${symbol}</b>\n\n` +
        `📈 BUY: ${buyStrategies.join(', ')}\n` +
        `📉 SELL: ${sellStrategies.join(', ')}\n\n` +
        `Result: HOLD (strategies cancel out)\n` +
        `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

      await this.telegram.sendRaw(msg);
      log.info({ symbol, buyStrategies, sellStrategies }, 'Conflict alert sent via Telegram');
    } catch (err) {
      log.warn({ symbol, err: err.message }, 'Conflict alert failed — continuing');
    }
  }
}
