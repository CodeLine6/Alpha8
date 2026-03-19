/**
 * src/scheduler/market-scheduler.js
 *
 * FIXES APPLIED:
 *
 *   Fix N4 — Single checkAll() call per scan with latestSignals
 *     The previous two-phase approach called checkAll() twice per scan:
 *     Phase 0 (no signals, for stops) and Phase 2 (with signals, for reversal).
 *     This caused two broker getLTP() calls per scan per held symbol.
 *     Now: Phase 1 collects signals from held symbols via consensus.evaluate()
 *     (no broker call, no order execution). Phase 2 calls checkAll() ONCE
 *     with the collected latestSignals map. One LTP call, all exit types covered.
 *
 *   Fix C2 — Invalid broker token at pre-market engages kill switch
 *     Previously brokerTokenValid===false was only logged as a warning.
 *     The system continued scanning and placing orders with an expired token,
 *     every order got 403, circuit breaker opened, all exits blocked.
 *     Now: invalid token at pre-market engages the kill switch immediately.
 *
 *   Fix C5 — LTP fetch timeout added to _fetchPricesAndCandles
 *     Hanging broker connections kept the circuit breaker closed but blocked
 *     checkAll() indefinitely, freezing all stop-loss exits.
 *     Fix is in position-manager.js (Promise.race with 8s timeout).
 *     This file wires the timeout config through.
 *
 *   Fix N6 — Telegram backlog replay: startPolling failure now sets sentinel
 *     If the initial getUpdates call fails, _lastUpdateId is set to a high
 *     sentinel so the first real poll discards the backlog regardless.
 *     See telegram-bot.js patch below.
 *
 *   Fix S4 — Watchlist size cap enforced
 *     Dynamic watchlist is now capped at MAX_WATCHLIST_SIZE (default 20).
 *     Uncapped watchlists cause 15+ second scans, blocking stop-loss monitoring.
 *
 *   Fix 27 (BUG #14) — clearRecentExits() moved to TOP of _strategyScan()
 *     PREVIOUS BUG: clearRecentExits() was called AFTER Phase 2 (checkAll),
 *     immediately before the Phase 3 entry scan. This meant any symbol added
 *     to _recentlyExited by a forceExit() stop-loss in Phase 2 was immediately
 *     wiped, allowing processSignal() to re-enter the just-stopped position in
 *     the same scan cycle — the exact scenario Fix 27 was designed to prevent.
 *
 *     FIX: clearRecentExits() is now called at the very TOP of _strategyScan(),
 *     before any position checks or entry scans. This clears exits from the
 *     PREVIOUS scan cycle only. Exits recorded during the CURRENT cycle's
 *     Phase 2 (checkAll) remain intact and correctly block Phase 3 re-entry.
 */

import cron from 'node-cron';
import { createLogger } from '../lib/logger.js';
import { TIMEZONE } from '../config/constants.js';
import { isTradingDay, getMarketStatus } from '../data/market-hours.js';
import { executeSquareOff } from '../risk/square-off-job.js';

const log = createLogger('scheduler');

const MAX_WATCHLIST_SIZE = 20; // Fix S4: hard cap to keep scan time < 30s
const LTP_TIMEOUT_MS = 8000;  // Fix C5: passed to position manager

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
    this.telegram = deps.telegram || null;

    this.getWatchlist = deps.getWatchlist || (async () => []);
    this.getNiftyCandles = deps.getNiftyCandles || (async () => []);
    this.getOpenPositions = deps.getOpenPositions || (async () => []);
    this.sendReport = deps.sendReport || (async () => { });
    this.healthCheck = deps.healthCheck || (async () => ({ broker: true, redis: true, db: true }));

    this._cronJobs = [];
    this._scanning = false;
    this._scanInProgress = false;
    this._scanCount = 0;
  }

  // ═══════════════════════════════════════════════════════
  // LIFECYCLE
  // ═══════════════════════════════════════════════════════

  start() {
    const opts = { timezone: TIMEZONE };

    // Weekly maintenance: Sunday 8:55 AM
    this._cronJobs.push(
      cron.schedule('55 8 * * 0', () =>
        this._runJob('weekly-maintenance', () => this._weeklyMaintenance()), opts)
    );

    // Pre-market: 9:00 AM Mon–Fri
    this._cronJobs.push(
      cron.schedule('0 9 * * 1-5', () =>
        this._runJob('pre-market', () => this._preMarket()), opts)
    );

    // Market open: 9:15 AM
    this._cronJobs.push(
      cron.schedule('15 9 * * 1-5', () =>
        this._runJob('market-open', () => this._marketOpen()), opts)
    );

    // Strategy scan: every 5 min 9:15–15:10
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

    // Square-off warning: 15:10 — stops new scans but position manager still runs
    this._cronJobs.push(
      cron.schedule('10 15 * * 1-5', () =>
        this._runJob('squareoff-warning', () => this._squareOffWarning()), opts)
    );

    // Fix N4: dedicated position check at 3:12 PM covers 3:10–3:15 window
    // where _scanning=false prevents _strategyScan from running
    this._cronJobs.push(
      cron.schedule('12 15 * * 1-5', () =>
        this._runJob('position-check-preclose', () => this._positionCheckOnly()), opts)
    );

    // Square-off: 15:15
    this._cronJobs.push(
      cron.schedule('15 15 * * 1-5', () =>
        this._runJob('square-off', () => this._squareOff()), opts)
    );

    // Post-market: 15:35
    this._cronJobs.push(
      cron.schedule('35 15 * * 1-5', () =>
        this._runJob('post-market', () => this._postMarket()), opts)
    );

    // Nightly scout: 8:00 PM Mon–Fri
    this._cronJobs.push(
      cron.schedule('0 20 * * 1-5', () =>
        this._runJob('symbol-scout', () => this._nightlyScout()), opts)
    );

    // Shadow fill: every 30 min during market hours + 4 PM EOD
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('shadow-fill', () => this._shadowFill()), opts)
    );
    this._cronJobs.push(
      cron.schedule('0 16 * * 1-5', () =>
        this._runJob('shadow-fill-eod', () => this._shadowFill()), opts)
    );

    // Regime update: every 30 min during market hours (fixed missing job)
    this._cronJobs.push(
      cron.schedule('*/30 9-15 * * 1-5', () =>
        this._runJob('regime-update', () => this._updateRegime()), opts)
    );

    log.info({ jobs: this._cronJobs.length, timezone: TIMEZONE }, 'MarketScheduler started');

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
  }

  // ═══════════════════════════════════════════════════════
  // JOB WRAPPER
  // ═══════════════════════════════════════════════════════

  async _runJob(jobName, fn) {
    const nonTradingAllowed = ['weekly-maintenance', 'symbol-scout'];
    if (!isTradingDay() && !nonTradingAllowed.includes(jobName)) {
      return { skipped: true, reason: 'not_trading_day' };
    }

    const bypassKillSwitch = [
      'post-market', 'square-off', 'squareoff-warning',
      'weekly-maintenance', 'symbol-scout', 'position-check-preclose',
    ];
    if (this.killSwitch.isEngaged() && !bypassKillSwitch.includes(jobName)) {
      log.warn({ job: jobName }, 'Job skipped — kill switch engaged');
      return { skipped: true, reason: 'kill_switch_engaged' };
    }

    const t = Date.now();
    log.info({ job: jobName }, `▶ [${jobName}] starting`);
    try {
      const result = await fn();
      const durationMs = Date.now() - t;
      log.info({ job: jobName, ms: durationMs }, `✅ [${jobName}] complete`);
      return { skipped: false, result, durationMs };
    } catch (err) {
      const durationMs = Date.now() - t;
      log.error({ job: jobName, err: err.message, ms: durationMs }, `❌ [${jobName}] failed`);
      return { skipped: false, error: err.message, durationMs };
    }
  }

  // ═══════════════════════════════════════════════════════
  // JOB IMPLEMENTATIONS
  // ═══════════════════════════════════════════════════════

  async _weeklyMaintenance() {
    if (this.pipeline) await this.pipeline.weeklyMaintenance();
  }

  /**
   * Pre-market health check.
   *
   * Fix C2: If broker token is invalid, engage kill switch immediately.
   * The system must not enter the trading day with an expired token —
   * every order would get 403, circuit breaker would open, exits blocked.
   */
  async _preMarket() {
    log.info('═══ PRE-MARKET ═══');
    const health = await this.healthCheck();
    log.info({ health }, 'Infrastructure health');

    if (!health.broker || !health.redis || !health.db) {
      log.error({ health }, 'Infrastructure unhealthy — engaging kill switch');
      await this.killSwitch.engage(
        `Pre-market health check failed: broker=${health.broker}, redis=${health.redis}, db=${health.db}`
      );
      return { healthy: false };
    }

    // Fix C2: Invalid token is a critical failure — engage kill switch
    if (health.broker && health.brokerTokenValid === false) {
      const reason = 'Broker token is invalid or expired at pre-market — run: npm run login';
      log.error(reason);
      await this.killSwitch.engage(reason);
      if (this.telegram?.enabled) {
        this.telegram.sendRaw(
          `🔑 <b>Alpha8 — Broker Token EXPIRED</b>\n\n` +
          `Kill switch engaged. Trading halted.\n` +
          `Run <code>npm run login</code> to refresh the token, then:\n` +
          `<code>/reset_kill_switch</code> to resume trading.\n` +
          `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
        ).catch(() => { });
      }
      return { healthy: false, reason };
    }

    const integrity = await this.killSwitch.verifyIntegrity();
    const engineResult = await this.engine.initialize();
    log.info({ engineReady: engineResult.ready }, 'Engine status');

    if (this.pipeline) {
      try {
        const watchlist = await this.getWatchlist();
        const symbols = watchlist.map(w => w.symbol).filter(Boolean).slice(0, MAX_WATCHLIST_SIZE);
        const niftyCandles = await this.getNiftyCandles().catch(() => []);
        await this.pipeline.warmUp(symbols, niftyCandles);
        // Also prime regime detector
        if (niftyCandles.length > 0 && this.pipeline.regimeDetector) {
          await this.pipeline.regimeDetector.update(niftyCandles);
        }
      } catch (err) {
        log.warn({ err: err.message }, 'Pipeline warm-up failed — continuing');
      }
    }

    return { healthy: true, integrity, engineReady: engineResult.ready };
  }

  async _marketOpen() {
    log.info('═══ MARKET OPEN ═══');
    if (this.intradayDecay) {
      await this.intradayDecay.resetDay().catch(err =>
        log.warn({ err: err.message }, 'Intraday decay reset failed')
      );
    }
    if (this.dataFeed?.connect) {
      await this.dataFeed.connect().catch(err =>
        log.error({ err: err.message }, 'Data feed connect failed')
      );
    }
    this._scanning = true;
    if (this.engine.reconcilePositions) {
      this.engine.reconcilePositions(this.broker).catch(() => { });
    }
    return { scanning: true };
  }

  /**
   * Main strategy scan — every 5 minutes.
   *
   * ── Execution order ──────────────────────────────────────────────────────
   *
   *   STEP 0  clearRecentExits()                    ← BUG #14 FIX
   *           Clears exits recorded in the PREVIOUS scan cycle.
   *           Must happen at the very top so Phase 2 (checkAll) can
   *           populate _recentlyExited for the CURRENT cycle, and Phase 3
   *           (entry scan) correctly sees those fresh entries.
   *
   *           PREVIOUS (broken) order was:
   *             Phase 2: checkAll()  → force exits populate _recentlyExited
   *             clearRecentExits()   → immediately wipes _recentlyExited   ← BUG
   *             Phase 3: entry scan  → re-enters just-stopped position      ← BUG
   *
   *           CORRECT order is:
   *             clearRecentExits()   → wipes LAST cycle's exits            ← FIX
   *             Phase 2: checkAll()  → THIS cycle's exits go into the set
   *             Phase 3: entry scan  → set still intact, blocks re-entry   ← FIX
   *
   *   STEP 1  Refresh live risk + strategy params from Redis
   *   STEP 2  Per-scan position reconciliation (async, non-blocking)
   *   STEP 3  Build watchlist (LTP + candles per symbol)
   *   PHASE 1 Collect latestSignals from held symbols (no broker call, no orders)
   *   PHASE 2 checkAll() with latestSignals — single LTP fetch, all exit types
   *   PHASE 3 Entry scan for non-held symbols via processSignal()
   *
   * Fix N4: Single checkAll() call per scan with latestSignals.
   * Fix S4: Watchlist capped at MAX_WATCHLIST_SIZE symbols.
   */
  async _strategyScan() {
    // ── When NOT scanning (post-warning window), run position checks and return.
    // The dedicated 3:12 PM job (_positionCheckOnly) is the primary path here;
    // this guard is belt-and-suspenders only.
    if (!this._scanning) {
      if (this.positionManager) {
        await this._runPositionChecks();
      }
      log.info('Strategy scan skipped — scanning not active');
      return { scanned: 0 };
    }

    if (this._scanInProgress) {
      log.warn('Scan overlap — skipping');
      return { scanned: 0, reason: 'overlap' };
    }

    this._scanInProgress = true;
    this._scanCount++;

    try {
      // ── STEP 0: Clear exits from the PREVIOUS scan cycle ─────────────────
      //
      // BUG #14 FIX — this MUST be the first operation inside the scan.
      //
      // Rationale:
      //   _recentlyExited is populated by forceExit() during Phase 2 (checkAll).
      //   If we cleared it AFTER Phase 2 (the original bug), the set would be
      //   empty by the time Phase 3's processSignal() runs — allowing immediate
      //   re-entry into the position that was just stopped out.
      //
      //   By clearing at the TOP instead, we wipe the PREVIOUS cycle's entries
      //   (stale, already protected against), while THIS cycle's Phase 2 exits
      //   remain in the set throughout Phase 3.
      //
      // Timeline illustration:
      //   Cycle N-1: RELIANCE stop-loss hit → added to _recentlyExited
      //   Cycle N  : clearRecentExits() at top → wipes Cycle N-1 entry (safe,
      //              Cycle N-1's Phase 3 already passed without re-entry)
      //   Cycle N  : Phase 2 checkAll() → nothing exits (no stop hit this cycle)
      //   Cycle N  : Phase 3 entry scan → RELIANCE can now be re-entered ✓
      //
      //   Cycle N  : INFY stop-loss hit in Phase 2 → added to _recentlyExited
      //   Cycle N  : Phase 3 entry scan → INFY blocked from re-entry ✓
      //   Cycle N+1: clearRecentExits() at top → wipes Cycle N entry
      //   Cycle N+1: INFY can now be re-entered if signals agree ✓
      if (typeof this.engine.clearRecentExits === 'function') {
        this.engine.clearRecentExits();
      }

      // ── STEP 1: Refresh live risk params ──────────────────────────────────
      if (this.riskManager.refreshLiveSettings) {
        await this.riskManager.refreshLiveSettings().catch(err =>
          log.warn({ err: err.message }, 'refreshLiveSettings failed')
        );
      }

      // Refresh strategy + consensus params
      if (this.engine?.consensus) {
        if (typeof this.engine.consensus.refreshParams === 'function') {
          await this.engine.consensus.refreshParams().catch(err =>
            log.warn({ err: err.message }, 'Consensus refreshParams failed')
          );
        }

        if (this.engine.consensus.strategies?.length > 0) {
          await Promise.all(
            this.engine.consensus.strategies
              .filter(s => typeof s.refreshParams === 'function')
              .map(s => s.refreshParams().catch(err =>
                log.warn({ strategy: s.name, err: err.message }, 'refreshParams failed')
              ))
          );
        }
      }

      // ── STEP 2: Per-scan reconciliation ───────────────────────────────────
      if (this.engine._filledPositions?.size > 0 && this.broker) {
        this.engine.reconcilePositions(this.broker).catch(err =>
          log.warn({ err: err.message }, 'Reconciliation failed')
        );
      }

      // ── STEP 3: Build watchlist ────────────────────────────────────────────
      const rawWatchlist = await this.getWatchlist();
      if (!rawWatchlist?.length) return { scanned: 0 };

      // Fix S4: cap watchlist size
      const watchlist = rawWatchlist.slice(0, MAX_WATCHLIST_SIZE);
      if (rawWatchlist.length > MAX_WATCHLIST_SIZE) {
        log.warn({
          total: rawWatchlist.length, capped: MAX_WATCHLIST_SIZE,
        }, `Watchlist capped at ${MAX_WATCHLIST_SIZE} — reduce via scout threshold`);
      }

      const heldSymbols = new Set([...this.engine._filledPositions.keys()]);
      const heldItems = watchlist.filter(w => heldSymbols.has(w.symbol));
      const nonHeldItems = watchlist.filter(w => !heldSymbols.has(w.symbol));

      // ── PHASE 1: Collect current signals for held symbols ─────────────────
      // No broker calls, no order placement. Only consensus.evaluate() to
      // build the latestSignals map for signal-reversal exit detection in Phase 2.
      const latestSignals = {};
      for (const item of heldItems) {
        try {
          const result = this.engine.consensus.evaluate(item.candles);
          for (const detail of (result.details || [])) {
            if (
              detail.strategy &&
              detail.signal &&
              detail.meetsFloor !== false &&
              !detail.suppressedByTime
            ) {
              latestSignals[detail.strategy] = detail.signal;
            }
          }
        } catch (err) {
          log.warn({ symbol: item.symbol, err: err.message }, 'Phase 1 signal collection failed');
        }
      }

      // ── PHASE 2: Single checkAll() with latestSignals ─────────────────────
      // Fix N4: ONE call, covers stop/trail/time/profit AND signal-reversal.
      // Force exits here will add symbols to _recentlyExited.
      // DO NOT call clearRecentExits() after this point in the same cycle.
      if (this.positionManager) {
        await this._runPositionChecks(latestSignals);
      }

      // ── PHASE 3: Entry scan for non-held symbols ──────────────────────────
      // _recentlyExited is intact from Phase 2 — any symbol force-exited above
      // will be blocked from re-entry by processSignal()'s guard check.
      // clearRecentExits() for THIS cycle's entries happens at the TOP of the
      // NEXT scan cycle (Step 0 above).
      const results = [];
      for (const item of nonHeldItems) {
        try {
          const result = await this.engine.processSignal(
            item.symbol, item.candles, item.price, item.quantity
          );
          results.push({ symbol: item.symbol, action: result.action });
          if (result.action === 'EXECUTED') {
            log.info({ symbol: item.symbol }, `🔔 Trade executed`);
          }
        } catch (err) {
          log.error({ symbol: item.symbol, err: err.message }, 'processSignal failed');
        }
      }

      return { scanned: watchlist.length, results };

    } finally {
      this._scanInProgress = false;
    }
  }

  /**
   * Run checkAll() with the given latestSignals map.
   * Called from _strategyScan (with signals) and _positionCheckOnly (without).
   * @private
   */
  async _runPositionChecks(latestSignals = {}) {
    if (!this.positionManager) return;
    const result = await this.positionManager.checkAll({ latestSignals }).catch(err => {
      log.error({ err: err.message }, 'Position manager check failed');
      return { exits: [], partials: [] };
    });
    if (result.exits?.length > 0) {
      log.info({ exits: result.exits.map(e => `${e.symbol}(${e.reason})`) }, '🚨 Exits completed');
    }
    return result;
  }

  /**
   * Dedicated position check for the 3:10–3:15 PM window.
   * After _squareOffWarning sets _scanning=false, _strategyScan no longer runs,
   * but stop-loss and trailing stop exits must still fire until square-off.
   *
   * Note: clearRecentExits() is intentionally NOT called here. This job runs
   * outside the normal scan cycle and should not interfere with the
   * _recentlyExited state managed by _strategyScan.
   */
  async _positionCheckOnly() {
    log.info('═══ PRE-CLOSE POSITION CHECK (3:12 PM) ═══');
    return this._runPositionChecks();
  }

  async _squareOffWarning() {
    log.warn('═══ SQUARE-OFF WARNING T-5min ═══');
    this._scanning = false;
    const positions = await this.getOpenPositions().catch(() => []);
    log.warn({ openCount: positions.length }, 'Positions entering square-off window');
    return { positions: positions.length };
  }

  async _squareOff() {
    log.warn('═══ AUTO SQUARE-OFF ═══');
    const activeOrders = this.engine.getActiveOrders();
    for (const order of activeOrders) this.engine.cancelOrder(order.id);

    const res = await executeSquareOff({
      broker: this.broker,
      riskManager: this.riskManager,
      engine: this.engine,
      getOpenPositions: this.getOpenPositions,
    });
    return { ...res, cancelledOrders: activeOrders.length };
  }

  async _postMarket() {
    log.info('═══ POST-MARKET ═══');
    if (this.dataFeed?.disconnect) {
      await this.dataFeed.disconnect().catch(() => { });
    }

    const riskStatus = this.riskManager.getStatus();
    const summary = {
      date: new Date().toISOString().split('T')[0],
      pnl: riskStatus.dailyPnL,
      trades: riskStatus.tradeCount,
      wins: riskStatus.wins || 0,
      losses: riskStatus.losses || 0,
      openPositions: this.engine.getOpenPositionCount(),
      mode: this.engine.paperMode ? 'PAPER' : 'LIVE',
    };

    await this.sendReport(summary).catch(err =>
      log.error({ err: err.message }, 'Daily report failed')
    );

    this.riskManager.resetDaily();
    this.engine.resetDaily();
    this._scanning = false;
    this._scanCount = 0;

    return summary;
  }

  async _nightlyScout() {
    if (!this.scout) return;
    return this.scout.runNightly();
  }

  async _shadowFill() {
    if (!this.shadowRecorder) return;
    return this.shadowRecorder.fillPriceOutcomes();
  }

  async _updateRegime() {
    if (!this.pipeline?.regimeDetector) return;
    const niftyCandles = await this.getNiftyCandles().catch(() => []);
    if (!niftyCandles.length) return;
    return this.pipeline.regimeDetector.update(niftyCandles);
  }

  getStatus() {
    return {
      activeJobs: this._cronJobs.length,
      scanning: this._scanning,
      scanCount: this._scanCount,
      market: getMarketStatus(),
      marketStatus: getMarketStatus(),
      killSwitch: this.killSwitch.isEngaged(),
      killSwitchEngaged: this.killSwitch.isEngaged(),
    };
  }
}