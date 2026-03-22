/**
 * @fileoverview Alpha8 Backtesting Engine — with SHORT SELLING support
 *
 * Changes from original:
 *   - _openPosition() now accepts direction 'BUY' or 'SELL' (short)
 *   - _closePosition() covers shorts with BUY-to-close, P&L = entry - exit
 *   - Stop-loss for shorts is ABOVE entry price
 *   - Square-off covers both longs (SELL) and shorts (BUY-to-cover)
 *   - RSI SELL signals are EXCLUDED from opening new short positions
 *
 * BUG #17 FIX retained: SQUARE_OFF_TIME imported from constants.js
 */

import { groupByDay, toISTTimeString } from './historical-data-fetcher.js';
import { SQUARE_OFF_TIME } from '../config/constants.js';
import { SHORT_INELIGIBLE_STRATEGIES } from '../engine/signal-consensus.js';
// Fix BUG-15: import brokerage.js function instead of duplicating fee constants
import { calcTradeCost } from '../lib/brokerage.js';

const STRATEGY_MAP = {
  'EMA_CROSSOVER': () => import('../strategies/ema-crossover.js'),
  'RSI_MEAN_REVERSION': () => import('../strategies/rsi-reversion.js'),
  'VWAP_MOMENTUM': () => import('../strategies/vwap-momentum.js'),
  'BREAKOUT_VOLUME': () => import('../strategies/breakout-volume.js'),
};

export const ALL_STRATEGIES = Object.keys(STRATEGY_MAP);

const WARMUP_CANDLES = {
  'EMA_CROSSOVER': 25,
  'RSI_MEAN_REVERSION': 16,
  'VWAP_MOMENTUM': 5,
  'BREAKOUT_VOLUME': 22,
};

// Fix BUG-14: module-level constants removed; values now come from constructor config
// (see this.stopLossPct, this.riskPerTradePct, this.maxPositionPct below)

export class BacktestEngine {
  constructor(config) {
    this.symbol = config.symbol;
    this.strategyNames = this._resolveStrategyNames(config.strategies);
    this.initialCapital = config.initialCapital;
    this.useConsensus = config.useConsensus ?? (this.strategyNames.length > 1);
    this.minConsensus = config.minConsensus ?? 2;
    this.allowShorts = config.allowShorts ?? true;   // ← NEW: toggle shorts on/off
    this.logger = config.logger ?? console.log;
    // Fix BUG-14: read from config so backtest matches live system settings
    this.stopLossPct    = (config.stopLossPct    ?? config.STOP_LOSS_PCT    ?? 0.01);
    this.riskPerTradePct = (config.riskPerTradePct ?? config.RISK_PER_TRADE_PCT ?? 0.01);
    this.maxPositionPct  = (config.maxPositionPct  ?? config.MAX_POSITION_PCT  ?? 0.20);

    this.capital = this.initialCapital;
    this.position = null;   // { direction: 'BUY'|'SELL', entryPrice, stopLoss, quantity, ... }
    this.trades = [];
    this._strategies = null;
  }

  // ── Public API ──────────────────────────────────────────────────────────

  async run(candles) {
    this.capital = this.initialCapital;
    this.position = null;
    this.trades = [];
    this._strategies = await this._loadStrategies();

    const days = groupByDay(candles);
    const sortedDays = [...days.keys()].sort();

    this.logger(
      `[BacktestEngine] Starting simulation: ${sortedDays.length} days, ` +
      `${candles.length} candles, shorts=${this.allowShorts}, ` +
      `squareOff: ${SQUARE_OFF_TIME} IST`
    );

    for (const day of sortedDays) {
      await this._simulateDay(day, days.get(day));
    }

    this.logger(`[BacktestEngine] Complete: ${this.trades.length} trades`);
    return { trades: this.trades, capital: this.capital };
  }

  // ── Private ─────────────────────────────────────────────────────────────

  async _simulateDay(day, candles) {
    const marketCandles = candles.filter(c => {
      const t = toISTTimeString(c.date);
      return t >= '09:15' && t <= '15:30';
    });
    if (marketCandles.length === 0) return;

    // Close any carry-over position from previous day
    if (this.position) {
      this._closePosition(marketCandles[0], 'CARRY_OVER', marketCandles[0].open);
    }

    for (let i = 0; i < marketCandles.length; i++) {
      const candle = marketCandles[i];
      const timeIST = toISTTimeString(candle.date);

      // ── Square-off ─────────────────────────────────────────────────
      if (timeIST >= SQUARE_OFF_TIME) {
        if (this.position) {
          this._closePosition(candle, 'SQUARE_OFF', candle.open);
        }
        break;
      }

      // ── Stop-loss check ────────────────────────────────────────────
      if (this.position) {
        const isShort = this.position.direction === 'SELL';
        const stopHit = isShort
          ? candle.high >= this.position.stopLoss   // SHORT: stop above entry
          : candle.low <= this.position.stopLoss;  // LONG:  stop below entry

        if (stopHit) {
          const fillPrice = isShort
            ? Math.max(this.position.stopLoss, candle.open)
            : Math.min(this.position.stopLoss, candle.open);
          this._closePosition(candle, 'STOP_LOSS', fillPrice);
        }
      }

      // ── Strategy signals ───────────────────────────────────────────
      const windowCandles = marketCandles.slice(0, i + 1);
      const minWarmup = Math.min(...this.strategyNames.map(s => WARMUP_CANDLES[s] ?? 20));
      if (windowCandles.length < minWarmup) continue;

      const signals = this._getSignals(windowCandles, candle.volume);
      const decision = this.useConsensus
        ? this._consensusDecision(signals)
        : signals[0];

      if (!decision) continue;

      // ── Entry / exit logic ─────────────────────────────────────────
      if (decision.signal === 'BUY') {
        if (!this.position) {
          // Open long
          this._openPosition(candle, decision, 'BUY');
        } else if (this.position.direction === 'SELL') {
          // Cover short
          this._closePosition(candle, 'SIGNAL', candle.close);
        }
      }

      if (decision.signal === 'SELL') {
        if (!this.position) {
          // Open short — only if allowed and strategy is eligible
          if (this.allowShorts && this._isShortEligible(decision.strategy)) {
            this._openPosition(candle, decision, 'SELL');
          }
        } else if (this.position.direction === 'BUY') {
          // Close long
          this._closePosition(candle, 'SIGNAL', candle.close);
        }
      }
    }

    // EOD square-off
    if (this.position) {
      const lastCandle = marketCandles[marketCandles.length - 1];
      this._closePosition(lastCandle, 'SQUARE_OFF', lastCandle.close);
    }
  }

  _getSignals(candles, currentVolume) {
    const signals = [];
    for (const [name, strategy] of Object.entries(this._strategies)) {
      try {
        const sig = strategy.analyze(candles, currentVolume);
        if (sig && sig.signal !== 'HOLD') {
          signals.push({ ...sig, strategy: name });
        }
      } catch { /* insufficient data — treat as HOLD */ }
    }
    return signals;
  }

  /**
   * Consensus for backtesting.
   * SELL consensus excludes SHORT_INELIGIBLE_STRATEGIES from opening shorts.
   * The returned signal includes `isShortEntry` flag.
   */
  _consensusDecision(signals) {
    if (signals.length === 0) return null;

    const buys = signals.filter(s => s.signal === 'BUY');
    const sells = signals.filter(s => s.signal === 'SELL');

    if (buys.length >= this.minConsensus) {
      return buys.reduce((best, s) =>
        s.confidence > best.confidence ? s : best, buys[0]);
    }

    if (sells.length >= this.minConsensus) {
      const best = sells.reduce((b, s) =>
        s.confidence > b.confidence ? s : b, sells[0]);

      // Check if at least one short-eligible strategy is in the SELL camp
      const hasEligible = sells.some(s => !SHORT_INELIGIBLE_STRATEGIES.has(s.strategy));
      return { ...best, isShortEntry: hasEligible };
    }

    return null;
  }

  /**
   * Check if the strategy that generated a SELL signal can open a short.
   * In single-strategy mode (no consensus), strategy must be short-eligible.
   */
  _isShortEligible(strategyName) {
    if (!strategyName) return false;
    return !SHORT_INELIGIBLE_STRATEGIES.has(strategyName);
  }

  /**
   * Open a new position — long (BUY) or short (SELL).
   */
  _openPosition(candle, signal, direction) {
    const entryPrice = candle.close;
    const isShort = direction === 'SELL';

    // Fix BUG-14: use this.stopLossPct (from config) instead of hardcoded STOP_LOSS_PCT
    const stopLoss = isShort
      ? entryPrice * (1 + this.stopLossPct)
      : entryPrice * (1 - this.stopLossPct);

    const riskAmount  = this.capital * this.riskPerTradePct;
    const stopDistance = entryPrice * this.stopLossPct;
    let quantity = Math.floor(riskAmount / stopDistance);
    const maxByCapital = Math.floor((this.capital * this.maxPositionPct) / entryPrice);
    quantity = Math.min(quantity, maxByCapital);
    quantity = Math.max(quantity, 1);

    this.position = {
      direction,
      isShort,
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
   * Close the current position.
   * LONG:  sells at exitPrice, P&L = (exit - entry) * qty
   * SHORT: covers at exitPrice, P&L = (entry - exit) * qty
   */
  _closePosition(candle, exitReason, exitPrice) {
    const pos = this.position;
    const isShort = pos.isShort ?? pos.direction === 'SELL';

    const grossPnl = isShort
      ? (pos.entryPrice - exitPrice) * pos.quantity
      : (exitPrice - pos.entryPrice) * pos.quantity;

    const pnlPct = ((exitPrice - pos.entryPrice) / pos.entryPrice) * 100
      * (isShort ? -1 : 1);

    // Fix BUG-15: use calcTradeCost from brokerage.js instead of _calcLegCost
    // This ensures backtest fees always stay in sync with live trading fees.
    const entryCostSide = isShort ? 'SELL' : 'BUY';
    const exitCostSide  = isShort ? 'BUY'  : 'SELL';
    const entryCost = calcTradeCost({ side: entryCostSide, price: pos.entryPrice, quantity: pos.quantity });
    const exitCost  = calcTradeCost({ side: exitCostSide,  price: exitPrice,      quantity: pos.quantity });
    const totalCost = entryCost.total + exitCost.total;
    const netPnl = grossPnl - totalCost;

    const trade = {
      symbol: pos.symbol,
      strategy: pos.strategy,
      side: pos.direction,   // 'BUY' = long entry, 'SELL' = short entry
      isShort,
      entryPrice: pos.entryPrice,
      exitPrice,
      quantity: pos.quantity,
      grossPnl: Math.round(grossPnl * 100) / 100,
      totalCost: Math.round(totalCost * 100) / 100,
      pnl: Math.round(netPnl * 100) / 100,   // net after costs
      pnlPct: Math.round(pnlPct * 100) / 100,
      exitReason,
      entryTime: pos.entryTime,
      exitTime: candle.date,
      entryReason: pos.entryReason,
      confidence: pos.confidence,
    };

    this.trades.push(trade);
    this.capital += netPnl;   // compound capital with net P&L
    this.position = null;
  }

  _resolveStrategyNames(input) {
    if (!input) return ALL_STRATEGIES;
    const list = Array.isArray(input) ? input : [input];
    if (list.includes('all')) return ALL_STRATEGIES;
    for (const name of list) {
      if (!STRATEGY_MAP[name]) throw new Error(`Unknown strategy: "${name}"`);
    }
    return list;
  }

  async _loadStrategies() {
    const instances = {};
    for (const name of this.strategyNames) {
      const mod = await STRATEGY_MAP[name]();
      // Fix BUG-20: require default export — prevents wrong named export when module has multiple
      const StratClass = mod.default;
      if (typeof StratClass !== 'function') {
        throw new Error(`Strategy module "${name}" must have a default export (got ${typeof StratClass})`);
      }
      instances[name] = new StratClass();
    }
    return instances;
  }
}

// Fix BUG-15: _calcLegCost removed — replaced by calcTradeCost from ../lib/brokerage.js
// Removing the duplicate prevents fee constants from silently diverging when brokerage.js is updated.