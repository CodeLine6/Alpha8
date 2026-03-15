/**
 * @fileoverview Order Execution Engine for Alpha8
 *
 * ORIGINAL CHANGES (Tier 1):
 *   Task 2 — _filledPositions converted from Set to Map.
 *   Task 3 — Regime fetched once per scan cycle and passed to pipeline.process().
 *   Task 4A — _livePlaceOrder() fetches post-fill price via getOrderHistory().
 *   Task 4B — _persistSignals() inserts currentPrice into signal rows.
 *
 * BUG FIXES (original):
 *   Bug 1 — acted_on race condition fixed via stored signal ID.
 *   Bug 2 — SELL guard + hydratePositions() for startup DB hydration.
 *   Bug 3 — removePosition() called on SELL fills; hydratePositions() returns count.
 *
 * PATCHES APPLIED THIS SESSION:
 *
 *   Patch 1 — hydratePositions() SQL fixed
 *     paper_mode = $1 parameterised (was string interpolation, now correct — it was
 *     already parameterised in the original but retained here for clarity).
 *
 *   Patch 2 — forceExit() supports partial qty
 *     Optional qty parameter added. Only removes from _filledPositions and calls
 *     removePosition() / recordPositionOutcome() on FULL exits (qty === null or
 *     qty >= posCtx.quantity). Partial exits update posCtx.quantity in place.
 *
 *   Patch 3 — openingStrategy stored on posCtx at BUY fill time
 *     Required by signal reversal exit strategy — PositionManager checks
 *     posCtx.openingStrategy to know which strategy to watch for reversal.
 *
 *   Patch 4 — positionManager.initPosition() called after BUY fill
 *     Sets all exit levels (stop, profit target, trail, partial, reversal) from
 *     exit-strategies.js immediately after a BUY is confirmed. Falls back to
 *     config-based stop/trail if initPosition fails or positionManager not set.
 *     Requires positionManager to be injected via engine.positionManager = pm
 *     after construction (avoids circular dependency).
 *
 *   Patch 5 — _pendingSignalIds cleared in resetDaily()
 *     Already present in original — confirmed retained.
 *
 *   Patch 6 — _fetchCandles injected for ATR-based trail stop in initPosition
 *     positionManager.initPosition() needs recent OHLCV candles to compute ATR.
 *     engine._fetchCandles = async (symbol, limit) => Candle[] injected from index.js.
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
   * @param {import('ioredis').Redis} [deps.redis]
   * @param {Object} [deps.config]
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

    /**
     * Patch 4: Injected from index.js after construction to avoid circular dep.
     * engine.positionManager = positionManager;
     * @type {import('../risk/position-manager.js').PositionManager|null}
     */
    this.positionManager = null;

    /**
     * Patch 6: Injected from index.js for ATR calculation in initPosition.
     * engine._fetchCandles = async (symbol, limit) => Candle[]
     * @type {Function|null}
     */
    this._fetchCandles = null;

    /** @type {Map<string, Object>} Active orders by ID */
    this._orders = new Map();

    /** @type {Set<string>} Symbols with PENDING orders (duplicate guard) */
    this._pendingSymbols = new Set();

    /**
     * BUY context for open positions — keyed by symbol.
     * @type {Map<string, Object>}
     */
    this._filledPositions = new Map();

    /**
     * @type {Map<string, string[]>}
     * Tracks which strategy names fired for each symbol's last BUY.
     */
    this._lastSignalStrategies = new Map();

    /**
     * Bug Fix 1: Tracks the DB row ID of the most recently inserted CONSENSUS signal.
     * @type {Map<string, number>}
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
   * Hydrate _filledPositions from DB on startup/restart.
   * Uses parameterised query (Patch 1 — already correct in original).
   *
   * Patch 3: posCtx now includes openingStrategy field.
   * Note: exit levels (profitTargetPrice, partialExitEnabled, etc.) are set
   * conservatively from config since initPosition() was not called at original
   * entry time. Partial exit is disabled for hydrated positions.
   */
  async hydratePositions() {
    log.info('Hydrating open positions from DB...');

    const isPaperMode = !this._config?.LIVE_TRADING;

    const result = await query(
      `SELECT symbol, price, quantity, strategy, created_at
       FROM (
         SELECT DISTINCT ON (symbol)
           symbol, side, price, quantity, strategy, created_at, id
         FROM trades
         WHERE status     = 'FILLED'
           AND paper_mode = $1
           AND (created_at AT TIME ZONE 'Asia/Kolkata')::date =
               (NOW()      AT TIME ZONE 'Asia/Kolkata')::date
         ORDER BY symbol, created_at DESC, id DESC
       ) AS latest_trades
       WHERE side = 'BUY'`,
      [isPaperMode]
    );

    this._filledPositions.clear();

    const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
    const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;
    const targetPct = this._config?.PROFIT_TARGET_PCT ?? 1.8;

    for (const row of result.rows) {
      const entryPrice = parseFloat(row.price);

      this._filledPositions.set(row.symbol, {
        strategies: [],
        // Patch 3: store opening strategy for signal reversal
        openingStrategy: row.strategy || 'UNKNOWN',
        entryPrice,
        price: entryPrice,              // backward compat
        quantity: parseInt(row.quantity, 10),
        timestamp: new Date(row.created_at).getTime(),

        // Stop / trail — from config (conservative fallback)
        stopPrice: entryPrice * (1 - stopPct / 100),
        highWaterMark: entryPrice,
        trailStopPrice: entryPrice * (1 - trailPct / 100),
        trailPct,
        stopPct,

        // Profit target — fixed % from config (hydration only)
        profitTargetPrice: entryPrice * (1 + targetPct / 100),
        profitTargetMode: 'FIXED_PCT',

        // Partial exit disabled for hydrated positions (original qty unknown)
        partialExitEnabled: false,
        partialExitDone: true,

        // Signal reversal enabled if configured
        signalReversalEnabled: this._config?.SIGNAL_REVERSAL_ENABLED ?? true,

        hydratedFromDB: true,
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

  async processSignal(symbol, candles, currentPrice, quantity) {
    if (!this._initialized) {
      return { action: 'ENGINE_NOT_INITIALIZED', order: null, consensus: null };
    }

    // Step 1: Run all strategies via consensus layer
    const consensusResult = this.consensus.evaluate(candles);

    // Bug Fix 1: Await _persistSignals, capture consensus signal ID
    const consensusSignalId = await this._persistSignals(symbol, consensusResult, currentPrice)
      .catch((err) => {
        log.error({ symbol, err: err.message }, 'Signal persistence failed');
        return null;
      });

    if (consensusSignalId) {
      this._pendingSignalIds.set(symbol, consensusSignalId);
    }

    if (consensusResult.signal === 'HOLD') {
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

    // Step 2: Fetch current market regime (Task 3)
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

    // Step 3: Run through enhanced pipeline (4 gates)
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

    // Step 4: Execute
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
      const signalId = this._pendingSignalIds.get(symbol);
      await this._markSignalActedOn(signalId, symbol, finalSignal.signal);
      this._pendingSignalIds.delete(symbol);
    }

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
  // POSITION OUTCOME RECORDING
  // ═══════════════════════════════════════════════════════

  async recordPositionOutcome(symbol, pnl) {
    if (!this.pipeline) {
      log.warn({ symbol }, 'recordPositionOutcome: pipeline not available');
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
        await this.pipeline.adaptiveWeights.recordOutcome({
          strategy, signal: 'BUY', symbol, outcome, pnl,
        });
      }
    }

    this._lastSignalStrategies.delete(symbol);
  }

  // ═══════════════════════════════════════════════════════
  // FORCE EXIT — Position manager bypass path
  // ═══════════════════════════════════════════════════════

  /**
   * Force-exit an open position, bypassing consensus and pipeline gates.
   * Used by PositionManager for stop loss, trailing stop, profit target,
   * partial exit, signal reversal, and time exits.
   *
   * Patch 2: Optional qty parameter for partial exits.
   *   - qty === null or qty >= posCtx.quantity → full exit
   *     (removes from _filledPositions, calls removePosition + recordPositionOutcome)
   *   - qty < posCtx.quantity → partial exit
   *     (does NOT remove from _filledPositions, caller updates posCtx.quantity)
   *
   * @param {string} symbol
   * @param {number} exitPrice
   * @param {string} reason
   * @param {number|null} [qty=null] - null = full exit; number = partial qty
   */
  async forceExit(symbol, exitPrice, reason, qty = null) {
    const posCtx = this._filledPositions.get(symbol);
    if (!posCtx) {
      log.warn({ symbol, reason }, 'forceExit called but no position found — already closed?');
      return { success: false, pnl: 0, order: null };
    }

    const exitQty = qty ?? posCtx.quantity;
    const isFullExit = !qty || qty >= posCtx.quantity;

    const unrealisedPnL = (exitPrice - posCtx.entryPrice) * exitQty;

    log.warn({
      symbol,
      reason,
      entryPrice: posCtx.entryPrice,
      exitPrice,
      quantity: exitQty,
      isFullExit,
      unrealisedPnL: unrealisedPnL.toFixed(2),
    }, `🚨 Position manager forcing exit: ${symbol} — ${reason}`);

    const order = createOrder({
      symbol,
      side: 'SELL',
      quantity: exitQty,
      price: exitPrice,
      strategy: reason,
    });

    this._orders.set(order.id, order);

    try {
      const result = this.paperMode
        ? await this._paperPlaceOrder(order)
        : await this._livePlaceOrder(order);

      transitionOrder(order, ORDER_STATE.PLACED, { brokerId: result.orderId });
      transitionOrder(order, ORDER_STATE.FILLED);

      const pnl = (exitPrice - posCtx.entryPrice) * exitQty;
      order.pnl = pnl;

      if (isFullExit) {
        // Full exit — clean up all state
        this._filledPositions.delete(symbol);
        this.riskManager.removePosition();
        await this.riskManager.recordTradePnL(pnl, symbol);

        this.recordPositionOutcome(symbol, pnl).catch(err =>
          log.warn({ symbol, err: err.message }, 'Outcome recording failed after force exit')
        );

        const signalId = this._pendingSignalIds.get(symbol);
        if (signalId) {
          this._markSignalActedOn(signalId, symbol, 'SELL').catch(() => { });
          this._pendingSignalIds.delete(symbol);
        }
      } else {
        // Partial exit — record partial P&L but keep position open
        // PositionManager.executePartialExit() updates posCtx.quantity after this returns
        await this.riskManager.recordTradePnL(pnl, symbol);
        log.info({
          symbol,
          partialQty: exitQty,
          remainingQty: posCtx.quantity - exitQty,
          pnl: pnl.toFixed(2),
        }, `📊 Partial exit recorded: ${symbol}`);
      }

      // Persist trade to DB regardless of full/partial
      this._persistTrade(order).catch(err =>
        log.error({ symbol, err: err.message }, 'Trade persist failed after force exit')
      );

      log.info({
        symbol,
        reason,
        pnl: pnl.toFixed(2),
        entryPrice: posCtx.entryPrice,
        exitPrice,
        quantity: exitQty,
        isFullExit,
      }, `✅ Force exit complete: ${symbol} | PnL: ₹${pnl.toFixed(2)}`);

      return { success: true, pnl, order };

    } catch (err) {
      log.error({ symbol, reason, err: err.message }, 'Force exit FAILED — position may still be open');
      transitionOrder(order, ORDER_STATE.REJECTED, { rejectionReason: err.message });
      return { success: false, pnl: 0, order };
    }
  }

  // ═══════════════════════════════════════════════════════
  // ORDER EXECUTION
  // ═══════════════════════════════════════════════════════

  async executeOrder(params) {
    const order = createOrder(params);
    this._orders.set(order.id, order);

    if (this._pendingSymbols.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Duplicate: existing PENDING order for ${params.symbol}`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        'Order REJECTED — duplicate PENDING order for symbol');
      return order;
    }

    if (params.side === 'BUY' && this._filledPositions.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Already holding position in ${params.symbol}`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        'Order REJECTED — already holding position for symbol');
      return order;
    }

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
        log.warn({ symbol: params.symbol, err: err.message },
          'Holdings check failed — proceeding without exposure check');
      }
    }

    if (params.side === 'SELL' && !this._filledPositions.has(params.symbol)) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `SELL rejected — no open position found for ${params.symbol} after DB hydration`,
      });
      log.warn({ symbol: params.symbol, orderId: order.id },
        `SELL rejected — no open position found for ${params.symbol}`);
      return order;
    }

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

  /** @private */
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
          const strategies = this._lastSignalStrategies.get(order.symbol) || [];
          const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
          const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;
          const targetPct = this._config?.PROFIT_TARGET_PCT ?? 1.8;

          // Patch 3: openingStrategy stored on posCtx for signal reversal detection
          const posCtx = {
            strategies,
            openingStrategy: strategies[0] || 'UNKNOWN',
            entryPrice: order.price,
            price: order.price,             // backward compat
            quantity: order.quantity,
            timestamp: Date.now(),

            // Fallback stop/trail from config — overwritten by initPosition() below
            stopPrice: order.price * (1 - stopPct / 100),
            highWaterMark: order.price,
            trailStopPrice: order.price * (1 - trailPct / 100),
            trailPct,
            stopPct,

            // Fallback profit target — overwritten by initPosition()
            profitTargetPrice: order.price * (1 + targetPct / 100),
            profitTargetMode: 'FIXED_PCT',
            partialExitEnabled: this._config?.PARTIAL_EXIT_ENABLED ?? true,
            partialExitDone: false,
            partialExitQty: 0,
            signalReversalEnabled: this._config?.SIGNAL_REVERSAL_ENABLED ?? true,
          };

          this._filledPositions.set(order.symbol, posCtx);

          // Patch 4: Call positionManager.initPosition() to set proper exit levels
          // using exit-strategies.js (ATR-based trail, strategy-aware profit target,
          // partial exit qty, etc.). Falls back silently to config-based levels above.
          if (this.positionManager) {
            try {
              const candles = this._fetchCandles
                ? await this._fetchCandles(order.symbol, 20).catch(() => [])
                : [];
              const closes = candles.map(c => c.close);
              const highs = candles.map(c => c.high);
              const lows = candles.map(c => c.low);
              await this.positionManager.initPosition(order.symbol, posCtx, closes, highs, lows);
            } catch (err) {
              log.warn({ symbol: order.symbol, err: err.message },
                'initPosition failed — using config-based stop/trail/target as fallback');
              // posCtx already has fallback values set above — position is not unprotected
            }
          }

          // Bug Fix 3: Sync position count to risk manager
          this.riskManager.addPosition();

          if (this.telegram?.enabled) {
            const stopPrice = posCtx.stopPrice;
            const targetPrice = posCtx.profitTargetPrice;
            this.telegram.sendRaw(
              `📦 <b>Position ENTRY — ${order.symbol}</b>\n\n` +
              `📥 Entry:  ₹${order.price.toFixed(2)}\n` +
              `📦 Qty:    ${order.quantity}\n` +
              `🛑 Stop:   ₹${stopPrice.toFixed(2)}\n` +
              `🎯 Target: ₹${targetPrice.toFixed(2)} (${posCtx.profitTargetMode})\n` +
              `🧠 Strats: ${strategies.join(', ')}\n` +
              `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
            ).catch(() => { });
          }

        } else if (order.side === 'SELL') {
          const posCtx = this._filledPositions.get(order.symbol);
          if (posCtx) {
            const pnl = (order.price - posCtx.price) * posCtx.quantity;
            order.pnl = pnl;

            log.info({
              symbol: order.symbol,
              entryPrice: posCtx.price,
              sellPrice: order.price,
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

            if (this.telegram?.enabled) {
              const emoji = pnl >= 0 ? '✅' : '🛑';
              const pnlStr = pnl >= 0
                ? `+₹${pnl.toFixed(2)}`
                : `-₹${Math.abs(pnl).toFixed(2)}`;
              this.telegram.sendRaw(
                `${emoji} <b>Position EXIT — ${order.symbol}</b>\n\n` +
                `📌 Reason: SIGNAL_EXIT\n` +
                `📥 Entry:  ₹${posCtx.price.toFixed(2)}\n` +
                `📤 Exit:   ₹${order.price.toFixed(2)}\n` +
                `💰 P&amp;L:   ${pnlStr}\n` +
                `📦 Qty:    ${posCtx.quantity}\n` +
                `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
              ).catch(() => { });
            }
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

    const maxAttempts = 4;
    let fillPrice = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const history = await this.broker.getOrderHistory(response.order_id);
        const fetchedPrice = history?.average_price
          || (Array.isArray(history) ? history[history.length - 1]?.average_price : null)
          || null;

        if (fetchedPrice && fetchedPrice > 0) {
          fillPrice = fetchedPrice;
          order.price = fillPrice;
          log.info({
            orderId: response.order_id,
            fillPrice,
            scanPrice: order.price,
            attempts: attempt,
          }, 'Fill price fetched — overwriting scan-time price');
          break;
        }
      } catch (err) {
        if (err.response?.status !== 404 && err.statusCode !== 404) throw err;
      }

      if (attempt < maxAttempts) await this._delay(400);
    }

    if (!fillPrice) {
      log.warn({
        orderId: response.order_id,
        attempts: maxAttempts,
        fallback: 'scan-time price',
      }, 'Could not fetch fill price — using scan-time price');
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
      return { reconciled: [], stillOpen: [] };
    }

    try {
      const initialPositionCount = this._filledPositions.size;

      const rawPositions = await broker.getPositions();
      const brokerSymbols = new Set(
        (rawPositions?.net || rawPositions || [])
          .filter(p => (p.quantity || p.netQuantity || 0) !== 0)
          .map(p => p.tradingsymbol || p.tradingSymbol || p.symbol)
      );

      const reconciled = [];
      const stillOpen = [];

      const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Kolkata',
        year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const todayIST = formatter.format(new Date());

      for (const [symbol, posCtx] of this._filledPositions.entries()) {
        const posDateIST = formatter.format(new Date(posCtx.timestamp));
        if (posDateIST === todayIST && !brokerSymbols.has(symbol)) {
          log.warn(`Position reconciliation: ${symbol} closed externally — removing from engine state`);
          this.markPositionClosed(symbol);
          if (this.riskManager) this.riskManager.removePosition();
          if (this.telegram?.enabled) {
            this.telegram.sendRaw(
              `⚠️ <b>Position Closed Externally — ${symbol}</b>\n` +
              `Removed from engine state via reconciliation.\n` +
              `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
            ).catch(() => { });
          }
          reconciled.push(symbol);
        } else {
          stillOpen.push(symbol);
        }
      }

      log.info({
        checked: initialPositionCount,
        reconciled: reconciled.length,
        stillOpen: stillOpen.length,
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
    this._pendingSignalIds.clear();        // Patch 5: confirmed retained
    log.info('Execution engine daily state reset');
  }

  markPositionClosed(symbol) {
    this._filledPositions.delete(symbol);
  }

  // ═══════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════

  /** @private */
  _delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /** @private */
  async _persistTrade(order) {
    try {
      await query(
        `INSERT INTO trades
           (order_id, symbol, side, quantity, price, pnl, strategy, status, paper_mode, created_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
         ON CONFLICT (order_id) DO NOTHING`,
        [
          order.id, order.symbol, order.side, order.quantity,
          order.price, order.pnl || 0, order.strategy, order.state, this.paperMode,
        ]
      );
      log.debug({ orderId: order.id, symbol: order.symbol }, 'Trade persisted to DB');
    } catch (err) {
      log.error({ orderId: order.id, err: err.message }, 'CRITICAL: Trade DB write failed');
    }
  }

  /**
   * Bug Fix 1: Awaited in processSignal. Returns CONSENSUS signal row ID.
   * @private
   */
  async _persistSignals(symbol, consensus, currentPrice = null) {
    let consensusSignalId = null;

    try {
      await query('BEGIN');

      for (const detail of (consensus.details || [])) {
        await query(
          `INSERT INTO signals
             (symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
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

      const consensusRow = await query(
        `INSERT INTO signals
           (symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
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
      await query('COMMIT');
    } catch (err) {
      try { await query('ROLLBACK'); } catch { /* swallow */ }
      log.error({ symbol, err: err.message }, 'Failed to persist signals to DB');
    }

    return consensusSignalId;
  }

  /**
   * Bug Fix 1: Uses signal row ID directly — no timestamp race.
   * @private
   */
  async _markSignalActedOn(signalId, symbol, signal) {
    try {
      if (signalId) {
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
          log.error({ symbol, signal }, 'Fallback: failed to mark signal acted_on');
        }
      }
    } catch (err) {
      log.error({ signalId, symbol, err: err.message },
        `CRITICAL: Failed to mark signal as acted_on (signalId=${signalId})`);
    }
  }

  /**
   * Feature 9: Telegram conflict alert — rate-limited per symbol via Redis.
   * @private
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
        `📈 BUY:  ${buyStrategies.join(', ')}\n` +
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