import { SIGNAL } from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('base-strategy');

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
    const clampedConfidence = Math.min(Math.max(confidence, 0), 100);

    if (clampedConfidence !== confidence) {
      log.debug({ strategy: this.name, rawConfidence: confidence, clampedTo: clampedConfidence }, 'Confidence value clamped');
    }

    return {
      signal,
      confidence: Math.round(clampedConfidence),
      reason,
      strategy: this.name,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Filter out malformed candles before analysis.
   * Runs sequentially on OHLC arrays to ensure clean indicators.
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {import('../data/historical-data.js').Candle[]}
   */
  validateCandles(candles) {
    const valid = [];
    let skipped = 0;

    for (let c of candles) {
      // Feature 10: Strict Volume Casting Base Patch
      // Explicitly convert string volumes to numbers to prevent .reduce() concatenation bugs
      if (c.volume !== undefined && c.volume !== null) {
        c.volume = Number(c.volume);
      }

      const isValid =
        typeof c.close === 'number' && c.close > 0 && !isNaN(c.close) &&
        typeof c.high === 'number' && c.high > 0 && !isNaN(c.high) &&
        typeof c.low === 'number' && c.low > 0 && !isNaN(c.low) &&
        typeof c.open === 'number' && c.open > 0 && !isNaN(c.open) &&
        typeof c.volume === 'number' && c.volume >= 0 && !isNaN(c.volume) &&
        c.high >= c.low &&
        c.high >= c.close &&
        c.low <= c.close;

      if (isValid) {
        valid.push(c);
      } else {
        skipped++;
      }
    }

    if (skipped > 0) {
      log.warn({
        strategy: this.name,
        totalCandles: candles.length,
        validCandles: valid.length,
        skipped,
      }, 'Malformed candles detected and removed before analysis');
    }

    return valid;
  }

  /**
   * Convenience: return a HOLD signal.
   * @protected
   * @param {string} reason
   * @returns {Object}
   */
  hold(reason) {
    // Pass exactly 0 for HOLD signals, ensuring it's bounded
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
