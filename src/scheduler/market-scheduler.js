import cron from 'node-cron';
import { createLogger } from '../lib/logger.js';
import { TIMEZONE } from '../config/constants.js';
import { isTradingDay, getMarketStatus } from '../data/market-hours.js';
import { executeSquareOff } from '../risk/square-off-job.js';

const log = createLogger('scheduler');

/**
 * Market Day Scheduler — the nervous system of Quant8.
 *
 * Orchestrates the full daily trading cycle using node-cron
 * with Asia/Kolkata timezone. Each job:
 *   1. Checks kill switch before running
 *   2. Logs start/end with duration
 *   3. Handles errors without crashing other jobs
 *
 * Schedule:
 *   09:00 — Pre-market: health checks + verifyIntegrity
 *   09:15 — Market open: start feeds + activate scanning
 *   Every 5min 09:15–15:10 — Strategy scan loop
 *   15:10 — Square-off warning: log open positions
 *   15:15 — Square-off: close all positions + cancel pending
 *   15:35 — Post-market: daily summary + reset counters
 *
 * @module scheduler
 */

export class MarketScheduler {
  /**
   * @param {Object} deps
   * @param {import('../risk/kill-switch.js').KillSwitch} deps.killSwitch
   * @param {import('../risk/risk-manager.js').RiskManager} deps.riskManager
   * @param {import('../engine/execution-engine.js').ExecutionEngine} deps.engine
   * @param {Object} [deps.broker] - BrokerManager instance
   * @param {Object} [deps.dataFeed] - TickFeed or data feed manager
   * @param {Function} [deps.getWatchlist] - Returns array of { symbol, candles, price, quantity }
   * @param {Function} [deps.getOpenPositions] - Returns array of open positions
   * @param {Function} [deps.sendReport] - Sends daily summary (e.g., Telegram)
   * @param {Function} [deps.healthCheck] - Returns { broker, redis, db } health status
   */
  constructor(deps) {
    this.killSwitch = deps.killSwitch;
    this.riskManager = deps.riskManager;
    this.engine = deps.engine;
    this.broker = deps.broker || null;
    this.dataFeed = deps.dataFeed || null;
    this.getWatchlist = deps.getWatchlist || (async () => []);
    this.getOpenPositions = deps.getOpenPositions || (async () => []);
    this.sendReport = deps.sendReport || (async () => {});
    this.healthCheck = deps.healthCheck || (async () => ({ broker: true, redis: true, db: true }));

    /** @type {cron.ScheduledTask[]} */
    this._cronJobs = [];

    /** @type {boolean} */
    this._scanning = false;

    /** @type {boolean} H5: Prevent overlapping scans */
    this._scanInProgress = false;

    log.info('MarketScheduler created');
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  /**
   * Start all scheduled jobs.
   */
  start() {
    const opts = { timezone: TIMEZONE };

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
    // H7: Last scan at 15:05, not 15:10 (avoid race with squareoff-warning at 15:10)
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

    log.info({
      jobs: this._cronJobs.length,
      timezone: TIMEZONE,
    }, '🕐 MarketScheduler started — all jobs scheduled');
  }

  /**
   * Stop all scheduled jobs.
   */
  stop() {
    for (const job of this._cronJobs) {
      job.stop();
    }
    this._cronJobs = [];
    this._scanning = false;
    log.info('MarketScheduler stopped — all jobs cancelled');
  }

  // ═══════════════════════════════════════════════════════
  // JOB WRAPPER — kill switch guard + timing + error isolation
  // ═══════════════════════════════════════════════════════

  /**
   * Run a job with kill switch check, timing, and error isolation.
   * @private
   * @param {string} jobName
   * @param {Function} fn - Async job function
   */
  async _runJob(jobName, fn) {
    // Skip on non-trading days
    if (!isTradingDay()) {
      log.info({ job: jobName }, 'Job skipped — not a trading day');
      return { skipped: true, reason: 'not_trading_day' };
    }

    // Kill switch guard (allow post-market and square-off even when engaged)
    const bypassJobs = ['post-market', 'square-off', 'squareoff-warning'];
    if (this.killSwitch.isEngaged() && !bypassJobs.includes(jobName)) {
      log.warn({ job: jobName }, `Job skipped — kill switch ENGAGED`);
      return { skipped: true, reason: 'kill_switch_engaged' };
    }

    const startTime = Date.now();
    log.info({ job: jobName }, `▶ Job [${jobName}] STARTING`);

    try {
      const result = await fn();
      const durationMs = Date.now() - startTime;
      log.info({
        job: jobName,
        durationMs,
        durationSec: +(durationMs / 1000).toFixed(2),
      }, `✅ Job [${jobName}] COMPLETED in ${(durationMs / 1000).toFixed(2)}s`);

      return { skipped: false, durationMs, result };
    } catch (err) {
      const durationMs = Date.now() - startTime;
      log.error({
        job: jobName,
        err: err.message,
        stack: err.stack,
        durationMs,
      }, `❌ Job [${jobName}] FAILED after ${(durationMs / 1000).toFixed(2)}s: ${err.message}`);

      // Never rethrow — other jobs must continue
      return { skipped: false, durationMs, error: err.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  // JOB IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════

  /**
   * Job 1: Pre-market (9:00 AM IST)
   * Validate broker connection, check Redis/DB health, verify kill switch.
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

    const status = getMarketStatus();
    log.info({ status }, '═══ PRE-MARKET COMPLETE ═══');

    return { healthy: true, health, integrity, engineReady: engineResult.ready };
  }

  /**
   * Job 2: Market Open (9:15 AM IST)
   * Start market data feeds and activate strategy scanning.
   * @private
   */
  async _marketOpen() {
    log.info('═══ MARKET OPEN ═══');

    // Start data feed if available
    if (this.dataFeed && typeof this.dataFeed.connect === 'function') {
      try {
        await this.dataFeed.connect();
        log.info('Market data feed connected');
      } catch (err) {
        log.error({ err: err.message }, 'Failed to connect data feed — continuing without live data');
      }
    }

    // Activate scanning
    this._scanning = true;
    log.info('Strategy scanning ACTIVATED');

    return { scanning: true };
  }

  /**
   * Job 3: Strategy Scan (every 5 minutes, 9:15 AM – 3:10 PM IST)
   * Run all strategies on watchlist, feed signals to execution engine.
   * @private
   */
  async _strategyScan() {
    if (!this._scanning) {
      log.info('Strategy scan skipped — scanning not active');
      return { scanned: 0 };
    }

    // H5: Overlap guard — skip if previous scan still running
    if (this._scanInProgress) {
      log.warn('Strategy scan skipped — previous scan still in progress');
      return { scanned: 0, reason: 'overlap' };
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
          });

          if (result.action === 'EXECUTED') {
            log.info({
              symbol: item.symbol,
              signal: result.consensus?.signal,
              orderId: result.order?.id,
            }, `🔔 Trade executed: ${item.symbol}`);
          }
        } catch (err) {
          log.error({
            symbol: item.symbol,
            err: err.message,
          }, `Strategy scan failed for ${item.symbol}`);
          results.push({ symbol: item.symbol, action: 'ERROR', error: err.message });
        }
      }

      log.info({
        scanned: watchlist.length,
        executed: results.filter((r) => r.action === 'EXECUTED').length,
      }, 'Strategy scan complete');

      return { scanned: watchlist.length, results };
    } finally {
      this._scanInProgress = false; // H5: ALWAYS release mutex
    }
  }

  /**
   * Job 4: Square-off Warning (3:10 PM IST)
   * Log all open positions, prepare for close.
   * @private
   */
  async _squareOffWarning() {
    log.warn('═══ ⚠ SQUARE-OFF WARNING — T-5 minutes ═══');

    // Stop scanning — no new trades
    this._scanning = false;
    log.info('Strategy scanning DEACTIVATED — approaching square-off');

    const positions = await this.getOpenPositions();

    log.warn({
      openCount: positions.length,
      positions: positions.map((p) => ({
        symbol: p.symbol || p.tradingsymbol,
        qty: p.quantity || p.netQuantity,
        side: (p.quantity || p.netQuantity || 0) > 0 ? 'LONG' : 'SHORT',
      })),
    }, 'Open positions entering square-off window');

    // List pending orders
    const activeOrders = this.engine.getActiveOrders();
    if (activeOrders.length > 0) {
      log.warn({
        pendingCount: activeOrders.length,
      }, 'Active orders will be cancelled at 3:15 PM');
    }

    return { positions: positions.length, activeOrders: activeOrders.length };
  }

  /**
   * Job 5: Square-off (3:15 PM IST)
   * Trigger square-off-job.js and cancel all pending orders.
   * @private
   */
  async _squareOff() {
    log.warn('═══ AUTO SQUARE-OFF TRIGGERED ═══');

    // Cancel all pending/placed orders
    const activeOrders = this.engine.getActiveOrders();
    let cancelled = 0;

    for (const order of activeOrders) {
      const result = this.engine.cancelOrder(order.id);
      if (result && result.state === 'CANCELLED') {
        cancelled++;
      }
    }

    if (cancelled > 0) {
      log.warn({ cancelled }, `Cancelled ${cancelled} active orders`);
    }

    // Execute square-off
    const squareOffResult = await executeSquareOff({
      broker: this.broker,
      riskManager: this.riskManager,
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
   * Generate daily summary, send report, reset counters.
   * @private
   */
  async _postMarket() {
    log.info('═══ POST-MARKET PROCESSING ═══');

    // Disconnect data feed
    if (this.dataFeed && typeof this.dataFeed.disconnect === 'function') {
      try {
        await this.dataFeed.disconnect();
        log.info('Market data feed disconnected');
      } catch (err) {
        log.error({ err: err.message }, 'Failed to disconnect data feed');
      }
    }

    // Generate daily summary
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
    };

    log.info({
      summary,
    }, '📊 DAILY SUMMARY');

    // Send report (Telegram, etc.)
    try {
      await this.sendReport(summary);
      log.info('Daily report sent');
    } catch (err) {
      log.error({ err: err.message }, 'Failed to send daily report');
    }

    // Reset daily counters
    this.riskManager.resetDaily();
    this.engine.resetDaily();
    log.info('Risk manager and engine daily counters reset');

    this._scanning = false;

    log.info('═══ POST-MARKET COMPLETE ═══');
    return summary;
  }

  // ═══════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════

  /**
   * Get scheduler status.
   * @returns {Object}
   */
  getStatus() {
    return {
      activeJobs: this._cronJobs.length,
      scanning: this._scanning,
      marketStatus: getMarketStatus(),
      killSwitchEngaged: this.killSwitch.isEngaged(),
    };
  }
}
