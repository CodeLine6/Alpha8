/**
 * @fileoverview Core backtest simulation engine for Alpha8.
 *
 * Simulates a full trading day cycle for each day in the historical dataset:
 *   - Runs all 4 strategies (or a single specified one) on each 5-min bar
 *   - Applies stop-loss (1% below entry, matching live risk-manager.js)
 *   - Applies square-off at 15:15 IST (matching square-off-job.js)
 *   - Tracks capital, P&L, and all trade metadata
 *
 * Design principles (mirrors live trading logic):
 *   - One position per symbol at a time
 *   - Entry on BUY signal (min 2 strategies agree if using consensus)
 *   - Exit on SELL signal, stop-loss trigger, or 15:15 IST square-off
 *   - Position sizing: risk 1% of current capital per trade
 *   - No lookahead bias: strategy only sees candles up to current bar
 */

import { groupByDay, toISTTimeString } from './historical-data-fetcher.js';

// ── Strategy imports (lazy — resolved at runtime from project root) ───────────
// We import these lazily so backtest.js can be run standalone without the full
// app boot sequence (no Redis, no DB, no broker needed).

const STRATEGY_MAP = {
  'EMA_CROSSOVER': () => import('../strategies/ema-crossover.js'),
  'RSI_MEAN_REVERSION': () => import('../strategies/rsi-reversion.js'),
  'VWAP_MOMENTUM': () => import('../strategies/vwap-momentum.js'),
  'BREAKOUT_VOLUME': () => import('../strategies/breakout-volume.js'),
};

const ALL_STRATEGIES = Object.keys(STRATEGY_MAP);

/** Minimum candle warm-up window per strategy before we start trading */
const WARMUP_CANDLES = {
  'EMA_CROSSOVER': 25, // EMA 21 + buffer
  'RSI_MEAN_REVERSION': 16, // RSI 14 + buffer
  'VWAP_MOMENTUM': 5, // Needs a few candles for volume average
  'BREAKOUT_VOLUME': 22, // 20-period lookback + buffer
};

/** Square-off time in IST "HH:MM" */
const SQUARE_OFF_TIME = '15:45';

/** Stop-loss: 1% below entry (matching risk-manager.js) */
const STOP_LOSS_PCT = 0.01;

/** Risk per trade: 1% of current capital */
const RISK_PER_TRADE_PCT = 0.01;

/** Max capital per single position: 20% */
const MAX_POSITION_PCT = 0.20;

/**
 * @typedef {object} BacktestConfig
 * @property {string}    symbol         - NSE trading symbol
 * @property {string[]}  strategies     - strategy names to use (or ['all'])
 * @property {number}    initialCapital - starting capital in ₹
 * @property {boolean}   [useConsensus] - require 2+ strategies to agree (default: false for solo, true for multi)
 * @property {number}    [minConsensus] - minimum agreeing strategies (default: 2)
 * @property {Function}  [logger]       - log function (default: console.log)
 */

/**
 * @typedef {object} Position
 * @property {string}  symbol
 * @property {string}  strategy
 * @property {number}  entryPrice
 * @property {number}  stopLoss
 * @property {number}  quantity
 * @property {number}  entryValue
 * @property {Date}    entryTime
 * @property {string}  entryReason
 */

/**
 * Main backtest simulation engine.
 */
export class BacktestEngine {
  /**
   * @param {BacktestConfig} config
   */
  constructor(config) {
    this.symbol = config.symbol;
    this.strategyNames = this._resolveStrategyNames(config.strategies);
    this.initialCapital = config.initialCapital;
    this.useConsensus = config.useConsensus ?? (this.strategyNames.length > 1);
    this.minConsensus = config.minConsensus ?? 2;
    this.logger = config.logger ?? console.log;

    /** Current capital (changes as trades complete) */
    this.capital = this.initialCapital;

    /** Open position state (one at a time, like the live engine) */
    this.position = null;

    /** Completed trade log */
    this.trades = [];

    /** Loaded strategy instances */
    this._strategies = null;
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Run the full backtest on a set of historical candles.
   *
   * @param {Array} candles  - flat OHLCV array sorted chronologically
   * @returns {Promise<{ trades: Array, capital: number }>}
   */
  async run(candles) {
    this.capital = this.initialCapital;
    this.position = null;
    this.trades = [];

    // Load strategy instances
    this._strategies = await this._loadStrategies();

    // Group candles by trading day (IST)
    const days = groupByDay(candles);
    const sortedDays = [...days.keys()].sort();

    this.logger(`[BacktestEngine] Starting simulation: ${sortedDays.length} trading days, ` +
      `${candles.length} candles, strategies: [${this.strategyNames.join(', ')}]`);

    for (const day of sortedDays) {
      const dayCandles = days.get(day);
      await this._simulateDay(day, dayCandles);
    }

    this.logger(`[BacktestEngine] Simulation complete: ${this.trades.length} trades`);

    return {
      trades: this.trades,
      capital: this.capital,
    };
  }

  // ── Private methods ────────────────────────────────────────────────────────

  /**
   * Simulate a single trading day.
   * Walks candle by candle, fires strategies, manages position.
   *
   * @param {string} day      - 'YYYY-MM-DD'
   * @param {Array}  candles  - candles for this day only
   */
  async _simulateDay(day, candles) {
    // Filter to market hours: 09:15 – 15:30 IST
    const marketCandles = candles.filter(c => {
      const t = toISTTimeString(c.date);
      return t >= '09:15' && t <= '15:30';
    });

    if (marketCandles.length === 0) return;

    // Close any leftover position from previous day at open (shouldn't happen
    // in intraday, but safeguard for daily-bar backtests)
    if (this.position) {
      this._closePosition(marketCandles[0], 'CARRY_OVER', marketCandles[0].open);
    }

    for (let i = 0; i < marketCandles.length; i++) {
      const candle = marketCandles[i];
      const timeIST = toISTTimeString(candle.date);

      // ── Square-off check ──────────────────────────────────────────────────
      if (timeIST >= SQUARE_OFF_TIME) {
        if (this.position) {
          this._closePosition(candle, 'SQUARE_OFF', candle.open);
        }
        break; // No new positions after square-off time
      }

      // ── Stop-loss check ───────────────────────────────────────────────────
      if (this.position && candle.low <= this.position.stopLoss) {
        // Stopped out — fill at stop loss price (conservative; real fill may be worse)
        const fillPrice = Math.min(this.position.stopLoss, candle.open);
        this._closePosition(candle, 'STOP_LOSS', fillPrice);
      }

      // ── Strategy signal ───────────────────────────────────────────────────
      // Only look at candles up to now (no lookahead bias)
      const windowCandles = marketCandles.slice(0, i + 1);

      // Need minimum warm-up candles for meaningful signals
      const minWarmup = Math.min(...this.strategyNames.map(s => WARMUP_CANDLES[s] ?? 20));
      if (windowCandles.length < minWarmup) continue;

      const signals = this._getSignals(windowCandles, candle.volume);

      const decision = this.useConsensus
        ? this._consensusDecision(signals)
        : signals[0]; // Single-strategy mode

      if (!decision) continue;

      // ── Entry logic ───────────────────────────────────────────────────────
      if (decision.signal === 'BUY' && !this.position) {
        this._openPosition(candle, decision);
      }

      // ── Exit on SELL signal ───────────────────────────────────────────────
      if (decision.signal === 'SELL' && this.position) {
        this._closePosition(candle, 'SIGNAL', candle.close);
      }
    }

    // If market close reached with an open position, square off at last close
    if (this.position) {
      const lastCandle = marketCandles[marketCandles.length - 1];
      this._closePosition(lastCandle, 'SQUARE_OFF', lastCandle.close);
    }
  }

  /**
   * Run all loaded strategies on the current candle window.
   * Returns array of signal objects.
   *
   * @param {Array}  candles       - window of candles up to current bar
   * @param {number} currentVolume - current bar's volume
   * @returns {Array}
   */
  _getSignals(candles, currentVolume) {
    const signals = [];

    for (const [name, strategy] of Object.entries(this._strategies)) {
      try {
        const sig = strategy.analyze(candles, currentVolume);
        if (sig && sig.signal !== 'HOLD') {
          signals.push({ ...sig, strategy: name });
        }
      } catch {
        // Strategy returned error (e.g. insufficient data) — treat as HOLD
      }
    }

    return signals;
  }

  /**
   * Weighted consensus decision.
   * At least `minConsensus` strategies must agree on the same direction.
   * Returns the highest-confidence agreeing signal, or null if no consensus.
   *
   * @param {Array} signals
   * @returns {object|null}
   */
  _consensusDecision(signals) {
    if (signals.length === 0) return null;

    const buys = signals.filter(s => s.signal === 'BUY');
    const sells = signals.filter(s => s.signal === 'SELL');

    if (buys.length >= this.minConsensus) {
      return buys.reduce((best, s) => s.confidence > best.confidence ? s : best, buys[0]);
    }
    if (sells.length >= this.minConsensus) {
      return sells.reduce((best, s) => s.confidence > best.confidence ? s : best, sells[0]);
    }

    return null; // No consensus
  }

  /**
   * Open a new long position.
   *
   * @param {object} candle   - entry candle (fill at close price)
   * @param {object} signal   - triggering signal
   */
  _openPosition(candle, signal) {
    const entryPrice = candle.close;
    const stopLoss = entryPrice * (1 - STOP_LOSS_PCT);

    // Position sizing: risk 1% of capital, stop distance = 1%
    // => quantity = (capital * RISK_PER_TRADE_PCT) / (entryPrice * STOP_LOSS_PCT)
    // => simplified: risk amount / price drop to stop = shares
    const riskAmount = this.capital * RISK_PER_TRADE_PCT;
    const stopDistance = entryPrice * STOP_LOSS_PCT;
    let quantity = Math.floor(riskAmount / stopDistance);

    // Cap at MAX_POSITION_PCT of capital
    const maxShares = Math.floor((this.capital * MAX_POSITION_PCT) / entryPrice);
    quantity = Math.min(quantity, maxShares);
    quantity = Math.max(quantity, 1); // At least 1 share

    this.position = {
      symbol: this.symbol,
      strategy: signal.strategy,
      entryPrice,
      stopLoss,
      quantity,
      entryValue: entryPrice * quantity,
      entryTime: candle.date,
      entryReason: signal.reason,
      confidence: signal.confidence,
    };
  }

  /**
   * Close the current open position and record the trade.
   *
   * @param {object} candle      - exit candle
   * @param {string} exitReason  - 'SIGNAL'|'STOP_LOSS'|'SQUARE_OFF'|'CARRY_OVER'
   * @param {number} exitPrice   - actual fill price
   */
  _closePosition(candle, exitReason, exitPrice) {
    const pos = this.position;
    const pnl = (exitPrice - pos.entryPrice) * pos.quantity;
    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100;

    const trade = {
      symbol: pos.symbol,
      strategy: pos.strategy,
      side: 'BUY',
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      pnl: Math.round(pnl * 100) / 100,
      pnlPct: Math.round(pnlPct * 100) / 100,
      exitReason,
      entryTime: pos.entryTime,
      exitTime: candle.date,
      entryReason: pos.entryReason,
      confidence: pos.confidence,
    };

    this.trades.push(trade);
    this.capital += pnl;
    this.position = null;
  }

  /**
   * Load and instantiate all configured strategies.
   * @returns {Promise<object>}  map of strategyName → instance
   */
  async _loadStrategies() {
    const instances = {};

    for (const name of this.strategyNames) {
      const loader = STRATEGY_MAP[name];
      if (!loader) {
        throw new Error(`Unknown strategy: "${name}". Valid options: ${ALL_STRATEGIES.join(', ')}`);
      }

      try {
        const mod = await loader();
        // Support default export (class) or named export
        const StratClass = mod.default ?? mod[Object.keys(mod)[0]];
        instances[name] = new StratClass();
      } catch (err) {
        throw new Error(`Failed to load strategy "${name}": ${err.message}`);
      }
    }

    return instances;
  }

  /**
   * Resolve strategy name list, expanding 'all' to all 4 strategies.
   * @param {string|string[]} input
   * @returns {string[]}
   */
  _resolveStrategyNames(input) {
    if (!input) return ALL_STRATEGIES;

    const list = Array.isArray(input) ? input : [input];

    if (list.includes('all')) return ALL_STRATEGIES;

    for (const name of list) {
      if (!STRATEGY_MAP[name]) {
        throw new Error(
          `Unknown strategy: "${name}". Valid: ${ALL_STRATEGIES.join(', ')}, all`
        );
      }
    }

    return list;
  }
}

/** Export valid strategy names for CLI validation */
export { ALL_STRATEGIES };
