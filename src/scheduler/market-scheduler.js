import cron from 'node-cron';
import { createLogger } from '../lib/logger.js';
import { TIMEZONE } from '../config/constants.js';
import { isTradingDay, getMarketStatus } from '../data/market-hours.js';
import { executeSquareOff } from '../risk/square-off-job.js';

const log = createLogger('scheduler');

/**
 * Market Day Scheduler — the nervous system of Alpha8.
 *
 * FIXES APPLIED:
 *
 *   Fix 1 — Regime detector updated every 30 minutes during trading hours.
 *     Previously computed once at 9:00 AM pre-market (30-min cache TTL),
 *     meaning the regime was always TRENDING after 9:30 AM regardless of
 *     actual market conditions. Now refreshed every 30 minutes via a dedicated
 *     regime-update cron job that runs in parallel with shadow-fill.
 *
 *   Fix 2 — riskManager.refreshLiveSettings() called at start of each scan.
 *     Risk parameters (stop loss %, max positions, etc.) are now pulled from
 *     Redis at the beginning of every scan cycle, so live overrides take effect
 *     within 5 minutes of being set.
 *
 *   Fix 3 — Strategy refreshParams() called at start of each scan.
 *     EMA periods, RSI thresholds, VWAP/Breakout params are now pulled from
 *     Redis each scan cycle. Previously strategies always used constructor
 *     defaults, making the live settings system ineffective for strategy params.
 *
 *   Fix 4 — Position reconciliation runs every scan cycle (was every 6 scans).
 *     Only fires when there are open positions and a broker is available.
 *     Fire-and-forget — never blocks the scan loop.
 */
export class MarketScheduler {
  /**
   * @param {Object} deps
   * @param {import('../risk/kill-switch.js').KillSwitch}                             deps.killSwitch
   * @param {import('../risk/risk-manager.js').RiskManager}                           deps.riskManager
   * @param {import('../engine/execution-engine.js').ExecutionEngine}                 deps.engine
   * @param {import('../intelligence/enhanced-pipeline.js').EnhancedSignalPipeline}  [deps.pipeline]
   * @param {import('../intelligence/symbol-scout.js').SymbolScout}                  [deps.scout]
   * @param {import('../intelligence/shadow-recorder.js').ShadowRecorder}            [deps.shadowRecorder]
   * @param {import('../intelligence/intraday-decay.js').IntradayDecayManager}       [deps.intradayDecay]
   * @param {import('../risk/position-manager.js').PositionManager}                  [deps.positionManager]
   * @param {Object}   [deps.broker]
   * @param {Object}   [deps.dataFeed]
   * @param {Function} [deps.getWatchlist]
   * @param {Function} [deps.getNiftyCandles]
   * @param {Function} [deps.getOpenPositions]
   * @param {Function} [deps.sendReport]
   * @param {Function} [deps.healthCheck]
   */
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

    /** @type {cron.ScheduledTask[]} */
    this._cronJobs = [];

    /** @type {boolean} */
    this._scanning = false;

    /** @type {boolean} Prevent overlapping scans */
    this._scanInProgress = false;

    /** @type {number} Scan cycle counter */
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

    // 3. Strategy scan: every 5 minutes, 9:15 AM – 3:10 PM IST (Mon–Fri)
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

    // 4. Square-off warning: 15:10 IST
    this._cronJobs.push(
      cron.schedule('10 15 * * 1-5', () =>
        this._runJob('squareoff-warning', () => this._squareOffWarning()), opts)
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

    // 8. Shadow signal price fill — every 30 min during market hours
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('shadow-fill', () => this._shadowFill()), opts)
    );

    // 9. Shadow signal EOD fill — 4:00 PM IST
    this._cronJobs.push(
      cron.schedule('0 16 * * 1-5', () =>
        this._runJob('shadow-fill-eod', () => this._shadowFill()), opts)
    );

    // 10. FIX 1: Regime detector update — every 30 min during trading hours
    //     Runs alongside shadow-fill so both fire at :00 and :30.
    //     This keeps the regime cache fresh throughout the session so the
    //     pipeline doesn't fall back to TRENDING after 9:30 AM.
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('regime-update', () => this._updateRegime()), opts)
    );

    log.info({
      jobs: this._cronJobs.length,
      timezone: TIMEZONE,
    }, '🕐 MarketScheduler started — 10 jobs scheduled');

    // Catch-up: if app started mid-day during market hours, trigger market open
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

  /** Job 0: Weekly maintenance (Sunday 8:55 AM IST) */
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

  /** Job 1: Pre-market (9:00 AM IST) */
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

    // Specific token validity check — distinguishes "API down" from "token expired"
    if (health.broker && health.brokerTokenValid === false) {
      log.error('⚠ Broker token is invalid or expired — run: npm run login');
      // Do NOT engage kill switch here — the 8 AM auto-login cron handles this.
      // The kill switch will engage naturally at scan time if no valid token exists.
    }

    const integrity = await this.killSwitch.verifyIntegrity();
    log.info({ integrity }, 'Kill switch integrity verified');

    const engineResult = await this.engine.initialize();
    log.info({ engineReady: engineResult.ready }, 'Execution engine status');

    // Pipeline warm-up: pre-fetch trend data + initial regime computation
    if (this.pipeline) {
      try {
        const watchlist = await this.getWatchlist();
        const symbols = watchlist.map(w => w.symbol).filter(Boolean);
        const niftyCandles = await this.getNiftyCandles().catch(err => {
          log.warn({ err: err.message }, 'Failed to fetch Nifty candles for pre-market warm-up');
          return [];
        });

        await this.pipeline.warmUp(symbols, niftyCandles);
        log.info({ symbols: symbols.length, niftyCandles: niftyCandles.length },
          '✅ Pipeline warm-up complete (trend + regime seeded)');
      } catch (err) {
        log.warn({ err: err.message }, '⚠ Pipeline warm-up failed — continuing (fail-open)');
      }
    }

    const status = getMarketStatus();
    log.info({ status }, '═══ PRE-MARKET COMPLETE ═══');
    return { healthy: true, health, integrity, engineReady: engineResult.ready };
  }

  /** Job 2: Market Open (9:15 AM IST) */
  async _marketOpen() {
    log.info('═══ MARKET OPEN ═══');

    // FIX: Reset intraday decay counters before first scan
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
   * Job 3: Strategy Scan (every 5 minutes, 9:15 AM – 3:10 PM IST)
   *
   * FIX 2: riskManager.refreshLiveSettings() called at top of each scan.
   * FIX 3: strategy refreshParams() called at top of each scan.
   * FIX 4: reconcilePositions fires every scan (not every 6).
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

    this._scanInProgress = true;
    this._scanCount++;

    try {
      // ── FIX 2: Refresh live risk parameters from Redis ───────────────────────
      // Must happen before validateOrder() is called in the scan loop.
      if (this.riskManager.refreshLiveSettings) {
        const { changed, overrides } = await this.riskManager.refreshLiveSettings().catch(err => {
          log.warn({ err: err.message }, 'refreshLiveSettings failed — using current values');
          return { changed: false, overrides: {} };
        });
        if (changed) {
          log.info({ overrides }, '⚙️  Risk params refreshed from live settings');
        }
      }

      // ── FIX 3: Refresh strategy parameters from Redis ─────────────────────────
      // Calls refreshParams() on every strategy that supports it.
      // Uses Promise.all for parallel Redis reads (one hget per param per strategy).
      if (this.engine?.consensus?.strategies?.length > 0) {
        await Promise.all(
          this.engine.consensus.strategies
            .filter(s => typeof s.refreshParams === 'function')
            .map(s => s.refreshParams().catch(err =>
              log.warn({ strategy: s.name, err: err.message },
                'Strategy refreshParams failed — using current values')
            ))
        );
      }

      // ── FIX 4: Per-scan position reconciliation ────────────────────────────────
      // Runs every scan cycle (not every 6) but only when positions are held.
      // Fire-and-forget — never blocks the scan loop.
      // Detects positions closed externally (forced square-off, margin call, etc.)
      if (this.engine._filledPositions?.size > 0 && this.broker) {
        this.engine.reconcilePositions(this.broker).catch(err =>
          log.warn({ err: err.message }, 'Reconciliation failed during scan')
        );
      }

      // ── Position Manager: stop/trail/time exits before strategy scan ────────────
      if (this.positionManager) {
        const pmResult = await this.positionManager.checkAll().catch(err => {
          log.error({ err: err.message }, 'Position manager check failed — continuing to strategy scan');
          return { checked: 0, exits: [] };
        });

        if (pmResult.exits.length > 0) {
          log.info({
            exits: pmResult.exits.length,
            symbols: pmResult.exits.map(e => `${e.symbol}(${e.reason})`),
          }, '🚨 Position manager exits completed before strategy scan');
        }
      }

      // ── Strategy scan ────────────────────────────────────────────────────────────
      const watchlist = await this.getWatchlist();

      if (!watchlist || watchlist.length === 0) {
        log.info('Strategy scan — empty watchlist');
        return { scanned: 0 };
      }

      const results = [];

      for (const item of watchlist) {
        // Skip held symbols — position manager handles their exits
        if (this.engine._filledPositions.has(item.symbol)) {
          log.debug({ symbol: item.symbol },
            'Skipping strategy scan — position held (monitored by position manager)');
          continue;
        }

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

      const heldCount = watchlist.filter(w => this.engine._filledPositions.has(w.symbol)).length;
      log.info({
        scanned: watchlist.length,
        held: heldCount,
        executed: results.filter(r => r.action === 'EXECUTED').length,
        blocked: results.filter(r => r.action?.startsWith('BLOCKED:')).length,
      }, 'Strategy scan complete');

      return { scanned: watchlist.length, results };
    } finally {
      this._scanInProgress = false;
    }
  }

  /** Job 4: Square-off Warning (3:10 PM IST) */
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
        side: (p.quantity || p.netQuantity || 0) > 0 ? 'LONG' : 'SHORT',
      })),
    }, 'Open positions entering square-off window');

    if (activeOrders.length > 0) {
      log.warn({ pendingCount: activeOrders.length }, 'Active orders will be cancelled at 3:15 PM');
    }

    return { positions: positions.length, activeOrders: activeOrders.length };
  }

  /** Job 5: Square-off (3:15 PM IST) */
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

  /** Job 6: Post-market (3:35 PM IST) */
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

  /** Job 7: Nightly Symbol Scout (8:00 PM IST, Mon–Fri) */
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
      throw err;
    }
  }

  /** Jobs 8/9: Shadow Signal Price Fill */
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

  /**
   * Job 10: FIX 1 — Regime Detector Update (every 30 min, 9:00–15:00 IST)
   *
   * Fetches fresh Nifty 50 daily candles and recomputes the market regime
   * (TRENDING / SIDEWAYS / VOLATILE). Without this, the regime is only
   * computed at pre-market (9:00 AM) and the 30-min Redis cache expires
   * silently — all afternoon signals use the default TRENDING regime
   * regardless of actual market conditions.
   *
   * Runs alongside shadow-fill at :00 and :30 each hour.
   * Fire-and-forget within the job — errors are caught and logged.
   */
  async _updateRegime() {
    if (!this.pipeline?.regimeDetector) {
      log.debug('Regime update skipped — no regime detector configured');
      return { skipped: true };
    }

    try {
      const niftyCandles = await this.getNiftyCandles().catch(err => {
        log.warn({ err: err.message },
          'Failed to fetch Nifty candles for regime update — keeping cached regime');
        return [];
      });

      if (niftyCandles.length === 0) {
        log.debug('Regime update skipped — no Nifty candles available');
        return { skipped: true, reason: 'no_candles' };
      }

      const regime = await this.pipeline.updateRegime(niftyCandles);
      log.info({
        regime: regime?.regime,
        adx: regime?.adx,
        atrPct: regime?.atrPct,
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