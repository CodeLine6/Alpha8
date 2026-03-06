import { RSI } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:rsi-reversion');

/**
 * RSI-based Mean Reversion Strategy.
 *
 * Generates BUY when RSI drops below oversold threshold (< 30),
 * and SELL when RSI rises above overbought threshold (> 70).
 *
 * Confidence scales with how extreme the RSI reading is.
 *
 * @extends BaseStrategy
 */
export class RSIMeanReversionStrategy extends BaseStrategy {
  /**
   * @param {Object} [params]
   * @param {number} [params.period=14] - RSI calculation period
   * @param {number} [params.oversold=30] - Oversold threshold
   * @param {number} [params.overbought=70] - Overbought threshold
   * @param {number} [params.extremeOversold=20] - Extreme oversold level
   * @param {number} [params.extremeOverbought=80] - Extreme overbought level
   * @param {number} [params.minCandles=20] - Minimum candles required
   */
  constructor(params = {}) {
    super(STRATEGY.RSI_MEAN_REVERSION, params);
    this.period = params.period ?? 14;
    this.oversold = params.oversold ?? 30;
    this.overbought = params.overbought ?? 70;
    this.extremeOversold = params.extremeOversold ?? 20;
    this.extremeOverbought = params.extremeOverbought ?? 80;
    this.minCandles = params.minCandles ?? 20;
  }

  /**
   * Analyze candles for RSI-based mean reversion signals.
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
   */
  analyze(candles) {
    if (!candles || candles.length < this.minCandles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles?.length || 0}`);
    }

    const closes = candles.map((c) => c.close);

    const rsiValues = RSI.calculate({ period: this.period, values: closes });

    if (rsiValues.length < 2) {
      return this.hold('Not enough RSI data points');
    }

    const currentRSI = rsiValues[rsiValues.length - 1];
    const previousRSI = rsiValues[rsiValues.length - 2];
    const currentPrice = closes[closes.length - 1];

    // ─── Oversold → BUY signal ───────────────────────────
    if (currentRSI < this.oversold) {
      // RSI turning up from oversold = stronger signal
      const isReversingUp = currentRSI > previousRSI;

      // Confidence: deeper oversold = higher confidence
      let confidence = 50;

      // Depth bonus: RSI 30→50, RSI 20→70, RSI 10→90
      const depth = this.oversold - currentRSI;
      confidence += depth * 1.5;

      // Reversal confirmation bonus
      if (isReversingUp) confidence += 15;

      // Extreme oversold bonus
      if (currentRSI < this.extremeOversold) confidence += 10;

      const reason =
        `RSI oversold at ${currentRSI.toFixed(1)} (threshold: ${this.oversold}). ` +
        `${isReversingUp ? 'RSI turning up — reversal likely.' : 'Still declining.'} ` +
        `Price: ${currentPrice.toFixed(2)}`;

      log.info({ signal: SIGNAL.BUY, rsi: currentRSI, confidence }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    // ─── Overbought → SELL signal ────────────────────────
    if (currentRSI > this.overbought) {
      const isReversingDown = currentRSI < previousRSI;

      let confidence = 50;
      const depth = currentRSI - this.overbought;
      confidence += depth * 1.5;

      if (isReversingDown) confidence += 15;
      if (currentRSI > this.extremeOverbought) confidence += 10;

      const reason =
        `RSI overbought at ${currentRSI.toFixed(1)} (threshold: ${this.overbought}). ` +
        `${isReversingDown ? 'RSI turning down — reversal likely.' : 'Still climbing.'} ` +
        `Price: ${currentPrice.toFixed(2)}`;

      log.info({ signal: SIGNAL.SELL, rsi: currentRSI, confidence }, reason);
      return this.buildSignal(SIGNAL.SELL, confidence, reason);
    }

    // ─── Neutral zone ────────────────────────────────────
    return this.hold(
      `RSI neutral at ${currentRSI.toFixed(1)} ` +
      `(oversold: <${this.oversold}, overbought: >${this.overbought}). Price: ${currentPrice.toFixed(2)}`
    );
  }
}
