import { createLogger } from '../lib/logger.js';
import { RISK_DEFAULTS, SQUARE_OFF_TIME } from '../config/constants.js';
import { isSquareOffTime, isTradingDay } from '../data/market-hours.js';

const log = createLogger('risk-manager');

/**
 * Risk Manager — synchronous, blocking risk gate for all order decisions.
 *
 * LIVE SETTINGS SUPPORT:
 *   Risk parameters can now be overridden at runtime via Redis (no restart needed).
 *   Call refreshLiveSettings() once per scan cycle to pull latest overrides.
 *   Falls back to config values if Redis is unavailable or no override is set.
 *
 *   Overridable params (via /api/live-settings or /set Telegram command):
 *     MAX_POSITION_COUNT, MAX_DAILY_LOSS_PCT, PER_TRADE_STOP_LOSS_PCT,
 *     KILL_SWITCH_DRAWDOWN_PCT, TRADING_CAPITAL
 *
 * DESIGN PRINCIPLES (per user requirements):
 *   1. All checks are SYNCHRONOUS — no async gaps
 *   2. Rejects orders when daily loss limit is breached
 *   3. Every rejection/approval is logged with full context
 *   4. Kill switch check happens first, before any other check
 *   5. State is updated via explicit methods, not inferred
 *
 * BUG FIX (Bug 3):
 *   - Added loadTradeCountFromDB(queryFn) — queries today's FILLED trades from
 *     the DB on startup instead of starting tradeCount at 0 after a restart.
 *   - Added syncPositionCount(count) — called after engine.hydratePositions()
 *     to override the Redis-restored openPositionCount with the real Map size,
 *     ensuring both are in sync. Redis state alone can drift from actual positions.
 *
 * @module risk-manager
 */

export class RiskManager {
  /**
   * @param {Object} config
   * @param {number} config.capital - Starting capital for the day
   * @param {import('./kill-switch.js').KillSwitch} config.killSwitch
   * @param {number} [config.maxDailyLossPct] - Max daily loss % (default 2)
   * @param {number} [config.perTradeStopLossPct] - Per-trade stop loss % (default 1)
   * @param {number} [config.maxPositionCount] - Max concurrent positions (default 5)
   * @param {number} [config.killSwitchDrawdownPct] - Kill switch trigger % (default 5)
   * @param {Function} [config.cacheGet] - Redis cacheGet for persistence
   * @param {Function} [config.cacheSet] - Redis cacheSet for persistence
   * @param {Function} [config.getLiveSetting] - Optional live settings reader fn(key, fallback)
   */
  constructor(config) {
    this.capital = config.capital;
    this.killSwitch = config.killSwitch;

    // Base values from config/env — used as fallback when no live override is set
    this._baseMaxDailyLossPct = config.maxDailyLossPct ?? RISK_DEFAULTS.MAX_DAILY_LOSS_PCT;
    this._basePerTradeStopLossPct = config.perTradeStopLossPct ?? RISK_DEFAULTS.PER_TRADE_STOP_LOSS_PCT;
    this._baseMaxPositionCount = config.maxPositionCount ?? RISK_DEFAULTS.MAX_POSITION_COUNT;
    this._baseKillSwitchDrawdownPct = config.killSwitchDrawdownPct ?? RISK_DEFAULTS.KILL_SWITCH_DRAWDOWN_PCT;
    this._baseMaxPositionPct = config.maxPositionPct ?? RISK_DEFAULTS.MAX_POSITION_VALUE_PCT;

    // Live (active) values — start as base values, updated by refreshLiveSettings()
    this.maxDailyLossPct = this._baseMaxDailyLossPct;
    this.perTradeStopLossPct = this._basePerTradeStopLossPct;
    this.maxPositionCount = this._baseMaxPositionCount;
    this.killSwitchDrawdownPct = this._baseKillSwitchDrawdownPct;
    this.maxPositionPct = this._baseMaxPositionPct;
    this.maxCapitalExposurePct = config.maxCapitalExposurePct ?? RISK_DEFAULTS.MAX_CAPITAL_EXPOSURE_PCT;

    // Optional live settings provider (injected from index.js)
    this._getLiveSetting = config.getLiveSetting || null;

    // C2: Redis persistence functions
    this._cacheGet = config.cacheGet || null;
    this._cacheSet = config.cacheSet || null;

    // ─── Daily PnL tracking ──────────────────────────────
    /** @type {number} Running realized + unrealized PnL for today */
    this._dailyPnL = 0;

    /** @type {number} Number of currently open positions */
    this._openPositionCount = 0;

    /** @type {number} Number of trades executed today */
    this._tradeCount = 0;
    this._wins = 0;
    this._losses = 0;

    // Derived limits — recomputed on every refreshLiveSettings() call
    this._recomputeLimits();

    log.info({
      capital: this.capital,
      maxDailyLoss: `${this.maxDailyLossPct}% (₹${this._maxDailyLossAmount})`,
      perTradeStop: `${this.perTradeStopLossPct}% (₹${this._perTradeMaxLoss})`,
      maxPositions: this.maxPositionCount,
      killSwitchAt: `${this.killSwitchDrawdownPct}% (₹${this._killSwitchAmount})`,
    }, 'RiskManager initialized');
  }

  // ═══════════════════════════════════════════════════════
  // LIVE SETTINGS — called once per scan cycle
  // ═══════════════════════════════════════════════════════

  /**
   * Pull latest risk parameter overrides from Redis.
   * Call this at the start of each scan cycle (in getWatchlist or _strategyScan).
   *
   * If no live override is set for a key, the .env/config value is used.
   * If Redis is unavailable, silently falls back to current values.
   *
   * @returns {Promise<{ changed: boolean, overrides: Object }>}
   */
  async refreshLiveSettings() {
    if (!this._getLiveSetting) {
      return { changed: false, overrides: {} };
    }

    const prev = {
      maxDailyLossPct: this.maxDailyLossPct,
      perTradeStopLossPct: this.perTradeStopLossPct,
      maxPositionCount: this.maxPositionCount,
      killSwitchDrawdownPct: this.killSwitchDrawdownPct,
      maxPositionPct: this.maxPositionPct,
    };

    try {
      this.maxDailyLossPct = await this._getLiveSetting('MAX_DAILY_LOSS_PCT', this._baseMaxDailyLossPct);
      this.perTradeStopLossPct = await this._getLiveSetting('PER_TRADE_STOP_LOSS_PCT', this._basePerTradeStopLossPct);
      this.maxPositionCount = await this._getLiveSetting('MAX_POSITION_COUNT', this._baseMaxPositionCount);
      this.killSwitchDrawdownPct = await this._getLiveSetting('KILL_SWITCH_DRAWDOWN_PCT', this._baseKillSwitchDrawdownPct);
      this.maxCapitalExposurePct = await this._getLiveSetting('MAX_CAPITAL_EXPOSURE_PCT', this.maxCapitalExposurePct);
      this.maxPositionPct = await this._getLiveSetting('MAX_POSITION_VALUE_PCT', this._baseMaxPositionPct);

      // Capital override — only affects position sizing, NOT today's P&L tracking
      const liveCapital = await this._getLiveSetting('TRADING_CAPITAL', this.capital);
      if (liveCapital !== this.capital) {
        log.info({ prev: this.capital, next: liveCapital }, 'Capital overridden via live settings');
        this.capital = liveCapital;
      }

      this._recomputeLimits();

      const overrides = {};
      let changed = false;

      for (const [key, val] of Object.entries(prev)) {
        if (val !== this[key]) {
          overrides[key] = { from: val, to: this[key] };
          changed = true;
        }
      }

      if (changed) {
        log.info({ overrides }, '⚙️  Risk params updated from live settings');
      }

      return { changed, overrides };
    } catch (err) {
      log.warn({ err: err.message }, 'refreshLiveSettings failed — keeping current values');
      return { changed: false, overrides: {} };
    }
  }

  /**
   * Recompute derived monetary limits from current percentage values.
   * Called after every live settings refresh and on construction.
   * @private
   */
  _recomputeLimits() {
    this._maxDailyLossAmount = this.capital * (this.maxDailyLossPct / 100);
    this._killSwitchAmount = this.capital * (this.killSwitchDrawdownPct / 100);
    this._perTradeMaxLoss = this.capital * (this.perTradeStopLossPct / 100);
    this._maxCapitalExposureAmount = this.capital * (this.maxCapitalExposurePct / 100);
  }

  // ═══════════════════════════════════════════════════════
  // PERSISTENCE — Redis state across restarts
  // ═══════════════════════════════════════════════════════

  /**
   * C2: Load persisted daily state from Redis on startup.
   * Call during app init to survive restarts mid-day.
   *
   * NOTE: After calling this, always call syncPositionCount(engine._filledPositions.size)
   * to override the Redis-restored openPositionCount with the authoritative DB-hydrated value.
   * Redis can drift from reality (e.g. SELL executed without position, Redis incremented anyway).
   *
   * @returns {Promise<void>}
   */
  async loadFromRedis() {
    if (!this._cacheGet) return;
    try {
      const stored = await this._cacheGet('risk:daily_state');
      if (stored) {
        const today = new Date().toISOString().split('T')[0];
        if (stored.date === today) {
          this._dailyPnL = stored.dailyPnL || 0;
          this._openPositionCount = stored.openPositionCount || 0;
          this._tradeCount = stored.tradeCount || 0;
          this._wins = stored.wins || 0;
          this._losses = stored.losses || 0;
          log.warn({
            dailyPnL: this._dailyPnL,
            openPositions: this._openPositionCount,
            tradeCount: this._tradeCount,
            wins: this._wins,
            losses: this._losses,
          }, 'Risk manager state RESTORED from Redis');
        } else {
          log.info('Redis risk state is from a different day — starting fresh');
        }
      }
    } catch (err) {
      log.error({ err: err.message }, 'Failed to load risk state from Redis');
    }
  }

  /**
   * Bug Fix 3: Sync open position count from the engine's authoritative _filledPositions Map.
   *
   * Call this AFTER engine.hydratePositions() completes. This overrides whatever
   * openPositionCount was stored in Redis, which may have drifted.
   *
   * @param {number} count - engine._filledPositions.size after hydration
   */
  syncPositionCount(count) {
    const previous = this._openPositionCount;
    this._openPositionCount = count;
    if (previous !== count) {
      log.warn({ previous, synced: count },
        `Position count synced from engine hydration: ${previous} → ${count}`);
    } else {
      log.info({ count }, 'Position count confirmed in sync with engine');
    }
    this._persistToRedis().catch(() => { });
  }

  /**
   * Bug Fix 3: Load today's trade count from the database.
   *
   * Replaces the in-memory _tradeCount=0 that occurs on every restart.
   * Must be called after DB is verified healthy, before scheduler.start().
   * Uses IST (Asia/Kolkata) for date comparison — never raw UTC.
   *
   * @param {Function} queryFn - The query() function from src/lib/db.js
   * @returns {Promise<void>}
   */
  async loadTradeCountFromDB(queryFn) {
    if (!queryFn) {
      log.warn('loadTradeCountFromDB: no queryFn provided — tradeCount stays at current value');
      return;
    }

    try {
      const result = await queryFn(`
        SELECT COUNT(*) AS count
        FROM trades
        WHERE status = 'FILLED'
          AND (created_at AT TIME ZONE 'Asia/Kolkata')::date =
              (NOW() AT TIME ZONE 'Asia/Kolkata')::date
      `);

      const dbCount = parseInt(result.rows?.[0]?.count ?? '0', 10);
      const previous = this._tradeCount;
      this._tradeCount = dbCount;

      if (previous !== dbCount) {
        log.warn({ previous, synced: dbCount },
          `Trade count synced from DB: ${previous} → ${dbCount}`);
      } else {
        log.info({ tradeCount: dbCount }, 'Trade count confirmed in sync with DB');
      }

      this._persistToRedis().catch(() => { });
    } catch (err) {
      log.error({ err: err.message },
        'Failed to load trade count from DB — tradeCount remains at current value');
    }
  }

  /**
   * C2: Persist current daily state to Redis.
   * @private
   */
  async _persistToRedis() {
    if (!this._cacheSet) return;
    try {
      await this._cacheSet('risk:daily_state', {
        date: new Date().toISOString().split('T')[0],
        dailyPnL: this._dailyPnL,
        openPositionCount: this._openPositionCount,
        tradeCount: this._tradeCount,
        wins: this._wins,
        losses: this._losses,
      });
    } catch (err) {
      log.error({ err: err.message }, 'Failed to persist risk state to Redis');
    }
  }

  // ═══════════════════════════════════════════════════════
  // ORDER GATE — The critical synchronous check
  // ═══════════════════════════════════════════════════════

  /**
   * Validate whether an order should be allowed.
   *
   * This is the SINGLE entry point for all risk checks.
   * Returns a decision object — NEVER throws.
   * ALL checks are synchronous.
   *
   * NOTE: Call refreshLiveSettings() once per scan cycle BEFORE calling validateOrder.
   * This keeps validateOrder synchronous while still respecting live overrides.
   *
   * @param {Object} order
   * @param {string} order.symbol - Trading symbol
   * @param {string} order.side - 'BUY' or 'SELL'
   * @param {number} order.quantity - Number of shares
   * @param {number} order.price - Expected execution price
   * @param {string} [order.strategy] - Which strategy generated this
   * @param {number} [totalExposureValue] - Optional current total value of all open positions
   * @returns {{ allowed: boolean, reason: string, context: Object }}
   */
  validateOrder(order, totalExposureValue = 0) {
    const context = {
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: order.price,
      strategy: order.strategy || 'unknown',
      dailyPnL: this._dailyPnL,
      openPositions: this._openPositionCount,
      tradeCount: this._tradeCount,
      // Include active param values in context for full audit trail
      activeParams: {
        maxDailyLossPct: this.maxDailyLossPct,
        perTradeStopLossPct: this.perTradeStopLossPct,
        maxPositionCount: this.maxPositionCount,
        killSwitchDrawdownPct: this.killSwitchDrawdownPct,
        maxCapitalExposurePct: this.maxCapitalExposurePct,
      },
      currentExposure: totalExposureValue,
    };

    // ─── Check 1: Kill Switch (highest priority) ─────────
    if (this.killSwitch.isEngaged()) {
      const reason = `KILL SWITCH ENGAGED: ${this.killSwitch.getStatus().reason}`;
      log.error({ ...context }, `ORDER REJECTED — ${reason}`);
      return { allowed: false, reason, context };
    }

    // ─── Check 2: Daily Loss Limit ───────────────────────
    if (this._dailyPnL <= -this._maxDailyLossAmount) {
      const reason =
        `Daily loss limit breached: PnL ₹${this._dailyPnL.toFixed(2)} ` +
        `exceeds max ₹-${this._maxDailyLossAmount.toFixed(2)} (${this.maxDailyLossPct}%)`;
      log.error({ ...context }, `ORDER REJECTED — ${reason}`);
      return { allowed: false, reason, context };
    }

    // ─── Check 3: Max Open Positions (only for BUY) ──────
    if (order.side === 'BUY' && this._openPositionCount >= this.maxPositionCount) {
      const reason =
        `Max open positions reached: ${this._openPositionCount}/${this.maxPositionCount}`;
      log.warn({ ...context }, `ORDER REJECTED — ${reason}`);
      return { allowed: false, reason, context };
    }

    // ─── Check 4: Per-Trade Risk ─────────────────────────
    const tradeRisk = order.quantity * order.price * (this.perTradeStopLossPct / 100);
    if (tradeRisk > this._perTradeMaxLoss) {
      const reason =
        `Per-trade risk ₹${tradeRisk.toFixed(2)} exceeds max ₹${this._perTradeMaxLoss.toFixed(2)} ` +
        `(${this.perTradeStopLossPct}% of capital)`;
      log.warn({ ...context, tradeRisk }, `ORDER REJECTED — ${reason}`);
      return { allowed: false, reason, context };
    }

    // ─── Check 5: Square-Off Time Guard ──────────────────
    if (order.side === 'BUY' && isSquareOffTime()) {
      const reason = `New BUY orders blocked after ${SQUARE_OFF_TIME} IST (square-off-window)`;
      log.warn({ ...context }, `ORDER REJECTED — ${reason}`);
      return { allowed: false, reason, context };
    }

    // ─── Check 6: Total Capital Exposure (only for BUY) ──
    if (order.side === 'BUY') {
      const newTradeValue = order.quantity * order.price;
      const totalAfterTrade = totalExposureValue + newTradeValue;

      if (totalAfterTrade > this._maxCapitalExposureAmount) {
        const reason =
          `Total capital exposure limit reached: ₹${totalAfterTrade.toFixed(2)} ` +
          `exceeds max ₹${this._maxCapitalExposureAmount.toFixed(2)} (${this.maxCapitalExposurePct}% of capital)`;
        log.warn({ ...context, newTradeValue, totalAfterTrade }, `ORDER REJECTED — ${reason}`);
        return { allowed: false, reason, context };
      }
    }

    // ─── All checks passed ───────────────────────────────
    log.info({ ...context, tradeRisk: tradeRisk.toFixed(2) },
      'ORDER APPROVED — all risk checks passed');
    return { allowed: true, reason: 'All risk checks passed', context };
  }

  // ═══════════════════════════════════════════════════════
  // STATE UPDATE METHODS
  // ═══════════════════════════════════════════════════════

  /**
   * Record a trade's PnL. Call after every trade closes.
   * Automatically checks drawdown against kill switch threshold.
   *
   * @param {number} pnl - Realized PnL for this trade (negative = loss)
   * @param {string} [symbol] - For logging context
   * @returns {Promise<void>}
   */
  async recordTradePnL(pnl, symbol = '') {
    this._dailyPnL += pnl;
    this._tradeCount++;
    if (pnl > 0) this._wins++;
    else if (pnl < 0) this._losses++;

    const drawdownPct = this.capital > 0
      ? (Math.abs(Math.min(this._dailyPnL, 0)) / this.capital) * 100
      : 0;

    log.info({
      pnl: pnl.toFixed(2),
      dailyPnL: this._dailyPnL.toFixed(2),
      drawdownPct: drawdownPct.toFixed(2),
      symbol,
      tradeCount: this._tradeCount,
    }, 'Trade PnL recorded');

    this._persistToRedis().catch(() => { });

    // Re-fetch kill switch threshold in case it was live-overridden
    // _killSwitchAmount is always in sync because _recomputeLimits() is called
    // in refreshLiveSettings() which runs before each scan cycle.
    if (this._dailyPnL <= -this._killSwitchAmount) {
      await this.killSwitch.engage(
        `Drawdown ${drawdownPct.toFixed(2)}% hit kill switch threshold ` +
        `(${this.killSwitchDrawdownPct}%). Daily PnL: ₹${this._dailyPnL.toFixed(2)}`,
        drawdownPct
      );
    }
  }

  /**
   * Set position count explicitly (e.g. after reconciliation).
   * @param {number} count
   */
  setOpenPositionCount(count) {
    this._openPositionCount = count;
  }

  /**
   * Increment open position count (on new BUY fill).
   */
  addPosition() {
    this._openPositionCount++;
    this._persistToRedis().catch(() => { });
  }

  /**
   * Decrement open position count (on SELL fill).
   * Bug Fix 3: Now correctly called from _placeWithRetry on SELL fills.
   */
  removePosition() {
    this._openPositionCount = Math.max(0, this._openPositionCount - 1);
    this._persistToRedis().catch(() => { });
  }

  /**
   * Reset daily state — call at start of each trading day.
   */
  resetDaily() {
    this._dailyPnL = 0;
    this._openPositionCount = 0;
    this._tradeCount = 0;
    this._wins = 0;
    this._losses = 0;
    this._persistToRedis().catch(() => { });
    log.info({ capital: this.capital }, 'Risk manager daily state reset');
  }

  // ═══════════════════════════════════════════════════════
  // STATUS & MONITORING
  // ═══════════════════════════════════════════════════════

  /**
   * Get comprehensive risk status for monitoring/dashboard.
   * Includes both active (possibly live-overridden) and base (.env) param values.
   * @returns {Object}
   */
  getStatus() {
    const drawdownPct = this.capital > 0
      ? (Math.abs(Math.min(this._dailyPnL, 0)) / this.capital) * 100
      : 0;

    return {
      capital: this.capital,
      dailyPnL: +this._dailyPnL.toFixed(2),
      drawdownPct: +drawdownPct.toFixed(2),
      maxDailyLoss: this._maxDailyLossAmount,
      dailyLossUsedPct: this._maxDailyLossAmount > 0
        ? +((Math.abs(Math.min(this._dailyPnL, 0)) / this._maxDailyLossAmount) * 100).toFixed(1)
        : 0,
      openPositions: this._openPositionCount,
      maxPositions: this.maxPositionCount,
      tradeCount: this._tradeCount,
      wins: this._wins,
      losses: this._losses,
      killSwitch: this.killSwitch.getStatus(),
      // Active params (live overrides applied)
      activeParams: {
        maxDailyLossPct: this.maxDailyLossPct,
        perTradeStopLossPct: this.perTradeStopLossPct,
        maxPositionCount: this.maxPositionCount,
        killSwitchDrawdownPct: this.killSwitchDrawdownPct,
      },
      // Base params (.env fallbacks)
      baseParams: {
        maxDailyLossPct: this._baseMaxDailyLossPct,
        perTradeStopLossPct: this._basePerTradeStopLossPct,
        maxPositionCount: this._baseMaxPositionCount,
        killSwitchDrawdownPct: this._baseKillSwitchDrawdownPct,
      },
    };
  }
}