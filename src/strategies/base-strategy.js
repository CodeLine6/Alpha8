import { SIGNAL } from '../config/constants.js';

/**
 * Base Strategy class — all trading strategies extend this.
 *
 * Every strategy must implement the `analyze()` method and return
 * a standardized signal object.
 *
 * @abstract
 * @module base-strategy
 */
export class BaseStrategy {
  /**
   * @param {string} name - Strategy identifier
   * @param {Object} [params={}] - Strategy-specific parameters
   */
  constructor(name, params = {}) {
    this.name = name;
    this.params = params;
  }

  /**
   * Analyze candle data and generate a trading signal.
   * Must be overridden by subclasses.
   *
   * @abstract
   * @param {import('../data/historical-data.js').Candle[]} candles - OHLCV candle array (oldest → newest)
   * @param {Object} [context={}] - Additional context (e.g. current price, volume)
   * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
   */
  analyze(candles, context = {}) {
    throw new Error(`${this.name}: analyze() must be implemented`);
  }

  /**
   * Build a standardized signal response.
   * @protected
   * @param {'BUY'|'SELL'|'HOLD'} signal
   * @param {number} confidence - 0–100
   * @param {string} reason - Human-readable explanation
   * @returns {{ signal: string, confidence: number, reason: string, strategy: string, timestamp: string }}
   */
  buildSignal(signal, confidence, reason) {
    return {
      signal,
      confidence: Math.max(0, Math.min(100, Math.round(confidence))),
      reason,
      strategy: this.name,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Convenience: return a HOLD signal.
   * @protected
   * @param {string} reason
   * @returns {Object}
   */
  hold(reason) {
    return this.buildSignal(SIGNAL.HOLD, 0, reason);
  }

  /**
   * Validate and clean candles array before analysis.
   * @protected
   * @param {any[]} candles
   * @returns {import('../data/historical-data.js').Candle[]}
   */
  validateCandles(candles) {
    if (!Array.isArray(candles)) return [];
    return candles.filter(c => c && typeof c.close === 'number' && !isNaN(c.close));
  }
}
