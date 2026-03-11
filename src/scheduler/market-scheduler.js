import cron from 'node-cron';
import { createLogger } from '../lib/logger.js';
import { TIMEZONE } from '../config/constants.js';
import { isTradingDay, getMarketStatus } from '../data/market-hours.js';
import { executeSquareOff } from '../risk/square-off-job.js';

const log = createLogger('scheduler');

/**
 * Market Day Scheduler — the nervous system of Alpha8.
 *
 * Orchestrates the full daily trading cycle using node-cron
 * with Asia/Kolkata timezone. Each job:
 *   1. Checks kill switch before running
 *   2. Logs start/end with duration
 *   3. Handles errors without crashing other jobs
 *
 * Schedule:
 *   08:55 Sun — Weekly maintenance: update adaptive strategy weights
 *   09:00 — Pre-market: health checks + verifyIntegrity + pipeline warm-up
 *   09:15 — Market open: start feeds + activate scanning
 *   Every 5min 09:15–15:10 — Strategy scan loop
 *   15:10 — Square-off warning: log open positions
 *   15:15 — Square-off: close all positions + cancel pending
 *   15:35 — Post-market: daily summary + reset counters
 *   20:00 Mon-Fri — Nightly symbol scout: auto-update dynamic watchlist
 *
 * @module scheduler
 */

export class MarketScheduler {
  /**
   * @param {Object} deps
   * @param {import('../risk/kill-switch.js').KillSwitch}                             deps.killSwitch
   * @param {import('../risk/risk-manager.js').RiskManager}                           deps.riskManager
   * @param {import('../engine/execution-engine.js').ExecutionEngine}                 deps.engine
   * @param {import('../intelligence/enhanced-pipeline.js').EnhancedSignalPipeline}  [deps.pipeline]
   * @param {import('../intelligence/symbol-scout.js').SymbolScout}                  [deps.scout]
   * @param {import('../intelligence/shadow-recorder.js').ShadowRecorder} [deps.shadowRecorder]
   * @param {Object}   [deps.broker]
   * @param {Object}   [deps.dataFeed]
   * @param {Function} [deps.getWatchlist]      - Returns [{ symbol, candles, price, quantity }]
   * @param {Function} [deps.getNiftyCandles]   - Returns daily Nifty 50 candles for regime detector
   * @param {Function} [deps.getOpenPositions]
   * @param {Function} [deps.sendReport]
   * @param {Function} [deps.healthCheck]
   */
  constructor(deps) {
    this.killSwitch = deps.killSwitch;
    this.riskManager = deps.riskManager;
    this.engine = deps.engine;
    this.pipeline = deps.pipeline || null;
    this.scout = deps.scout || null;   // ← NEW
    this.shadowRecorder = deps.shadowRecorder || null;
    this.intradayDecay = deps.intradayDecay || null;
    this.broker = deps.broker || null;
    this.dataFeed = deps.dataFeed || null;
    this.getWatchlist = deps.getWatchlist || (async () => []);
    this.getNiftyCandles = deps.getNiftyCandles || (async () => []);
    this.getOpenPositions = deps.getOpenPositions || (async () => []);
    this.sendReport = deps.sendReport || (async () => { });
    this.healthCheck = deps.healthCheck || (async () => ({ broker: true, redis: true, db: true }));

    /** @type {cron.ScheduledTask[]} */
    this._cronJobs = [];

    /** @type {boolean} */
    this._scanning = false;

    /** @type {boolean} Prevent overlapping scans */
    this._scanInProgress = false;

    log.info('MarketScheduler created');
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  start() {
    const opts = { timezone: TIMEZONE };

    // 0. Weekly maintenance: Sunday 8:55 AM IST — update adaptive weights
    this._cronJobs.push(
      cron.schedule('55 8 * * 0', () => this._runJob('weekly-maintenance', () => this._weeklyMaintenance()), opts)
    );

    // 1. Pre-market: 9:00 AM IST
    this._cronJobs.push(
      cron.schedule('0 9 * * 1-5', () => this._runJob('pre-market', () => this._preMarket()), opts)
    );

    // 2. Market open: 9:15 AM IST
    this._cronJobs.push(
      cron.schedule('15 9 * * 1-5', () => this._runJob('market-open', () => this._marketOpen()), opts)
    );

    // 3. Strategy scan: every 5 minutes, 9:15 AM – 3:10 PM IST (Mon–Fri)
    this._cronJobs.push(
      cron.schedule('15,20,25,30,35,40,45,50,55 9 * * 1-5', () => this._runJob('strategy-scan', () => this._strategyScan()), opts)
    );
    this._cronJobs.push(
      cron.schedule('0,5,10,15,20,25,30,35,40,45,50,55 10-14 * * 1-5', () => this._runJob('strategy-scan', () => this._strategyScan()), opts)
    );
    this._cronJobs.push(
      cron.schedule('0,5 15 * * 1-5', () => this._runJob('strategy-scan', () => this._strategyScan()), opts)
    );

    // 4. Square-off warning: 3:10 PM IST
    this._cronJobs.push(
      cron.schedule('10 15 * * 1-5', () => this._runJob('squareoff-warning', () => this._squareOffWarning()), opts)
    );

    // 5. Square-off: 3:15 PM IST
    this._cronJobs.push(
      cron.schedule('15 15 * * 1-5', () => this._runJob('square-off', () => this._squareOff()), opts)
    );

    // 6. Post-market: 3:35 PM IST
    this._cronJobs.push(
      cron.schedule('35 15 * * 1-5', () => this._runJob('post-market', () => this._postMarket()), opts)
    );

    // 7. Nightly symbol scout: 8:00 PM IST Mon–Fri  ← NEW
    //    Runs AFTER market close — safe to hit Yahoo Finance without disrupting live data
    this._cronJobs.push(
      cron.schedule('0 20 * * 1-5', () => this._runJob('symbol-scout', () => this._nightlyScout()), opts)
    );

    // 8. Catch-up: Check if app was started mid-day during market hours
    const status = getMarketStatus();
    if (status.isOpen) {
      log.info('App started mid-day during market runs. Trigerring market open routines now.');
      this._runJob('market-open', () => this._marketOpen());
    }

    // 9. Shadow signal price fill — every 30min during market hours
    //    Fills in price_after_15min / price_after_30min / price_after_60min
    //    for shadow signals recorded in the last 60 minutes.
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('shadow-fill', () => this._shadowFill()), opts)
    );

    // 10. Shadow signal EOD fill — 4:00 PM IST
    //    One final pass to capture end-of-day prices for all today's signals.
    this._cronJobs.push(
      cron.schedule('0 16 * * 1-5', () =>
        this._runJob('shadow-fill-eod', () => this._shadowFill()), opts)
    );

    log.info({ jobs: this._cronJobs.length, timezone: TIMEZONE },
      '🕐 MarketScheduler started — all jobs scheduled (shadow fill @ every 30min + 16:00 IST)');
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
    // Symbol scout and weekly-maintenance can run on non-trading days too
    const nonTradingAllowed = ['weekly-maintenance', 'symbol-scout'];
    if (!isTradingDay() && !nonTradingAllowed.includes(jobName)) {
      log.info({ job: jobName }, 'Job skipped — not a trading day');
      return { skipped: true, reason: 'not_trading_day' };
    }

    const bypassJobs = ['post-market', 'square-off', 'squareoff-warning', 'weekly-maintenance', 'symbol-scout'];
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
        `❌ Job [${jobName}] FAILED after ${(durationMs / 1000).toFixed(2)}s: ${err.message}`);
      return { skipped: false, durationMs, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  // JOB IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Job 0: Weekly maintenance (Sunday 8:55 AM IST)
   * Updates adaptive strategy weights from last 2 weeks of signal outcomes.
   * @private
   */
  async _weeklyMaintenance() {
    log.info('═══ WEEKLY MAINTENANCE ═══');

    if (this.pipeline) {
      await this.pipeline.weeklyMaintenance();
      log.info('Adaptive strategy weights updated');
    } else {
      log.info('Pipeline not enabled — weekly maintenance skipped');
    }

    log.info('═══ WEEKLY MAINTENANCE COMPLETE ═══');
    return { done: true };
  }

  /**
   * Job 1: Pre-market (9:00 AM IST)
   * Health checks, kill switch verification, pipeline warm-up.
   * @private
   */
  async _preMarket() {
    log.info('═══ PRE-MARKET CHECKS ═══');

    // Health check
    const health = await this.healthCheck();
    log.info({ health }, 'Infrastructure health check');

    if (!health.broker || !health.redis || !health.db) {
      log.error({ health }, '⚠ Infrastructure unhealthy — engaging kill switch');
      await this.killSwitch.engage(
        `Pre-market health check failed: broker=${health.broker}, redis=${health.redis}, db=${health.db}`
      );
      return { healthy: false, health };
    }

    // Kill switch integrity
    const integrity = await this.killSwitch.verifyIntegrity();
    log.info({ integrity }, 'Kill switch integrity verified');

    // Initialize execution engine
    const engineResult = await this.engine.initialize();
    log.info({ engineReady: engineResult.ready }, 'Execution engine status');

    // Pipeline warm-up: pre-fetch trend data + compute regime
    if (this.pipeline) {
      try {
        const watchlist = await this.getWatchlist();
        const symbols = watchlist.map(w => w.symbol).filter(Boolean);
        const niftyCandles = await this.getNiftyCandles().catch(err => {
          log.warn({ err: err.message }, 'Failed to fetch Nifty candles for regime detector');
          return [];
        });

        await this.pipeline.warmUp(symbols, niftyCandles);
        log.info({ symbols: symbols.length, niftyCandles: niftyCandles.length },
          '✅ Pipeline warm-up complete');
      } catch (err) {
        log.warn({ err: err.message }, '⚠ Pipeline warm-up failed — continuing (fail-open)');
      }
    }

    const status = getMarketStatus();
    log.info({ status }, '═══ PRE-MARKET COMPLETE ═══');

    return { healthy: true, health, integrity, engineReady: engineResult.ready };
  }

  /**
   * Job 2: Market Open (9:15 AM IST)
   * Start market data feeds, activate scanning.
   * @private
   */
  async _marketOpen() {
    log.info('═══ MARKET OPEN ═══');

    // Feature 7: Reset intraday wrong-signal counters before first scan
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
      this.engine.reconcilePositions(this.broker).catch(err => log.warn({ err: err.message }, 'Reconciliation failed at market open'));
    }

    return { scanning: true };
  }

  /**
   * Job 3: Strategy Scan (every 5 minutes, 9:15 AM – 3:10 PM IST)
   * @private
   */
  async _strategyScan() {
    if (!this._scanning) {
      log.info('Strategy scan skipped — scanning not active');
      return { scanned: 0 };
    }

    if (this._scanInProgress) {
      log.warn('Strategy scan skipped — previous scan still in progress');
      return { scanned: 0, reason: 'overlap' };
    }

    this._scanCount = (this._scanCount || 0) + 1;
    if (this._scanCount % 6 === 0) {
      if (this.engine.reconcilePositions) {
        this.engine.reconcilePositions(this.broker).catch(err => log.warn({ err: err.message }, 'Reconciliation failed during scan'));
      }
    }

    this._scanInProgress = true;

    try {
      const watchlist = await this.getWatchlist();

      if (!watchlist || watchlist.length === 0) {
        log.info('Strategy scan — empty watchlist');
        return { scanned: 0 };
      }

      const results = [];

      for (const item of watchlist) {
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
            log.info({
              symbol: item.symbol,
              signal: result.consensus?.signal,
              orderId: result.order?.id,
            }, `🔔 Trade executed: ${item.symbol}`);
          } else if (result.action?.startsWith('BLOCKED:')) {
            log.info({
              symbol: item.symbol,
              blockedBy: result.action.replace('BLOCKED:', ''),
              pipelineLog: result.pipelineLog,
            }, `🚫 Signal blocked: ${item.symbol}`);
          }
        } catch (err) {
          log.error({ symbol: item.symbol, err: err.message },
            `Strategy scan failed for ${item.symbol}`);
          results.push({ symbol: item.symbol, action: 'ERROR', error: err.message });
        }
      }

      log.info({
        scanned: watchlist.length,
        executed: results.filter(r => r.action === 'EXECUTED').length,
        blocked: results.filter(r => r.action?.startsWith('BLOCKED:')).length,
      }, 'Strategy scan complete');

      return { scanned: watchlist.length, results };
    } finally {
      this._scanInProgress = false;
    }
  }

  /**
   * Job 4: Square-off Warning (3:10 PM IST)
   * @private
   */
  async _squareOffWarning() {
    log.warn('═══ ⚠ SQUARE-OFF WARNING — T-5 minutes ═══');

    this._scanning = false;
    log.info('Strategy scanning DEACTIVATED — approaching square-off');

    const positions = await this.getOpenPositions();
    log.warn({
      openCount: positions.length,
      positions: positions.map(p => ({
        symbol: p.symbol || p.tradingsymbol,
        qty: p.quantity || p.netQuantity,
        side: (p.quantity || p.netQuantity || 0) > 0 ? 'LONG' : 'SHORT',
      })),
    }, 'Open positions entering square-off window');

    const activeOrders = this.engine.getActiveOrders();
    if (activeOrders.length > 0) {
      log.warn({ pendingCount: activeOrders.length }, 'Active orders will be cancelled at 3:15 PM');
    }

    return { positions: positions.length, activeOrders: activeOrders.length };
  }

  /**
   * Job 5: Square-off (3:15 PM IST)
   * @private
   */
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

  /**
   * Job 6: Post-market (3:35 PM IST)
   * @private
   */
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

    log.info('═══ POST-MARKET COMPLETE ═══');
    return summary;
  }

  /**
   * Job 7: Nightly Symbol Scout (8:00 PM IST, Mon–Fri)  ← NEW
   *
   * Scans the full NSE universe, scores each symbol, and auto-updates
   * the dynamic watchlist in the database. Sends Telegram summary.
   * @private
   */
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

      // Log watchlist changes to main log for visibility
      if (result.added?.length > 0) {
        log.info({ symbols: result.added.map(a => `${a.symbol}(${a.score})`) },
          '➕ Scout added to watchlist');
      }
      if (result.removed?.length > 0) {
        log.info({ symbols: result.removed.map(r => `${r.symbol}: ${r.reason}`) },
          '➖ Scout removed from watchlist');
      }

      return result;
    } catch (err) {
      log.error({ err: err.message }, '❌ Nightly symbol scout failed');
      throw err; // Let _runJob handle and log it
    }
  }

  /**
   * Job 9/10: Shadow Signal Price Fill
   *
   * Runs every 30 minutes during market hours, and once at 4:00 PM IST.
   * Fetches current LTP for all shadow signals that still have NULL price-after
   * columns and are old enough for the reading to be meaningful.
   *
   * This is what makes ShadowRecorder useful — without this job, signals are
   * recorded but never evaluated for directional correctness.
   *
   * @private
   */
  async _shadowFill() {
    if (!this.shadowRecorder) {
      log.debug('Shadow fill skipped — shadowRecorder not configured');
      return { skipped: true };
    }

    try {
      const result = await this.shadowRecorder.fillPriceOutcomes();
      log.info({
        updated: result.updated,
        symbols: result.symbols,
      }, `✅ Shadow fill complete — ${result.updated} rows updated`);
      return result;
    } catch (err) {
      log.error({ err: err.message }, '❌ Shadow fill failed');
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
      marketStatus: getMarketStatus(),
      killSwitchEngaged: this.killSwitch.isEngaged(),
      pipelineEnabled: !!this.pipeline,
      scoutEnabled: !!this.scout,
      shadowRecorderEnabled: !!this.shadowRecorder,
    };
  }
}