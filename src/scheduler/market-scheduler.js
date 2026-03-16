/**
 * @fileoverview Market Scheduler for Alpha8
 *
 * FIXES APPLIED:
 *
 *   Fix 2/latestSignals — Two-phase strategy scan
 *     Signal Reversal exit requires knowing what each strategy is currently
 *     signalling for held symbols. Previously checkAll() was called with no
 *     arguments (latestSignals={}), so reversal exit never fired.
 *     Phase 1 now runs consensus.evaluate() for held symbols to build a
 *     latestSignals map. Phase 2 passes that map to checkAll(). Phase 3
 *     runs full processSignal() for non-held symbols.
 *
 *   Fix 22 — positionManager.checkAll() runs independently of _scanning flag
 *     After _squareOffWarning() sets _scanning=false, _strategyScan() returns
 *     early — skipping checkAll(). Positions were unmonitored 3:10–3:15 PM.
 *     checkAll() is now called in its own dedicated job at 3:12 PM and also
 *     unconditionally at the top of _strategyScan() (before the _scanning check).
 *     The 3:12 PM job specifically handles the post-warning window.
 *
 *   Fix 27 — clearRecentExits() called before each scan
 *     engine.clearRecentExits() is called at the start of Phase 3 so that
 *     the re-entry cooldown set is fresh each scan cycle.
 */

import cron from 'node-cron';
import { createLogger } from '../lib/logger.js';
import { TIMEZONE } from '../config/constants.js';
import { isTradingDay, getMarketStatus } from '../data/market-hours.js';
import { executeSquareOff } from '../risk/square-off-job.js';

const log = createLogger('scheduler');

export class MarketScheduler {
  constructor(deps) {
    this.killSwitch = deps.killSwitch;
    this.riskManager = deps.riskManager;
    this.engine = deps.engine;
    this.pipeline = deps.pipeline || null;
    this.scout = deps.scout || null;
    this.shadowRecorder = deps.shadowRecorder || null;
    this.intradayDecay = deps.intradayDecay || null;
    this.positionManager = deps.positionManager || null;
    this.broker = deps.broker || null;
    this.dataFeed = deps.dataFeed || null;

    this.getWatchlist = deps.getWatchlist || (async () => []);
    this.getNiftyCandles = deps.getNiftyCandles || (async () => []);
    this.getOpenPositions = deps.getOpenPositions || (async () => []);
    this.sendReport = deps.sendReport || (async () => { });
    this.healthCheck = deps.healthCheck || (async () => ({ broker: true, redis: true, db: true }));

    this._cronJobs = [];
    this._scanning = false;
    this._scanInProgress = false;
    this._scanCount = 0;

    log.info('MarketScheduler created');
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  start() {
    const opts = { timezone: TIMEZONE };

    // 0. Weekly maintenance: Sunday 8:55 AM IST
    this._cronJobs.push(
      cron.schedule('55 8 * * 0', () =>
        this._runJob('weekly-maintenance', () => this._weeklyMaintenance()), opts)
    );

    // 1. Pre-market: 9:00 AM IST
    this._cronJobs.push(
      cron.schedule('0 9 * * 1-5', () =>
        this._runJob('pre-market', () => this._preMarket()), opts)
    );

    // 2. Market open: 9:15 AM IST
    this._cronJobs.push(
      cron.schedule('15 9 * * 1-5', () =>
        this._runJob('market-open', () => this._marketOpen()), opts)
    );

    // 3. Strategy scan: every 5 minutes, 9:15 AM – 3:10 PM IST
    this._cronJobs.push(
      cron.schedule('15,20,25,30,35,40,45,50,55 9 * * 1-5', () =>
        this._runJob('strategy-scan', () => this._strategyScan()), opts)
    );
    this._cronJobs.push(
      cron.schedule('0,5,10,15,20,25,30,35,40,45,50,55 10-14 * * 1-5', () =>
        this._runJob('strategy-scan', () => this._strategyScan()), opts)
    );
    this._cronJobs.push(
      cron.schedule('0,5,10 15 * * 1-5', () =>
        this._runJob('strategy-scan', () => this._strategyScan()), opts)
    );

    // 4. Square-off warning: 15:10 IST — deactivates scanning
    this._cronJobs.push(
      cron.schedule('10 15 * * 1-5', () =>
        this._runJob('squareoff-warning', () => this._squareOffWarning()), opts)
    );

    // Fix 22: Position check runs at 3:12 PM to cover the post-warning window.
    // _scanning is false after 3:10 PM so _strategyScan() would skip checkAll().
    // This job ensures stop/trail exits still fire until square-off at 3:15 PM.
    this._cronJobs.push(
      cron.schedule('12 15 * * 1-5', () =>
        this._runJob('position-check-preclose', () => this._positionCheckPreClose()), opts)
    );

    // 5. Square-off: 15:15 IST
    this._cronJobs.push(
      cron.schedule('15 15 * * 1-5', () =>
        this._runJob('square-off', () => this._squareOff()), opts)
    );

    // 6. Post-market: 15:35 IST
    this._cronJobs.push(
      cron.schedule('35 15 * * 1-5', () =>
        this._runJob('post-market', () => this._postMarket()), opts)
    );

    // 7. Nightly symbol scout: 8:00 PM IST Mon–Fri
    this._cronJobs.push(
      cron.schedule('0 20 * * 1-5', () =>
        this._runJob('symbol-scout', () => this._nightlyScout()), opts)
    );

    // 8. Shadow signal price fill + regime update — every 30 min during market hours
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('shadow-fill', () => this._shadowFill()), opts)
    );

    // 9. Shadow signal EOD fill — 4:00 PM IST
    this._cronJobs.push(
      cron.schedule('0 16 * * 1-5', () =>
        this._runJob('shadow-fill-eod', () => this._shadowFill()), opts)
    );

    // 10. Regime detector update — every 30 min during trading hours
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('regime-update', () => this._updateRegime()), opts)
    );

    log.info({ jobs: this._cronJobs.length, timezone: TIMEZONE },
      '🕐 MarketScheduler started — 11 jobs scheduled');

    const status = getMarketStatus();
    if (status.isOpen) {
      log.info('App started mid-day during market hours — triggering market open routines');
      this._runJob('market-open', () => this._marketOpen());
    }
  }

  stop() {
    for (const job of this._cronJobs) job.stop();
    this._cronJobs = [];
    this._scanning = false;
    log.info('MarketScheduler stopped — all jobs cancelled');
  }

  // ═══════════════════════════════════════════════════════
  // JOB WRAPPER
  // ═══════════════════════════════════════════════════════

  async _runJob(jobName, fn) {
    const nonTradingAllowed = ['weekly-maintenance', 'symbol-scout'];
    if (!isTradingDay() && !nonTradingAllowed.includes(jobName)) {
      log.info({ job: jobName }, 'Job skipped — not a trading day');
      return { skipped: true, reason: 'not_trading_day' };
    }

    // Fix 22: position-check-preclose and square-off bypass kill switch
    // (we always want to exit positions and square off even if kill switch is on)
    const bypassJobs = [
      'post-market', 'square-off', 'squareoff-warning',
      'weekly-maintenance', 'symbol-scout',
      'position-check-preclose',  // Fix 22
    ];
    if (this.killSwitch.isEngaged() && !bypassJobs.includes(jobName)) {
      log.warn({ job: jobName }, 'Job skipped — kill switch ENGAGED');
      return { skipped: true, reason: 'kill_switch_engaged' };
    }

    const startTime = Date.now();
    log.info({ job: jobName }, `▶ Job [${jobName}] STARTING`);

    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;
      log.info({ job: jobName, durationMs, durationSec: +(durationMs / 1000).toFixed(2) },
        `✅ Job [${jobName}] COMPLETED in ${(durationMs / 1000).toFixed(2)}s`);
      return { skipped: false, durationMs, result };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      log.error({ job: jobName, err: err.message, stack: err.stack, durationMs },
        `❌ Job [${jobName}] FAILED after ${(durationMs / 1000).toFixed(2)}s`);
      return { skipped: false, durationMs, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  // JOB IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════

  async _weeklyMaintenance() {
    log.info('═══ WEEKLY MAINTENANCE ═══');
    if (this.pipeline) {
      await this.pipeline.weeklyMaintenance();
      log.info('Adaptive strategy weights updated');
    }
    log.info('═══ WEEKLY MAINTENANCE COMPLETE ═══');
    return { done: true };
  }

  async _preMarket() {
    log.info('═══ PRE-MARKET CHECKS ═══');

    const health = await this.healthCheck();
    log.info({ health }, 'Infrastructure health check');

    if (!health.broker || !health.redis || !health.db) {
      log.error({ health }, '⚠ Infrastructure unhealthy — engaging kill switch');
      await this.killSwitch.engage(
        `Pre-market health check failed: broker=${health.broker}, redis=${health.redis}, db=${health.db}`
      );
      return { healthy: false, health };
    }

    if (health.broker && health.brokerTokenValid === false) {
      log.error('⚠ Broker token is invalid or expired — run: npm run login');
    }

    const integrity = await this.killSwitch.verifyIntegrity();
    log.info({ integrity }, 'Kill switch integrity verified');

    const engineResult = await this.engine.initialize();
    log.info({ engineReady: engineResult.ready }, 'Execution engine status');

    if (this.pipeline) {
      try {
        const watchlist = await this.getWatchlist();
        const symbols = watchlist.map(w => w.symbol).filter(Boolean);
        const niftyCandles = await this.getNiftyCandles().catch(err => {
          log.warn({ err: err.message }, 'Failed to fetch Nifty candles for warm-up');
          return [];
        });
        await this.pipeline.warmUp(symbols, niftyCandles);
        log.info({ symbols: symbols.length }, '✅ Pipeline warm-up complete');
      } catch (err) {
        log.warn({ err: err.message }, '⚠ Pipeline warm-up failed — continuing (fail-open)');
      }
    }

    const status = getMarketStatus();
    log.info({ status }, '═══ PRE-MARKET COMPLETE ═══');
    return { healthy: true, health, integrity, engineReady: engineResult.ready };
  }

  async _marketOpen() {
    log.info('═══ MARKET OPEN ═══');

    if (this.intradayDecay) {
      await this.intradayDecay.resetDay().catch(err =>
        log.warn({ err: err.message }, 'Intraday decay reset failed — continuing')
      );
      log.info('Intraday strategy decay counters reset for new session');
    }

    if (this.dataFeed && typeof this.dataFeed.connect === 'function') {
      try {
        await this.dataFeed.connect();
        log.info('Market data feed connected');
      } catch (err) {
        log.error({ err: err.message }, 'Failed to connect data feed — continuing without live data');
      }
    }

    this._scanning = true;
    log.info('Strategy scanning ACTIVATED');

    if (this.engine.reconcilePositions) {
      this.engine.reconcilePositions(this.broker).catch(err =>
        log.warn({ err: err.message }, 'Reconciliation failed at market open')
      );
    }

    return { scanning: true };
  }

  /**
   * Strategy Scan — every 5 minutes during market hours.
   *
   * Fix 2/latestSignals: Two-phase approach so signal reversal exits have
   * current signal data:
   *   Phase 1: For each HELD symbol, run consensus.evaluate() to collect
   *            the current signal for that symbol's opening strategy.
   *            Does NOT execute any orders — evaluation only.
   *   Phase 2: Pass the collected latestSignals map to positionManager.checkAll()
   *            so SIGNAL_REVERSAL exit can compare against live signals.
   *   Phase 3: Run full processSignal() for non-held symbols (entry logic).
   *
   * Fix 22: positionManager.checkAll() is called unconditionally before the
   * _scanning guard so it runs even after _squareOffWarning deactivates scanning.
   * (The dedicated 3:12 PM job provides an additional safety net.)
   *
   * Fix 27: engine.clearRecentExits() is called before Phase 3 so that the
   * re-entry cooldown is fresh each scan cycle (not carried between cycles).
   */
  async _strategyScan() {
    // Fix 22: Run position management BEFORE checking _scanning flag.
    // This ensures stop/trail exits still fire even after scanning is deactivated.
    if (this.positionManager) {
      await this._runPositionChecks();
    }

    if (!this._scanning) {
      log.info('Strategy scan skipped — scanning not active');
      return { scanned: 0 };
    }

    if (this._scanInProgress) {
      log.warn('Strategy scan skipped — previous scan still in progress');
      return { scanned: 0, reason: 'overlap' };
    }

    this._scanInProgress = true;
    this._scanCount++;

    try {
      // Refresh live risk parameters
      if (this.riskManager.refreshLiveSettings) {
        const { changed, overrides } = await this.riskManager.refreshLiveSettings().catch(err => {
          log.warn({ err: err.message }, 'refreshLiveSettings failed — using current values');
          return { changed: false, overrides: {} };
        });
        if (changed) log.info({ overrides }, '⚙️  Risk params refreshed from live settings');
      }

      // Refresh strategy parameters
      if (this.engine?.consensus?.strategies?.length > 0) {
        await Promise.all(
          this.engine.consensus.strategies
            .filter(s => typeof s.refreshParams === 'function')
            .map(s => s.refreshParams().catch(err =>
              log.warn({ strategy: s.name, err: err.message }, 'Strategy refreshParams failed')
            ))
        );
      }

      // Per-scan reconciliation for held positions
      if (this.engine._filledPositions?.size > 0 && this.broker) {
        this.engine.reconcilePositions(this.broker).catch(err =>
          log.warn({ err: err.message }, 'Reconciliation failed during scan')
        );
      }

      const watchlist = await this.getWatchlist();
      if (!watchlist || watchlist.length === 0) {
        log.info('Strategy scan — empty watchlist');
        return { scanned: 0 };
      }

      const heldSymbols = new Set([...this.engine._filledPositions.keys()]);
      const heldItems = watchlist.filter(w => heldSymbols.has(w.symbol));
      const nonHeldItems = watchlist.filter(w => !heldSymbols.has(w.symbol));

      // ── Phase 1: Collect current signals for HELD symbols ────────────────
      // Run consensus.evaluate() only — no orders placed.
      // Builds latestSignals map: { [strategyName]: 'BUY'|'SELL'|'HOLD' }
      const latestSignals = {};

      for (const item of heldItems) {
        try {
          const consensusResult = this.engine.consensus.evaluate(item.candles);
          // Extract per-strategy signal votes from details
          for (const detail of (consensusResult.details || [])) {
            if (detail.strategy && detail.signal) {
              // Only record signals that met their floor and aren't time-suppressed
              // (same filtering as evaluateExits uses internally)
              if (detail.meetsFloor !== false && !detail.suppressedByTime) {
                latestSignals[detail.strategy] = detail.signal;
              }
            }
          }
        } catch (err) {
          log.warn({ symbol: item.symbol, err: err.message },
            'Phase 1 signal collection failed for held symbol — skipping');
        }
      }

      // ── Phase 2: Check exit conditions WITH current signals ──────────────
      // positionManager already ran above via _runPositionChecks().
      // We need to run it again here with the latestSignals map populated.
      // The first run (without latestSignals) handles stop/trail/time exits.
      // This run specifically enables SIGNAL_REVERSAL exits.
      if (this.positionManager && Object.keys(latestSignals).length > 0) {
        const pmResult = await this.positionManager.checkAll({ latestSignals }).catch(err => {
          log.error({ err: err.message }, 'Position manager check (with signals) failed');
          return { checked: 0, exits: [] };
        });

        if (pmResult.exits.length > 0) {
          log.info({
            exits: pmResult.exits.length,
            symbols: pmResult.exits.map(e => `${e.symbol}(${e.reason})`),
          }, '🚨 Signal-reversal exits completed');
        }
      }

      // ── Phase 3: Entry scan for non-held symbols ─────────────────────────
      // Fix 27: Clear recent exits so re-entry cooldown applies only within
      // the current scan cycle, not carried over from the previous one.
      if (typeof this.engine.clearRecentExits === 'function') {
        this.engine.clearRecentExits();
      }

      const results = [];

      for (const item of nonHeldItems) {
        try {
          const result = await this.engine.processSignal(
            item.symbol,
            item.candles,
            item.price,
            item.quantity,
          );

          results.push({
            symbol: item.symbol,
            action: result.action,
            signal: result.consensus?.signal || 'N/A',
            pipelineLog: result.pipelineLog,
          });

          if (result.action === 'EXECUTED') {
            log.info({ symbol: item.symbol, signal: result.consensus?.signal },
              `🔔 Trade executed: ${item.symbol}`);
          } else if (result.action?.startsWith('BLOCKED:')) {
            log.info({ symbol: item.symbol, blockedBy: result.action.replace('BLOCKED:', '') },
              `🚫 Signal blocked: ${item.symbol}`);
          }
        } catch (err) {
          log.error({ symbol: item.symbol, err: err.message },
            `Strategy scan failed for ${item.symbol}`);
          results.push({ symbol: item.symbol, action: 'ERROR', error: err.message });
        }
      }

      log.info({
        scanned: watchlist.length,
        held: heldItems.length,
        executed: results.filter(r => r.action === 'EXECUTED').length,
        blocked: results.filter(r => r.action?.startsWith('BLOCKED:')).length,
      }, 'Strategy scan complete');

      return { scanned: watchlist.length, results };

    } finally {
      this._scanInProgress = false;
    }
  }

  /**
   * Run positionManager.checkAll() without latestSignals.
   * Handles stop-loss, trailing stop, time exits, and profit target.
   * Called at the top of _strategyScan() before the _scanning guard,
   * and separately at 3:12 PM via the dedicated pre-close job.
   * @private
   */
  async _runPositionChecks() {
    if (!this.positionManager) return { checked: 0, exits: [], partials: [] };

    const pmResult = await this.positionManager.checkAll().catch(err => {
      log.error({ err: err.message }, 'Position manager check failed — skipping');
      return { checked: 0, exits: [], partials: [] };
    });

    if (pmResult.exits.length > 0) {
      log.info({
        exits: pmResult.exits.length,
        symbols: pmResult.exits.map(e => `${e.symbol}(${e.reason})`),
      }, '🚨 Position manager exits completed');
    }

    return pmResult;
  }

  /**
   * Fix 22: Dedicated position check at 3:12 PM.
   * After _squareOffWarning() sets _scanning=false, _strategyScan() is no
   * longer called. This job ensures stop-loss and trailing stop exits still
   * fire in the 3:10–3:15 PM window before square-off.
   */
  async _positionCheckPreClose() {
    log.info('═══ POSITION CHECK PRE-CLOSE (3:12 PM) ═══');
    const result = await this._runPositionChecks();
    log.info({ exits: result.exits?.length ?? 0 }, '═══ PRE-CLOSE CHECK COMPLETE ═══');
    return result;
  }

  async _squareOffWarning() {
    log.warn('═══ ⚠ SQUARE-OFF WARNING — T-5 minutes ═══');

    this._scanning = false;
    log.info('Strategy scanning DEACTIVATED — approaching square-off');

    const positions = await this.getOpenPositions();
    const activeOrders = this.engine.getActiveOrders();

    log.warn({
      openCount: positions.length,
      positions: positions.map(p => ({
        symbol: p.symbol || p.tradingsymbol,
        qty: p.quantity || p.netQuantity,
      })),
    }, 'Open positions entering square-off window');

    if (activeOrders.length > 0) {
      log.warn({ pendingCount: activeOrders.length }, 'Active orders will be cancelled at 3:15 PM');
    }

    return { positions: positions.length, activeOrders: activeOrders.length };
  }

  async _squareOff() {
    log.warn('═══ AUTO SQUARE-OFF TRIGGERED ═══');

    const activeOrders = this.engine.getActiveOrders();
    let cancelled = 0;
    for (const order of activeOrders) {
      const result = this.engine.cancelOrder(order.id);
      if (result && result.state === 'CANCELLED') cancelled++;
    }
    if (cancelled > 0) log.warn({ cancelled }, `Cancelled ${cancelled} active orders`);

    const squareOffResult = await executeSquareOff({
      broker: this.broker,
      riskManager: this.riskManager,
      engine: this.engine,
      getOpenPositions: this.getOpenPositions,
    });

    log.warn({
      squaredOff: squareOffResult.squaredOff,
      errors: squareOffResult.errors.length,
      cancelledOrders: cancelled,
    }, '═══ SQUARE-OFF COMPLETE ═══');

    return { ...squareOffResult, cancelledOrders: cancelled };
  }

  async _postMarket() {
    log.info('═══ POST-MARKET PROCESSING ═══');

    if (this.dataFeed && typeof this.dataFeed.disconnect === 'function') {
      try {
        await this.dataFeed.disconnect();
        log.info('Market data feed disconnected');
      } catch (err) {
        log.error({ err: err.message }, 'Failed to disconnect data feed');
      }
    }

    const riskStatus = this.riskManager.getStatus();
    const engineStatus = this.engine.getStatus();

    const summary = {
      date: new Date().toISOString().split('T')[0],
      pnl: riskStatus.dailyPnL,
      drawdownPct: riskStatus.drawdownPct,
      tradeCount: riskStatus.tradeCount,
      totalOrders: engineStatus.totalOrders,
      filled: engineStatus.ordersByState.filled,
      rejected: engineStatus.ordersByState.rejected,
      cancelled: engineStatus.ordersByState.cancelled,
      killSwitchEngaged: riskStatus.killSwitch.engaged,
      pipelineEnabled: engineStatus.pipelineEnabled,
      scoutEnabled: !!this.scout,
    };

    log.info({ summary }, '📊 DAILY SUMMARY');

    try {
      await this.sendReport(summary);
      log.info('Daily report sent');
    } catch (err) {
      log.error({ err: err.message }, 'Failed to send daily report');
    }

    this.riskManager.resetDaily();
    this.engine.resetDaily();
    log.info('Risk manager and engine daily counters reset');

    this._scanning = false;
    this._scanCount = 0;

    log.info('═══ POST-MARKET COMPLETE ═══');
    return summary;
  }

  async _nightlyScout() {
    log.info('═══ NIGHTLY SYMBOL SCOUT ═══');
    if (!this.scout) {
      log.info('Symbol scout not configured — skipping');
      return { skipped: true, reason: 'scout_not_configured' };
    }
    try {
      const result = await this.scout.runNightly();
      log.info({
        scanned: result.scored?.length || 0,
        added: result.added?.length || 0,
        removed: result.removed?.length || 0,
        duration: `${((result.durationMs || 0) / 1000).toFixed(1)}s`,
      }, '✅ Nightly scout complete');
      return result;
    } catch (err) {
      log.error({ err: err.message }, '❌ Nightly symbol scout failed');
      throw err;
    }
  }

  async _shadowFill() {
    if (!this.shadowRecorder) {
      log.debug('Shadow fill skipped — shadowRecorder not configured');
      return { skipped: true };
    }
    try {
      const result = await this.shadowRecorder.fillPriceOutcomes();
      log.info({ updated: result.updated, symbols: result.symbols },
        `✅ Shadow fill complete — ${result.updated} rows updated`);
      return result;
    } catch (err) {
      log.error({ err: err.message }, '❌ Shadow fill failed');
      throw err;
    }
  }

  async _updateRegime() {
    if (!this.pipeline?.regimeDetector) {
      log.debug('Regime update skipped — no regime detector configured');
      return { skipped: true };
    }
    try {
      const niftyCandles = await this.getNiftyCandles().catch(err => {
        log.warn({ err: err.message }, 'Failed to fetch Nifty candles for regime update');
        return [];
      });
      if (niftyCandles.length === 0) {
        log.debug('Regime update skipped — no Nifty candles');
        return { skipped: true, reason: 'no_candles' };
      }
      const regime = await this.pipeline.updateRegime(niftyCandles);
      log.info({
        regime: regime?.regime,
        adx: regime?.adx,
        sizeMultiplier: regime?.positionSizeMultiplier,
      }, `✅ Regime updated: ${regime?.regime || 'unknown'}`);
      return { regime: regime?.regime, done: true };
    } catch (err) {
      log.error({ err: err.message }, '❌ Regime update failed');
      throw err;
    }
  }

  // ═══════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════

  getStatus() {
    return {
      activeJobs: this._cronJobs.length,
      scanning: this._scanning,
      scanCount: this._scanCount,
      marketStatus: getMarketStatus(),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      pipelineEnabled: !!this.pipeline,
      scoutEnabled: !!this.scout,
      shadowRecorderEnabled: !!this.shadowRecorder,
      regimeDetectorEnabled: !!this.pipeline?.regimeDetector,
    };
  }
}