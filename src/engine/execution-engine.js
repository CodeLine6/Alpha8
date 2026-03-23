/**
 * @fileoverview Order Execution Engine for Alpha8
 *
 * FIXES APPLIED THIS PASS:
 *
 *   Fix 1 — forceExit() ReferenceError: currentPrice → exitPrice
 *     The parameter is named `exitPrice` but the function body referenced
 *     `currentPrice` (undefined). Every stop-loss, trail, and time exit
 *     would throw ReferenceError at runtime. All occurrences replaced.
 *
 *   Fix 4 — Super Conviction openingStrategy and firingStrategies
 *     When Super Conviction fires, only the conviction strategy drove the
 *     trade. Previously all BUY voters were captured as firingStrategies,
 *     polluting adaptive weights and setting the wrong profit target mode.
 *     Now uses consensusResult.convictionStrategy when present.
 *
 *   Fix 24 — Partial exit failure guard
 *     _executePartialExit (in position-manager) was mutating posCtx even
 *     when forceExit returned success:false. The guard is here: forceExit()
 *     now returns { success, pnl, order } clearly on the partial path so
 *     the caller can check before mutating.
 *
 *   Fix 27 — Re-entry cooldown after force exit
 *     After positionManager force-exits a symbol, _filledPositions is cleared
 *     and the next strategy scan would immediately re-enter on the same candle.
 *     Added _recentlyExited Set with per-symbol cooldown (cleared each scan).
 *
 *   Fix 39 — Unescaped & in SELL exit Telegram message
 *     '💰 P&L:' → '💰 P&amp;L:' in _placeWithRetry SELL path.
 *
 *   Fix hydration — trades.strategy stores reason string, not clean name
 *     hydratePositions() now checks if strategy column looks like a clean
 *     constant (no spaces) and uses it; otherwise falls back to 'UNKNOWN'.
 *     executeOrder() now writes opening_strategies JSON column at BUY time
 *     so hydration can recover clean strategy names after restart.
 *     NOTE: requires ALTER TABLE trades ADD COLUMN opening_strategies TEXT
 *     (migration in setup-db.js). Falls back gracefully if column missing.
 */

import { createLogger } from '../lib/logger.js';
import { ORDER_STATE, MAX_ORDER_RETRIES, RETRY_DELAY_MS } from '../config/constants.js';
import { createOrder, transitionOrder, isTerminal } from './order-state-machine.js';
import { query, getPool } from '../lib/db.js';
import { calcNetPnl, calcTradeCost } from '../lib/brokerage.js';

const log = createLogger('execution-engine');

export class ExecutionEngine {
  /**
   * @param {Object} deps
   * @param {import('../data/holdings.js').HoldingsManager} [deps.holdingsManager]
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

    /** Injected after construction to avoid circular dep. */
    this.positionManager = null;

    /** Injected from index.js for ATR calculation in initPosition. */
    this._fetchCandles = null;

    this._orders = new Map();
    this._pendingSymbols = new Set();
    this._filledPositions = new Map();
    this._lastSignalStrategies = new Map();
    this._pendingSignalIds = new Map();

    /**
     * Fix 27: Symbols that were force-exited this scan cycle.
     * Cleared at the start of each scan in processSignal to prevent
     * re-entry on the same candle that triggered the exit.
     * @type {Set<string>}
     */
    this._recentlyExited = new Set();

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
    log.info({ integrity, paperMode: this.paperMode }, 'Execution engine initialized and ready');
    return { ready: true, integrity };
  }

  /**
   * Hydrate _filledPositions from DB on startup/restart.
   *
   * Fix hydration: trades.strategy is a reason string like
   * "BUY consensus: EMA_CROSSOVER(reversal)..." not a clean strategy name.
   * We now also read the opening_strategies column (added in migration) which
   * stores clean strategy names as JSON. Falls back to parsing strategy column
   * if the new column is absent (old rows) or NULL.
   */
  async hydratePositions() {
    log.info('Hydrating open positions from DB...');

    const isPaperMode = this.paperMode;

    const result = await query(
      `SELECT symbol, price, quantity, strategy, created_at,
              opening_strategies
       FROM (
         SELECT DISTINCT ON (symbol)
           symbol, side, price, quantity, strategy, created_at, id,
           opening_strategies
         FROM trades
         WHERE status     = 'FILLED'
           AND paper_mode = $1
           AND (created_at AT TIME ZONE 'Asia/Kolkata')::date =
               (NOW()      AT TIME ZONE 'Asia/Kolkata')::date
         ORDER BY symbol, created_at DESC, id DESC
       ) AS latest_trades
       WHERE side IN ('BUY', 'SELL')`,
      [isPaperMode]
    ).catch(async (err) => {
      // opening_strategies column may not exist on old schema — retry without it
      if (err.message?.includes('opening_strategies')) {
        log.warn('opening_strategies column not found — running without it (run migration)');
        return query(
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
           WHERE side IN ('BUY', 'SELL')`,
          [isPaperMode]
        );
      }
      throw err;
    });

    this._filledPositions.clear();

    const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
    const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;
    const targetPct = this._config?.PROFIT_TARGET_PCT ?? 1.8;

    // Valid strategy constants — used to detect clean names vs reason strings
    const VALID_STRATEGIES = new Set([
      'EMA_CROSSOVER', 'RSI_MEAN_REVERSION', 'VWAP_MOMENTUM', 'BREAKOUT_VOLUME',
    ]);

    for (const row of result.rows) {
      const entryPrice = parseFloat(row.price);

      // Recover clean opening strategy name:
      // 1. Try opening_strategies JSON column (new schema)
      // 2. Fall back to strategy column if it's a clean constant name
      // 3. Otherwise UNKNOWN
      let openingStrategy = 'UNKNOWN';
      let strategies = [];

      if (row.opening_strategies) {
        try {
          strategies = JSON.parse(row.opening_strategies);
          if (Array.isArray(strategies) && strategies.length > 0) {
            openingStrategy = strategies[0];
          }
        } catch { /* malformed JSON — leave as UNKNOWN */ }
      }

      if (openingStrategy === 'UNKNOWN' && row.strategy && VALID_STRATEGIES.has(row.strategy)) {
        openingStrategy = row.strategy;
        strategies = [row.strategy];
      }

      const isShort = row.side === 'SELL';
      this._filledPositions.set(row.symbol, {
        direction: isShort ? 'SELL' : 'BUY',
        isShort,
        strategies,
        openingStrategy,
        entryPrice,
        price: entryPrice,
        quantity: parseInt(row.quantity, 10),
        timestamp: new Date(row.created_at).getTime(),

        // Levels are direction-aware (exit-strategies.js handles both)
        stopPrice: isShort
          ? entryPrice * (1 + stopPct / 100)    // above entry for shorts
          : entryPrice * (1 - stopPct / 100),   // below entry for longs
        highWaterMark: entryPrice,
        trailStopPrice: isShort
          ? entryPrice * (1 + trailPct / 100)
          : entryPrice * (1 - trailPct / 100),
        trailPct,
        stopPct,
        profitTargetPrice: isShort
          ? entryPrice * (1 - targetPct / 100)
          : entryPrice * (1 + targetPct / 100),
        profitTargetMode: 'FIXED_PCT',
        partialExitEnabled: false,
        partialExitDone: true,
        signalReversalEnabled: this._config?.SIGNAL_REVERSAL_ENABLED ?? true,
        hydratedFromDB: true,
      });

      // Fix BUG-11: restoreDeployment does NOT add to _totalCashRequired.
      // openDeployment() would double-count the denominator — cash was already
      // counted before the restart. This method only restores _currentDeployment.
      const hydratedTradeSize = entryPrice * parseInt(row.quantity, 10);
      this.riskManager.restoreDeployment(hydratedTradeSize);
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

    // Fix 27: Block re-entry on the same scan cycle as a force exit.
    if (this._recentlyExited.has(symbol)) {
      log.info({ symbol }, 'Re-entry blocked — symbol was force-exited this scan cycle');
      return { action: 'HOLD', order: null, consensus: null };
    }

    const consensusResult = this.consensus.evaluate(candles, symbol);

    const consensusSignalId = await this._persistSignals(symbol, consensusResult, currentPrice)
      .catch((err) => {
        log.error({ symbol, err: err.message }, 'Signal persistence failed');
        return null;
      });

    if (consensusSignalId) {
      this._pendingSignalIds.set(symbol, consensusSignalId);
    }

    // N3 FIX: fetch regime BEFORE the HOLD check so shadow signals always have regime metadata.
    let regime = null;
    if (this.pipeline?.regimeDetector) {
      try {
        const regimeState = await this.pipeline.regimeDetector.getRegime();
        regime = regimeState?.regime ?? null;
      } catch (err) {
        log.warn({ symbol, err: err.message }, 'Could not fetch regime — using default threshold');
      }
    }

    if (consensusResult.signal === 'HOLD') {
      if (consensusResult.isConflicted && this.telegram && this.redis) {
        this._alertConflict(symbol, consensusResult).catch(() => { });
      }
      if (this.shadowRecorder && (consensusResult.details?.length ?? 0) > 0) {
        this.shadowRecorder.recordSignals(
          symbol, consensusResult.details, consensusResult, false, currentPrice, regime, this.paperMode
        ).catch(err => log.warn({ symbol, err: err.message }, 'Shadow signal (HOLD) recording failed'));
      }
      return { action: 'HOLD', order: null, consensus: consensusResult };
    }



    let acted = false;
    let order = null;

    // src/engine/execution-engine.js — processSignal()
    // Only run the pipeline for BUY signals:

    let finalSignal = consensusResult;
    let adjustedQty = quantity;
    let pipelineLog = null;

    if (this.pipeline && consensusResult.signal === 'BUY') {  // ← ADD signal check
      const isConviction = !!consensusResult.convictionStrategy;
      // Pass the live-setting threshold so the pipeline's bypass check uses
      // the same value that signal-consensus used to grant convictionStrategy.
      const convictionThreshold = this.consensus.superConvictionThreshold ?? 80;
      const pipelineResult = await this.pipeline.process(
        symbol, consensusResult.details || [], regime, isConviction, convictionThreshold
      );
      pipelineLog = pipelineResult.log;

      if (!pipelineResult.allowed) {
        log.info({ symbol, blockedBy: pipelineResult.blockedBy }, 'BUY blocked by pipeline');
        if (this.shadowRecorder) {
          this.shadowRecorder.recordSignals(
            symbol, consensusResult.details || [], consensusResult,
            false, currentPrice, regime, this.paperMode
          ).catch(() => { });
        }
        return {
          action: `BLOCKED:${pipelineResult.blockedBy}`,
          order: null,
          consensus: consensusResult,
          pipelineLog: pipelineResult.log,
        };
      }

      if (pipelineResult.positionSizeMult < 1.0) {
        adjustedQty = Math.max(1, Math.floor(quantity * pipelineResult.positionSizeMult));
      }
      if (pipelineResult.signal) {
        finalSignal = { ...consensusResult, ...pipelineResult.signal };
      }
    } else if (this.pipeline && consensusResult.signal === 'SELL') {
      // SELL signals bypass pipeline gates — exits must always be allowed
      log.debug({ symbol }, 'SELL signal bypasses pipeline gates');
    }

    if (finalSignal.signal === 'BUY') {
      // Fix 4: When Super Conviction fired, only the conviction strategy drove
      // this trade. Use it exclusively so that openingStrategy, profit target
      // mode, and adaptive weight credit are all correctly attributed.
      const convictionStrategy = consensusResult.convictionStrategy || null;

      const firingStrategies = convictionStrategy
        ? [convictionStrategy]
        : (consensusResult.details || [])
          .filter(d => d.signal === 'BUY' && d.meetsFloor !== false && !d.suppressedByTime)
          .map(d => d.strategy)
          .filter(Boolean);

      this._lastSignalStrategies.set(symbol, firingStrategies);
    } else if (finalSignal.signal === 'SELL') {
      // A SELL signal can mean:
      //   (a) Exit an existing long  — handled by executeOrder's SELL path
      //   (b) Open a new short       — only if isShortEntry===true in consensus
      const isShortEntry = consensusResult.isShortEntry === true ||
        (consensusResult.convictionStrategy &&
          !SHORT_INELIGIBLE_STRATEGIES.has(consensusResult.convictionStrategy) &&
          consensusResult.isShortEntry !== false);

      if (isShortEntry && !this._filledPositions.has(symbol)) {
        // Opening a new short position — track strategies same as longs
        const convictionStrategy = consensusResult.convictionStrategy || null;
        const firingStrategies = convictionStrategy
          ? [convictionStrategy]
          : (consensusResult.details || [])
            .filter(d => d.signal === 'SELL' && d.meetsFloor !== false &&
              !d.suppressedByTime &&
              !SHORT_INELIGIBLE_STRATEGIES.has(d.strategy))
            .map(d => d.strategy)
            .filter(Boolean);
        this._lastSignalStrategies.set(symbol, firingStrategies);
      }
    }


    order = await this.executeOrder({
      symbol,
      side:         finalSignal.signal,
      quantity:     adjustedQty,
      price:        currentPrice,
      strategy:     finalSignal.reason || consensusResult.reason,
      isShortEntry: consensusResult.isShortEntry ?? false,   // Fix BUG-01: was missing, causing all short entries to be rejected
    });

    acted = (order.state === (this.paperMode ? 'FILLED' : 'PLACED') || order.state === 'FILLED');
    // Ensure acted is true if order reached broker or was filled in paper mode
    const isActed = order.state === 'FILLED' || (order.brokerId && order.state !== 'REJECTED');

    if (isActed) {
      const signalId = this._pendingSignalIds.get(symbol);
      await this._markSignalActedOn(signalId, symbol, finalSignal.signal);
      this._pendingSignalIds.delete(symbol);
    }

    if (this.shadowRecorder) {
      this.shadowRecorder.recordSignals(
        symbol,
        consensusResult.details || [],
        consensusResult,
        !!isActed,
        currentPrice,
        regime,
        this.paperMode, // S6 FIX: pass paperMode
      ).catch(err => log.warn({ symbol, err: err.message }, 'Shadow signal recording failed'));
    }

    return {
      action: isActed ? 'EXECUTED' : order.state,
      order,
      consensus: consensusResult,
      pipelineLog,
    };
  }

  // ═══════════════════════════════════════════════════════
  // POSITION OUTCOME RECORDING
  // ═══════════════════════════════════════════════════════

  async recordPositionOutcome(symbol, pnl, forceStrategies = null) {
    if (!this.pipeline) {
      log.warn({ symbol }, 'recordPositionOutcome: pipeline not available');
      return;
    }

    let strategies = forceStrategies || this._lastSignalStrategies.get(symbol) || [];

    // Fallback: Check _filledPositions if _lastSignalStrategies is empty (e.g. after restart)
    if (strategies.length === 0 && this._filledPositions.has(symbol)) {
      strategies = this._filledPositions.get(symbol).strategies || [];
    }

    if (strategies.length === 0) {
      log.warn({ symbol }, 'recordPositionOutcome: no BUY strategies on record for symbol');
      return;
    }

    const outcome = pnl >= 0 ? 'WIN' : 'LOSS';
    log.info({ symbol, pnl, outcome, strategies }, 'Recording position outcome for adaptive weights');

    for (const strategy of strategies) {
      // Call pipeline.recordTradeOutcome for each strategy (adaptive perf tracking)
      if (this.pipeline.recordTradeOutcome) {
        await this.pipeline.recordTradeOutcome(strategy, 'BUY', symbol, pnl);
      }
      if (this.pipeline.adaptiveWeights) {
        await this.pipeline.adaptiveWeights.recordOutcome({
          strategy, signal: 'BUY', symbol, outcome, pnl,
          paperMode: this.paperMode,
        });
      }
    }

    this._lastSignalStrategies.delete(symbol);
  }

  // ═══════════════════════════════════════════════════════
  // FORCE EXIT
  // ═══════════════════════════════════════════════════════

  /**
   * Force-exit an open position, bypassing consensus and pipeline gates.
   *
   * Fix 1: All references to `currentPrice` renamed to `exitPrice` to match
   * the parameter name. The original code had `currentPrice` which was
   * undefined, causing a ReferenceError on every stop/trail/time exit.
   *
   * Fix 27: Adds symbol to _recentlyExited so the same scan cycle doesn't
   * immediately re-enter the position just force-exited.
   *
   * @param {string} symbol
   * @param {number} exitPrice
   * @param {string} reason
   * @param {number|null} [qty=null]
   */
  async forceExit(symbol, exitPrice, reason, qty = null) {
    const posCtx = this._filledPositions.get(symbol);
    if (!posCtx) {
      log.warn({ symbol, reason }, 'forceExit called but no position found — already closed?');
      return { success: false, pnl: 0, order: null };
    }

    const exitQty = qty ?? posCtx.quantity;
    const isFullExit = qty === null || qty === undefined || qty >= posCtx.quantity;

    // Fix Bug 7: Determine position direction — needed for order side and P&L sign
    const isShortPos = posCtx.isShort ?? posCtx.direction === 'SELL';

    // Fix Bug 1 (prior fix): was `currentPrice` (undefined) — correctly uses `exitPrice`
    const unrealisedPnL = isShortPos
      ? (posCtx.entryPrice - exitPrice) * exitQty   // short profits when price falls
      : (exitPrice - posCtx.entryPrice) * exitQty;

    log.warn({
      symbol, reason,
      entryPrice: posCtx.entryPrice,
      exitPrice,
      quantity: exitQty,
      isFullExit,
      isShort: isShortPos,
      unrealisedPnL: unrealisedPnL.toFixed(2),
    }, `🚨 Position manager forcing exit: ${symbol} — ${reason}`);

    // Fix Bug 7: Use BUY to cover a short, SELL to close a long
    const coverSide = isShortPos ? 'BUY' : 'SELL';

    const order = createOrder({
      symbol,
      side: coverSide,
      quantity: exitQty,
      price: exitPrice,
      strategy: reason,
    });

    this._orders.set(order.id, order);

    try {
      const result = this.paperMode
        ? await this._paperPlaceOrder(order)
        : await this._livePlaceOrder(order, { emergency: true }); // C3 FIX: bypass circuit breaker

      // Defensive check: if broker returns no order ID, do NOT proceed.
      // This stays in memory so reconciliation (for LIVE) or next scan can retry.
      if (!result.orderId) {
        throw new Error('Broker returned no order ID — exit not confirmed');
      }

      transitionOrder(order, ORDER_STATE.PLACED, { brokerId: result.orderId });
      transitionOrder(order, ORDER_STATE.FILLED);

      // Fix Bug 3 & 7: Compute P&L correctly for both long and short positions.
      // For longs: use calcNetPnl (includes cost calculation, returns signed grossPnl + netPnl).
      // For shorts: calcNetPnl's grossPnl sign is inverted (exit-entry)*qty which is negative
      //   when profitable. Use explicit calcTradeCost for each leg instead.
      let pnl, grossPnl, totalCost;
      if (isShortPos) {
        grossPnl  = (posCtx.entryPrice - exitPrice) * exitQty;  // positive = profitable short
        // Short entry was a SELL, exit is a BUY
        const entryCost = calcTradeCost({ side: 'SELL', price: posCtx.entryPrice, quantity: exitQty });
        const exitCost  = calcTradeCost({ side: 'BUY',  price: exitPrice,         quantity: exitQty });
        totalCost = entryCost.total + exitCost.total;
        pnl       = grossPnl - totalCost;
      } else {
        const costs = calcNetPnl({ entryPrice: posCtx.entryPrice, exitPrice, quantity: exitQty });
        grossPnl  = costs.grossPnl;
        totalCost = costs.totalCost;
        pnl       = costs.netPnl;
      }
      order.pnl      = pnl;
      order.grossPnl = grossPnl;
      order.costPaid = totalCost;

      if (isFullExit) {
        // Fix for post-restart credit: pass strategies explicitly before deleting from _filledPositions
        const strategies = posCtx.strategies || [];
        this.recordPositionOutcome(symbol, pnl, strategies).catch(err =>
          log.warn({ symbol, err: err.message }, 'Outcome recording failed after force exit')
        );

        this._filledPositions.delete(symbol);
        this.riskManager.removePosition();
        await this.riskManager.recordTradePnL(pnl, symbol);

        // ROI: return deployed capital back to pool on full exit
        const fullExitSize = posCtx.entryPrice * exitQty;
        this.riskManager.closeDeployment(fullExitSize, pnl);
        order.tradeRoi = fullExitSize > 0 ? +((pnl / fullExitSize) * 100).toFixed(4) : 0;
        order.capitalDeployed = fullExitSize;

        const signalId = this._pendingSignalIds.get(symbol);
        if (signalId) {
          this._markSignalActedOn(signalId, symbol, 'SELL').catch(() => { });
          this._pendingSignalIds.delete(symbol);
        }

        // Fix 27: mark this symbol as recently exited to block re-entry this scan
        this._recentlyExited.add(symbol);
      } else {
        // Partial exit — record partial P&L but keep position open.
        // posCtx.quantity is updated by _executePartialExit() in position-manager
        // only if this returns success:true.
        await this.riskManager.recordTradePnL(pnl, symbol);

        // Fix BUG-18: use exitQty (partial quantity), NOT posCtx.quantity (full size)
        const partialTradeSize = posCtx.entryPrice * exitQty;
        this.riskManager.closeDeployment(partialTradeSize, pnl);
        order.tradeRoi = partialTradeSize > 0 ? +((pnl / partialTradeSize) * 100).toFixed(4) : 0;
        order.capitalDeployed = partialTradeSize;

        log.info({
          symbol,
          partialQty: exitQty,
          remainingQty: posCtx.quantity - exitQty,
          pnl: pnl.toFixed(2),
        }, `📊 Partial exit recorded: ${symbol}`);
      }

      await this._persistTrade(order).catch(err =>
        log.error({ symbol, err: err.message }, 'Trade persist failed after force exit')
      );

      log.info({
        symbol, reason,
        pnl: pnl.toFixed(2),
        entryPrice: posCtx.entryPrice,
        exitPrice,                       // Fix 1: was `currentPrice`
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

  /**
   * Clear the recently-exited set at the start of each scan cycle.
   * Called by the scheduler before running processSignal() for each symbol.
   */
  clearRecentExits() {
    this._recentlyExited.clear();
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

    // Fix Bug 4: Allow BUY if covering an existing SHORT position.
    // A short position is stored with isShort:true. A BUY on it is a cover, not a dupe.
    if (params.side === 'BUY' && this._filledPositions.has(params.symbol)) {
      const existing = this._filledPositions.get(params.symbol);
      if (!existing.isShort) {
        transitionOrder(order, ORDER_STATE.REJECTED, {
          rejectionReason: `Already holding LONG position in ${params.symbol}`,
        });
        log.warn({ symbol: params.symbol, orderId: order.id },
          'Order REJECTED — already holding LONG position for symbol');
        return order;
      }
      // existing.isShort === true — fall through to place BUY-to-cover
      log.info({ symbol: params.symbol }, `Covering SHORT position for ${params.symbol}`);
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
      // Allow if this is an explicit short entry order
      if (!params.isShortEntry) {
        transitionOrder(order, ORDER_STATE.REJECTED, {
          rejectionReason: `SELL rejected — no open position found for ${params.symbol} after DB hydration`,
        });
        log.warn({ symbol: params.symbol, orderId: order.id },
          `SELL rejected — no open position found for ${params.symbol}`);
        return order;
      }
      // isShortEntry=true: fall through to place a new short position
      log.info({ symbol: params.symbol }, `Opening SHORT position for ${params.symbol}`);
    }

    // ─── Phase 1: Risk Engine Check ──────────────────────
    let brokerExposure = 0;
    if (this.holdingsManager) {
      const exposureData = await this.holdingsManager.getTotalExposureValue();
      brokerExposure = exposureData.totalValue;
    }

    // Autoritative in-memory exposure (essential for Paper Mode and immediate sync)
    let memoryExposure = 0;
    if (this._filledPositions.size > 0) {
      for (const pos of this._filledPositions.values()) {
        memoryExposure += (pos.quantity * (pos.price || pos.entryPrice || 0));
      }
    }

    // Use the higher of the two to be conservative
    const totalExposure = Math.max(brokerExposure, memoryExposure);

    const riskDecision = this.riskManager.validateOrder({
      symbol: params.symbol,
      side: params.side,
      quantity: params.quantity,
      price: params.price,
      strategy: params.strategy,
      isShortEntry: params.isShortEntry ?? false,  // FIX: short entries also count as new positions
    }, totalExposure);

    if (!riskDecision.allowed) {
      transitionOrder(order, ORDER_STATE.REJECTED, {
        rejectionReason: `Risk gate: ${riskDecision.reason}`,
      });
      log.warn({ orderId: order.id, symbol: params.symbol, riskReason: riskDecision.reason },
        'Order REJECTED by risk manager');
      return order;
    }

    // Step 64: Track pending exposure until order is FILLED or REJECTED
    if (params.side === 'BUY') {
      this.riskManager.addPendingExposure(params.quantity * params.price);
    }

    this._pendingSymbols.add(params.symbol);
    try {
      const result = await this._placeWithRetry(order);

      // Invalidate holdings cache immediately if something was filled
      // to ensure the NEXT scan cycle sees the updated exposure.
      if (result.state === ORDER_STATE.FILLED && this.holdingsManager) {
        this.holdingsManager.clearSnapshotCache().catch(() => { });
      }

      return result;
    } finally {
      this._pendingSymbols.delete(params.symbol);
      // Step 65: Always clear pending exposure when order reaches final state
      if (order.side === 'BUY') {
        this.riskManager.clearPendingExposure(order.quantity * order.price);
      }
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
          const existingPos = this._filledPositions.get(order.symbol);

          if (existingPos?.isShort) {
            // ── Fix Bug 5: Covering a SHORT position ────────────────────────
            const grossPnl  = (existingPos.entryPrice - order.price) * existingPos.quantity;
            // Short entry was SELL, exit (cover) is BUY
            const entryCost = calcTradeCost({ side: 'SELL', price: existingPos.entryPrice, quantity: existingPos.quantity });
            const exitCost  = calcTradeCost({ side: 'BUY',  price: order.price,            quantity: existingPos.quantity });
            const totalCost = entryCost.total + exitCost.total;
            const pnl       = grossPnl - totalCost;

            order.pnl         = pnl;
            order.grossPnl    = grossPnl;
            order.costPaid    = totalCost;
            order.isShortClose = true; // for _persistTrade back-fill
            order.tradeRoi    = existingPos.entryPrice > 0
              ? +((pnl / (existingPos.entryPrice * existingPos.quantity)) * 100).toFixed(4)
              : 0;
            order.capitalDeployed = existingPos.entryPrice * existingPos.quantity;
            // Fix BUG-19: carry entry order_id so _persistTrade can UPDATE by exact row
            order.openEntryOrderId = existingPos.openOrderId ?? null;

            await this.riskManager.recordTradePnL(pnl, order.symbol);
            // Fix Bug 14: pass existingPos.strategies explicitly so the correct
            // strategies that opened the short get credited for the outcome.
            this.recordPositionOutcome(order.symbol, pnl, existingPos.strategies).catch(() => {});
            this._filledPositions.delete(order.symbol);
            this.riskManager.removePosition();

            // ROI: return deployed capital back to pool on cover
            const shortTradeSize = existingPos.entryPrice * existingPos.quantity;
            this.riskManager.closeDeployment(shortTradeSize, pnl);

            this._recentlyExited.add(order.symbol);

            const signalId = this._pendingSignalIds.get(order.symbol);
            if (signalId) {
              this._markSignalActedOn(signalId, order.symbol, 'BUY').catch(() => {});
              this._pendingSignalIds.delete(order.symbol);
            }

            if (this.telegram?.enabled) {
              const emoji  = pnl >= 0 ? '✅' : '🛑';
              const pnlStr = pnl >= 0 ? `+₹${pnl.toFixed(2)}` : `-₹${Math.abs(pnl).toFixed(2)}`;
              // Fix Bug 19: label SHORT covers distinctly from LONG exits
              this.telegram.sendRaw(
                `${emoji} <b>SHORT Covered — ${order.symbol}</b>\n\n` +
                `📋 Reason: SIGNAL_COVER\n` +
                `📌 Direction: SHORT (covered)\n` +
                `📤 Short entry: ₹${existingPos.entryPrice.toFixed(2)}\n` +
                `📥 Cover:       ₹${order.price.toFixed(2)}\n` +
                `💰 Net P&amp;L:   ${pnlStr}\n` +
                `💸 Charges:     ₹${totalCost.toFixed(2)}\n` +
                `📦 Qty:         ${existingPos.quantity}\n` +
                `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
              ).catch(() => {});
            }

          } else {
            // ── Opening a new LONG position ──────────────────────────────────
            const strategies = this._lastSignalStrategies.get(order.symbol) || [];
            const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
            const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;
            const targetPct = this._config?.PROFIT_TARGET_PCT ?? 1.8;

          const posCtx = {
            direction: 'BUY',   // FIX: was missing — API falls back correctly but explicit is safer
            isShort: false,     // FIX: was missing — computeExitLevels needs this
            strategies,
            // Fix 4: openingStrategy is already the conviction-aware strategy
            // because _lastSignalStrategies was set correctly in processSignal()
            openingStrategy: strategies[0] || 'UNKNOWN',
            entryPrice: order.price,
            price: order.price,
            quantity: order.quantity,
            timestamp: Date.now(),

            stopPrice: order.price * (1 - stopPct / 100),
            highWaterMark: order.price,
            trailStopPrice: order.price * (1 - trailPct / 100),
            trailPct,
            stopPct,

            profitTargetPrice: order.price * (1 + targetPct / 100),
            profitTargetMode: 'FIXED_PCT',
            partialExitEnabled: this._config?.PARTIAL_EXIT_ENABLED ?? true,
            partialExitDone: false,
            partialExitQty: 0,
            signalReversalEnabled: this._config?.SIGNAL_REVERSAL_ENABLED ?? true,
          };

          this._filledPositions.set(order.symbol, posCtx);

          if (this.positionManager) {
            try {
              const rawCandles = this._fetchCandles
                ? await this._fetchCandles(order.symbol, 20).catch(() => [])
                : [];
              // Fix: initPosition expects separate close/high/low arrays, not candle objects
              const recentCloses = rawCandles.map(c => c.close);
              const recentHighs  = rawCandles.map(c => c.high  ?? c.close);
              const recentLows   = rawCandles.map(c => c.low   ?? c.close);
              await this.positionManager.initPosition(order.symbol, posCtx, recentCloses, recentHighs, recentLows);
            } catch (err) {
              log.warn({ symbol: order.symbol, err: err.message },
                'initPosition failed — using config-based fallback levels');
            }
          }

          this.riskManager.addPosition();

          // ROI: track fresh cash deployed for this position (optional — method may not exist)
          const buyTradeSize = order.price * order.quantity;
          this.riskManager.openDeployment?.(buyTradeSize);
          order.capitalDeployed = buyTradeSize;

          if (this.telegram?.enabled) {
            const stopPrice = posCtx.stopPrice;
            const targetPrice = posCtx.profitTargetPrice;
            this.telegram.sendRaw(
              `📦 <b>Position ENTRY — ${order.symbol}</b>\n\n` +
              `📥 Entry:  ₹${order.price.toFixed(2)}\n` +
              `📦 Qty:    ${order.quantity}\n` +
              `🛑 Stop:   ₹${stopPrice.toFixed(2)}\n` +
              `🎯 Target: ₹${targetPrice.toFixed(2)}\n` +
              `🧠 Strats: ${strategies.join(', ')}\n` +
              `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
            ).catch(() => { });
          }

          // Fix BUG-19: store openOrderId so _persistTrade can UPDATE by order_id
          posCtx.openOrderId = order.id;

          } // end if (existingPos?.isShort)

        } // end if (order.side === 'BUY')
        else if (order.side === 'SELL') {
          const existingPos = this._filledPositions.get(order.symbol);

          if (existingPos && !existingPos.isShort) {
            // ── Closing an existing LONG position ───────────────────────────
            const posCtx = existingPos;
            const { netPnl, grossPnl, totalCost } = calcNetPnl({
              entryPrice: posCtx.price,
              exitPrice: order.price,
              quantity: posCtx.quantity,
            });
            const pnl = netPnl;
            order.pnl = netPnl;
            order.grossPnl = grossPnl;
            order.costPaid = totalCost;

            await this.riskManager.recordTradePnL(pnl, order.symbol);
            // Pass grossPnl to strategy outcome tracking so paper/live results are comparable
            // (netPnl varies by brokerage; grossPnl reflects the actual trade performance)
            this.recordPositionOutcome(order.symbol, grossPnl).catch((err) =>
              log.warn({ symbol: order.symbol, err: err.message }, 'Position outcome recording failed')
            );
            this._filledPositions.delete(order.symbol);
            this.riskManager.removePosition();

            // ROI: return deployed capital back to the pool (optional — method may not exist)
            const sellTradeSize = posCtx.price * posCtx.quantity;
            this.riskManager.closeDeployment?.(sellTradeSize, pnl);
            const sellTradeRoi = sellTradeSize > 0 ? (pnl / sellTradeSize) * 100 : 0;
            order.tradeRoi = +sellTradeRoi.toFixed(4);
            order.capitalDeployed = sellTradeSize;
            order.isShortClose = false; // this is a long close
            // Fix BUG-19: carry entry order_id forward so _persistTrade can UPDATE by exact row
            order.openEntryOrderId = posCtx.openOrderId ?? null;

            if (this.telegram?.enabled) {
              const emoji = pnl >= 0 ? '✅' : '🛑';
              // Fix 39: P&L → P&amp;L (was unescaped & causing silent Telegram drop)
              const pnlStr = pnl >= 0
                ? `+₹${pnl.toFixed(2)}`
                : `-₹${Math.abs(pnl).toFixed(2)}`;
              const roiStr = order.tradeRoi >= 0
                ? `+${order.tradeRoi.toFixed(2)}%`
                : `${order.tradeRoi.toFixed(2)}%`;
              this.telegram.sendRaw(
                `${emoji} <b>Position EXIT — ${order.symbol}</b>\n\n` +
                `📌 Reason: SIGNAL_EXIT\n` +
                `📥 Entry:  ₹${posCtx.price.toFixed(2)}\n` +
                `📤 Exit:   ₹${order.price.toFixed(2)}\n` +
                `💰 Net P&amp;L: ${pnlStr}\n` +
                `📈 Trade ROI: ${roiStr}\n` +
                `💵 Deployed:  ₹${sellTradeSize.toLocaleString('en-IN')}\n` +
                `📊 Gross:    ${order.grossPnl >= 0 ? '+' : ''}₹${Math.abs(order.grossPnl || pnl).toFixed(2)}\n` +
                `💸 Charges:  ₹${(order.costPaid || 0).toFixed(2)}\n` +
                `📦 Qty:    ${posCtx.quantity}\n` +
                `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
              ).catch(() => { });
            }

          } else if (!existingPos) {
            // ── Opening a NEW SHORT position ─────────────────────────────────
            const strategies = this._lastSignalStrategies.get(order.symbol) || [];
            const stopPct = this._config?.STOP_LOSS_PCT ?? 1.0;
            const trailPct = this._config?.TRAILING_STOP_PCT ?? 1.5;
            const targetPct = this._config?.PROFIT_TARGET_PCT ?? 1.8;

            // Fix Bug 13: Determine strategy-aware profit target mode BEFORE building shortCtx.
            // RSI_MEAN_REVERSION targets a mean-reversion band (FIXED_PCT);
            // all other strategies use risk:reward ratio (RISK_REWARD).
            const SHORT_FIXED_PCT_STRATEGIES = new Set(['RSI_MEAN_REVERSION']);
            const shortProfitTargetMode = strategies.some(s => SHORT_FIXED_PCT_STRATEGIES.has(s))
              ? 'FIXED_PCT'
              : 'RISK_REWARD';

            const shortCtx = {
              direction: 'SELL',
              isShort: true,
              strategies,
              openingStrategy: strategies[0] || 'UNKNOWN',
              entryPrice: order.price,
              price: order.price,
              quantity: order.quantity,
              timestamp: Date.now(),

              // SHORT stop: ABOVE entry
              stopPrice: order.price * (1 + stopPct / 100),
              // SHORT trail: starts above entry, ratchets DOWN
              highWaterMark: order.price,   // for shorts = low-water mark
              trailStopPrice: order.price * (1 + trailPct / 100),
              trailPct,
              stopPct,

              // SHORT profit target: BELOW entry
              profitTargetPrice: order.price * (1 - targetPct / 100),
              profitTargetMode: shortProfitTargetMode,  // Fix Bug 13
              riskRewardRatio: this._config?.RISK_REWARD_RATIO ?? 2.0,  // FIX: was undefined → 'undefined× R/R' in Telegram
              partialExitEnabled: this._config?.PARTIAL_EXIT_ENABLED ?? true,
              partialExitDone: false,
              partialExitQty: 0,
              signalReversalEnabled: this._config?.SIGNAL_REVERSAL_ENABLED ?? true,
            };

            this._filledPositions.set(order.symbol, shortCtx);
            this.riskManager.addPosition();

            // Fix BUG-19: store openOrderId for short entry
            shortCtx.openOrderId = order.id;

            // ROI: track fresh cash deployed for this short position (optional — method may not exist)
            const shortTradeSize = order.price * order.quantity;
            this.riskManager.openDeployment?.(shortTradeSize);
            order.capitalDeployed = shortTradeSize;

            // Initialise exit levels via position manager (ATR-based trail etc.)
            if (this.positionManager) {
              try {
                const rawCandles = this._fetchCandles
                  ? await this._fetchCandles(order.symbol, 20).catch(() => [])
                  : [];
                // Fix: initPosition expects separate close/high/low arrays, not candle objects
                const recentCloses = rawCandles.map(c => c.close);
                const recentHighs  = rawCandles.map(c => c.high  ?? c.close);
                const recentLows   = rawCandles.map(c => c.low   ?? c.close);
                await this.positionManager.initPosition(order.symbol, shortCtx, recentCloses, recentHighs, recentLows);
              } catch (err) {
                log.warn({ symbol: order.symbol, err: err.message },
                  'initPosition failed for short — using config-based levels');
              }
            }

            if (this.telegram?.enabled) {
              const stopPrice = shortCtx.stopPrice;
              const targetPrice = shortCtx.profitTargetPrice;
              this.telegram.sendRaw(
                `📉 <b>SHORT Position ENTRY — ${order.symbol}</b>\n\n` +
                `📤 Entry:  ₹${order.price.toFixed(2)}\n` +
                `📦 Qty:    ${order.quantity}\n` +
                `🛑 Stop:   ₹${stopPrice.toFixed(2)} (above entry)\n` +
                `🎯 Target: ₹${targetPrice.toFixed(2)} (below entry)\n` +
                `🧠 Strats: ${strategies.join(', ')}\n` +
                `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
              ).catch(() => { });
            }
          }

        }

        await this._persistTrade(order).catch((err) =>
          log.error({ orderId: order.id, err: err.message }, 'Failed to persist trade to DB')
        );

        return order;

      } catch (err) {
        lastError = err;
        log.error({
          orderId: order.id, attempt, maxRetries: this.maxRetries,
          error: err.message,
          brokerResponse: err.response?.data || null,
          statusCode: err.response?.status || null,
          retryable: this._isRetryable(err),
        }, `Broker placement failed (attempt ${attempt}/${this.maxRetries})`);

        if (!this._isRetryable(err)) {
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
      rejectionReason: `Broker unreachable after ${this.maxRetries} retries: ${lastError?.message} `,
    });
    return order;
  }

  /** @private */
  _isRetryable(err) {
    const RETRYABLE_CODES = ['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE', 'EHOSTUNREACH'];
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
    return { orderId: `PAPER - ${order.id} `, status: 'COMPLETE', broker: 'paper' };
  }

  /** @private */
  async _livePlaceOrder(order, { emergency = false } = {}) {
    if (!this.broker) throw new Error('Live trading requires a broker instance');

    const placeFn = emergency
      ? (params) => this.broker.placeEmergencyOrder(params) // C3 FIX: bypass circuit breaker
      : (params) => this.broker.placeOrder(params);

    const response = await placeFn({
      symbol: order.symbol,
      exchange: order.exchange,
      side: order.side,
      quantity: order.quantity,
      orderType: order.orderType,
      price: order.price,
      product: order.product,
    });

    // M6 FIX: handle null orderId safely
    const brokerOrderId = response?.order_id || response?.orderId || response?.orderid || null;
    if (!brokerOrderId) {
      log.error({
        localOrderId: order.id,
        symbol: order.symbol,
        side: order.side,
        rawResponse: JSON.stringify(response).slice(0, 200),
      }, 'M6: Broker returned no order ID — cannot confirm fill or fetch price. ' +
      'Position tracked at scan-time price. Manual reconciliation required.');
      return { orderId: null };
    }

    // Capture scan-time price before overwriting for logging
    const scanTimePrice = order.price;
    const maxAttempts = 4;
    let fillPrice = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const history = await this.broker.getOrderHistory(brokerOrderId);
        const fetchedPrice = history?.average_price
          || (Array.isArray(history) ? history[history.length - 1]?.average_price : null)
          || null;

        if (fetchedPrice && fetchedPrice > 0) {
          fillPrice = fetchedPrice;
          log.info({
            orderId: brokerOrderId,
            fillPrice,
            scanPrice: scanTimePrice,
            attempts: attempt,
          }, 'Fill price fetched — overwriting scan-time price');
          order.price = fillPrice;
          break;
        }
      } catch (err) {
        if (err.response?.status !== 404 && err.statusCode !== 404) throw err;
      }

      if (attempt < maxAttempts) await this._delay(400);
    }

    if (!fillPrice) {
      log.warn({
        orderId: brokerOrderId,
        attempts: maxAttempts,
        fallback: 'scan-time price',
      }, 'Could not fetch fill price — using scan-time price');
    }

    return { orderId: brokerOrderId };
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
        timeZone: 'Asia/Kolkata', year: 'numeric', month: '2-digit', day: '2-digit',
      });
      const todayIST = formatter.format(new Date());

      for (const [symbol, posCtx] of this._filledPositions.entries()) {
        const posDateIST = formatter.format(new Date(posCtx.timestamp));
        if (posDateIST === todayIST && !brokerSymbols.has(symbol)) {
          log.warn(`Position reconciliation: ${symbol} closed externally — removing from engine state`);
          this.markPositionClosed(symbol);
          if (this.riskManager) {
            this.riskManager.removePosition();
            // N9 FIX: record as zero-P&L for daily accounting
            await this.riskManager.recordTradePnL(0, symbol);
          }
          // N9 FIX: notify adaptive weights
          this.recordPositionOutcome(symbol, 0).catch(err =>
            log.warn({ symbol, err: err.message }, 'Outcome recording failed in reconciliation')
          );

          if (this.telegram?.enabled) {
            this.telegram.sendRaw(
              `⚠️ <b>Position Closed Externally — ${symbol}</b>\n` +
              `Removed from engine state via reconciliation.\n` +
              `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} `
            ).catch(() => { });
          }
          reconciled.push(symbol);
        } else {
          stillOpen.push(symbol);
        }
      }

      log.info({ checked: initialPositionCount, reconciled: reconciled.length, stillOpen: stillOpen.length },
        'Position reconciliation complete');

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
    this._recentlyExited.clear();
    log.info('Execution engine daily state reset');
  }

  markPositionClosed(symbol) {
    this._filledPositions.delete(symbol);
  }

  // ═══════════════════════════════════════════════════════
  // PRIVATE HELPERS
  // ═══════════════════════════════════════════════════════

  _delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  /**
   * Persist trade to DB.
   * Fix hydration: also writes opening_strategies as JSON so hydratePositions()
   * can recover clean strategy names after a restart.
   * @private
   */
  async _persistTrade(order) {
    try {
      // Get the clean strategy names for this order (if it was a BUY)
      const openingStrategies = order.side === 'BUY'
        ? JSON.stringify(this._lastSignalStrategies.get(order.symbol) || [])
        : null;

      await query(
        `INSERT INTO trades
  (order_id, symbol, side, quantity, price, pnl, strategy, status, paper_mode, opening_strategies, capital_deployed, created_at)
VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, NOW())
         ON CONFLICT(order_id) DO NOTHING`,
        [
          order.id, order.symbol, order.side, order.quantity,
          order.price, order.pnl || 0, order.strategy, order.state,
          this.paperMode, openingStrategies, order.capitalDeployed ?? null,
        ]
      ).catch(async (err) => {
        // opening_strategies or capital_deployed column may not exist yet — retry without them
        if (err.message?.includes('opening_strategies') || err.message?.includes('capital_deployed') || err.message?.includes('column')) {
          return query(
            `INSERT INTO trades
  (order_id, symbol, side, quantity, price, pnl, strategy, status, paper_mode, created_at)
VALUES($1, $2, $3, $4, $5, $6, $7, $8, $9, NOW())
             ON CONFLICT(order_id) DO NOTHING`,
            [order.id, order.symbol, order.side, order.quantity,
            order.price, order.pnl || 0, order.strategy, order.state, this.paperMode]
          );
        }
        throw err;
      });

      // Fix BUG-19: back-fill trade_roi on the original entry row.
      // For LONG exit (SELL close): entry row has side='BUY', openOrderId stored at BUY fill.
      // For SHORT cover (BUY close): entry row has side='SELL', openOrderId stored at short SELL fill.
      const isSellClose = order.side === 'SELL' && !order.isShortClose;
      const isBuyCover  = order.side === 'BUY'  && order.isShortClose;

      if ((isSellClose || isBuyCover) && order.tradeRoi != null) {
        // Prefer UPDATE by order_id (exact match, immune to race conditions)
        const entryOrderId = order.openEntryOrderId ?? null;  // set from posCtx.openOrderId in close path
        if (entryOrderId) {
          query(
            `UPDATE trades SET trade_roi = $1, gross_pnl = $2 WHERE order_id = $3`,
            [order.tradeRoi, order.grossPnl ?? null, entryOrderId]
          ).catch(err => log.warn({ symbol: order.symbol, err: err.message },
            'Fix BUG-19: trade_roi update by order_id failed'));
        } else {
          // Fallback: symbol+date (used for forceExit paths where openOrderId may be unavailable)
          const entrySide = isBuyCover ? 'SELL' : 'BUY';
          query(
            `UPDATE trades
             SET trade_roi = $1
             WHERE symbol    = $2
               AND side      = $3
               AND status    = 'FILLED'
               AND paper_mode = $4
               AND (created_at AT TIME ZONE 'Asia/Kolkata')::date =
                   (NOW()       AT TIME ZONE 'Asia/Kolkata')::date
             ORDER BY created_at DESC
             LIMIT 1`,
            [order.tradeRoi, order.symbol, entrySide, this.paperMode]
          ).catch(err => log.warn({ symbol: order.symbol, err: err.message },
            'Fix BUG-19 fallback: trade_roi symbol+date update failed'));
        }
      }

      log.debug({ orderId: order.id, symbol: order.symbol }, 'Trade persisted to DB');
    } catch (err) {
      log.error({ orderId: order.id, err: err.message }, 'CRITICAL: Trade DB write failed');
    }
  }


  /** @private */
  async _persistSignals(symbol, consensus, currentPrice = null) {
    try {
      // Fix: move getPool() inside try/catch so 'pool not initialized' is caught
      // and returns null instead of throwing an uncaught exception (e.g. in tests).
      const pool = getPool();
      const client = await pool.connect();
      try {
        const hasPosition = this._filledPositions.has(symbol);
        await client.query('BEGIN');
        // Fix Bug 8: Prevent slow writes from holding the pool connection indefinitely.
        await client.query("SET LOCAL statement_timeout = 5000");

        for (const detail of (consensus.details || [])) {
          const sig = detail.signal || 'HOLD';
          // Fix Bug 20: Skip HOLD signals unconditionally.
          if (sig === 'HOLD') continue;
          await client.query(
            `INSERT INTO signals(symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
VALUES($1, $2, $3, $4, $5, $6, $7, NOW())`,
            [symbol, detail.strategy || 'unknown', sig,
              detail.confidence || 0, false,
              (detail.reason || '').slice(0, 500), currentPrice || null]
          );
        }

        const conSig = consensus.signal || 'HOLD';
        let consensusSignalId = null;
        if (conSig !== 'HOLD' || this._filledPositions.has(symbol)) {
          const res = await client.query(
            `INSERT INTO signals(symbol, strategy, signal, confidence, acted_on, reason, price, created_at)
VALUES($1, $2, $3, $4, $5, $6, $7, NOW()) RETURNING id`,
            [symbol, 'CONSENSUS', conSig, consensus.confidence || 0,
              false, (consensus.reason || '').slice(0, 500), currentPrice || null]
          );
          consensusSignalId = res.rows?.[0]?.id ?? null;
        }

        await client.query('COMMIT');
        return consensusSignalId;
      } catch (err) {
        await client.query('ROLLBACK').catch(() => { });
        log.error({ symbol, err: err.message }, 'Failed to persist signals to DB');
        return null;
      } finally {
        client.release();
      }
    } catch (err) {
      // Catches getPool() or pool.connect() failures (e.g. pool not initialized in tests)
      log.error({ symbol, err: err.message }, 'Failed to persist signals to DB');
      return null;
    }
  }

  /** @private */
  async _markSignalActedOn(signalId, symbol, signal) {
    try {
      if (signalId) {
        const result = await query(
          `UPDATE signals SET acted_on = true WHERE id = $1`, [signalId]
        );
        if (result.rowCount === 0) {
          log.error({ signalId, symbol }, 'Failed to mark signal acted_on — row not found by ID');
        }
      } else {
        log.warn({ symbol, signal }, 'No signal ID available — falling back to timestamp lookup');
        await query(
          `UPDATE signals SET acted_on = true
           WHERE symbol = $1 AND strategy = 'CONSENSUS' AND signal = $2
             AND created_at = (
  SELECT MAX(created_at) FROM signals
               WHERE symbol = $1 AND strategy = 'CONSENSUS' AND signal = $2
             )`,
          [symbol, signal]
        );
      }
    } catch (err) {
      log.error({ signalId, symbol, err: err.message }, 'CRITICAL: Failed to mark signal as acted_on');
    }
  }

  /** @private */
  async _alertConflict(symbol, consensusResult) {
    const rateLimitKey = `conflict: alerted:${symbol} `;
    try {
      const alreadyAlerted = await this.redis.get(rateLimitKey);
      if (alreadyAlerted) return;
      await this.redis.setex(rateLimitKey, 1800, '1');
      const { buyStrategies, sellStrategies } = consensusResult.conflictDetails;
      const msg =
        `⚡ <b>Signal Conflict — ${symbol}</b>\n\n` +
        `📈 BUY:  ${buyStrategies.join(', ')} \n` +
        `📉 SELL: ${sellStrategies.join(', ')} \n\n` +
        `Result: HOLD(strategies disagree) \n` +
        `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })} `;
      await this.telegram.sendRaw(msg);
      log.info({ symbol, buyStrategies, sellStrategies }, 'Conflict alert sent via Telegram');
    } catch (err) {
      log.warn({ symbol, err: err.message }, 'Conflict alert failed — continuing');
    }
  }
}