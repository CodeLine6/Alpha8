import { createLogger } from '../lib/logger.js';
import { RISK_DEFAULTS, SQUARE_OFF_TIME } from '../config/constants.js';
import { isSquareOffTime, isTradingDay } from '../data/market-hours.js';

const log = createLogger('risk-manager');

/**
 * Risk Manager — synchronous, blocking risk gate for all order decisions.
 *
 * DESIGN PRINCIPLES (per user requirements):
 *   1. All checks are SYNCHRONOUS — no async gaps
 *   2. Rejects orders when daily loss limit is breached
 *   3. Every rejection/approval is logged with full context
 *   4. Kill switch check happens first, before any other check
 *   5. State is updated via explicit methods, not inferred
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
   */
  constructor(config) {
    this.capital = config.capital;
    this.killSwitch = config.killSwitch;

    this.maxDailyLossPct = config.maxDailyLossPct ?? RISK_DEFAULTS.MAX_DAILY_LOSS_PCT;
    this.perTradeStopLossPct = config.perTradeStopLossPct ?? RISK_DEFAULTS.PER_TRADE_STOP_LOSS_PCT;
    this.maxPositionCount = config.maxPositionCount ?? RISK_DEFAULTS.MAX_POSITION_COUNT;
    this.killSwitchDrawdownPct = config.killSwitchDrawdownPct ?? RISK_DEFAULTS.KILL_SWITCH_DRAWDOWN_PCT;

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

    // Derived limits
    this._maxDailyLossAmount = this.capital * (this.maxDailyLossPct / 100);
    this._killSwitchAmount = this.capital * (this.killSwitchDrawdownPct / 100);
    this._perTradeMaxLoss = this.capital * (this.perTradeStopLossPct / 100);

    log.info({
      capital: this.capital,
      maxDailyLoss: `${this.maxDailyLossPct}% (₹${this._maxDailyLossAmount})`,
      perTradeStop: `${this.perTradeStopLossPct}% (₹${this._perTradeMaxLoss})`,
      maxPositions: this.maxPositionCount,
      killSwitchAt: `${this.killSwitchDrawdownPct}% (₹${this._killSwitchAmount})`,
    }, 'RiskManager initialized');
  }

  /**
   * C2: Load persisted daily state from Redis on startup.
   * Call during app init to survive restarts mid-day.
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
          log.warn({
            dailyPnL: this._dailyPnL,
            openPositions: this._openPositionCount,
            tradeCount: this._tradeCount,
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
   * @param {Object} order
   * @param {string} order.symbol - Trading symbol
   * @param {string} order.side - 'BUY' or 'SELL'
   * @param {number} order.quantity - Number of shares
   * @param {number} order.price - Expected execution price
   * @param {string} [order.strategy] - Which strategy generated this
   * @returns {{ allowed: boolean, reason: string, context: Object }}
   */
  validateOrder(order) {
    const context = {
      symbol: order.symbol,
      side: order.side,
      quantity: order.quantity,
      price: order.price,
      strategy: order.strategy || 'unknown',
      dailyPnL: this._dailyPnL,
      openPositions: this._openPositionCount,
      tradeCount: this._tradeCount,
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
      const reason = `New BUY orders blocked after ${SQUARE_OFF_TIME} IST (square-off window)`;
      log.warn({ ...context }, `ORDER REJECTED — ${reason}`);
      return { allowed: false, reason, context };
    }

    // ─── All checks passed ───────────────────────────────
    log.info({ ...context, tradeRisk: tradeRisk.toFixed(2) }, 'ORDER APPROVED — all risk checks passed');
    return { allowed: true, reason: 'All risk checks passed', context };
  }

  // ═══════════════════════════════════════════════════════
  // STATE UPDATE METHODS
  // ═══════════════════════════════════════════════════════

  /**
   * Record a trade's PnL. Call after every trade closes.
   * Automatically checks drawdown against kill switch threshold.
   * Async because kill switch engagement now awaits Redis write.
   *
   * @param {number} pnl - Realized PnL for this trade (negative = loss)
   * @param {string} [symbol] - For logging context
   * @returns {Promise<void>}
   */
  async recordTradePnL(pnl, symbol = '') {
    this._dailyPnL += pnl;
    this._tradeCount++;

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

    // C2: Persist to Redis
    this._persistToRedis().catch(() => {});

    // ─── Kill switch auto-engagement (AWAITED) ───────────
    if (this._dailyPnL <= -this._killSwitchAmount) {
      await this.killSwitch.engage(
        `Drawdown ${drawdownPct.toFixed(2)}% hit kill switch threshold ` +
        `(${this.killSwitchDrawdownPct}%). Daily PnL: ₹${this._dailyPnL.toFixed(2)}`,
        drawdownPct
      );
    }
  }

  /**
   * Update the current open position count.
   * @param {number} count
   */
  setOpenPositionCount(count) {
    this._openPositionCount = count;
  }

  /**
   * Increment open position count (on new position entry).
   */
  addPosition() {
    this._openPositionCount++;
    this._persistToRedis().catch(() => {});
  }

  /**
   * Decrement open position count (on position exit).
   */
  removePosition() {
    this._openPositionCount = Math.max(0, this._openPositionCount - 1);
    this._persistToRedis().catch(() => {});
  }

  /**
   * Reset daily state — call at start of each trading day.
   */
  resetDaily() {
    this._dailyPnL = 0;
    this._openPositionCount = 0;
    this._tradeCount = 0;
    this._persistToRedis().catch(() => {});
    log.info({ capital: this.capital }, 'Risk manager daily state reset');
  }

  // ═══════════════════════════════════════════════════════
  // STATUS & MONITORING
  // ═══════════════════════════════════════════════════════

  /**
   * Get comprehensive risk status for monitoring/dashboard.
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
      killSwitch: this.killSwitch.getStatus(),
    };
  }
}
