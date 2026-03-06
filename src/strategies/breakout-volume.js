import { SMA, BollingerBands } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:breakout');

/**
 * Breakout Detection with Volume Confirmation Strategy.
 *
 * Detects price breakouts above resistance or below support levels
 * using a lookback period. Confirmed by above-average volume.
 *
 * Uses Bollinger Bands as dynamic resistance/support and also checks
 * for N-period high/low breakouts.
 *
 * @extends BaseStrategy
 */
export class BreakoutVolumeStrategy extends BaseStrategy {
  /**
   * @param {Object} [params]
   * @param {number} [params.lookbackPeriod=20] - Candles to look back for high/low
   * @param {number} [params.volumeMultiplier=1.5] - Volume must be this × avg for confirmation
   * @param {number} [params.bbPeriod=20] - Bollinger Band period
   * @param {number} [params.bbStdDev=2] - Bollinger Band standard deviations
   * @param {number} [params.minCandles=25] - Minimum candles
   */
  constructor(params = {}) {
    super(STRATEGY.BREAKOUT_VOLUME, params);
    this.lookbackPeriod = params.lookbackPeriod ?? 20;
    this.volumeMultiplier = params.volumeMultiplier ?? 1.5;
    this.bbPeriod = params.bbPeriod ?? 20;
    this.bbStdDev = params.bbStdDev ?? 2;
    this.minCandles = params.minCandles ?? 25;
  }

  /**
   * Analyze candles for breakout signals with volume confirmation.
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
   */
  analyze(candles) {
    if (!candles || candles.length < this.minCandles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles?.length || 0}`);
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    // ─── Lookback High/Low ───────────────────────────────
    const lookbackHighs = highs.slice(-this.lookbackPeriod - 1, -1); // exclude current
    const lookbackLows = lows.slice(-this.lookbackPeriod - 1, -1);
    const resistanceLevel = Math.max(...lookbackHighs);
    const supportLevel = Math.min(...lookbackLows);

    // ─── Volume Analysis ─────────────────────────────────
    const recentVolumes = volumes.slice(-this.lookbackPeriod - 1, -1);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
    const hasVolumeConfirmation = volumeRatio >= this.volumeMultiplier;

    // ─── Bollinger Bands ─────────────────────────────────
    let bbUpper = null;
    let bbLower = null;
    let bbMiddle = null;

    const bbValues = BollingerBands.calculate({
      period: this.bbPeriod,
      values: closes,
      stdDev: this.bbStdDev,
    });

    if (bbValues.length > 0) {
      const lastBB = bbValues[bbValues.length - 1];
      bbUpper = lastBB.upper;
      bbLower = lastBB.lower;
      bbMiddle = lastBB.middle;
    }

    // ─── Breakout Detection ──────────────────────────────

    // Bullish breakout: price breaks above resistance
    const breakAboveResistance = currentPrice > resistanceLevel;
    const breakAboveBB = bbUpper && currentPrice > bbUpper;

    // Bearish breakdown: price breaks below support
    const breakBelowSupport = currentPrice < supportLevel;
    const breakBelowBB = bbLower && currentPrice < bbLower;

    // ─── Bullish Breakout ────────────────────────────────
    if (breakAboveResistance || breakAboveBB) {
      let confidence = 40;

      // Breakout strength: how far above resistance
      const breakoutPct = ((currentPrice - resistanceLevel) / resistanceLevel) * 100;
      confidence += Math.min(breakoutPct * 10, 20);

      // Volume confirmation is critical for breakouts
      if (hasVolumeConfirmation) {
        confidence += 25;
      } else {
        confidence -= 10; // penalty for no volume — could be false breakout
      }

      // Bollinger Band bonus
      if (breakAboveBB) confidence += 10;

      // Volume strength bonus
      confidence += Math.min(volumeRatio * 3, 10);

      const reason =
        `Bullish breakout above ${this.lookbackPeriod}-period resistance ` +
        `(${resistanceLevel.toFixed(2)}). Price: ${currentPrice.toFixed(2)} (+${breakoutPct.toFixed(2)}%). ` +
        `Volume: ${volumeRatio.toFixed(1)}x avg${hasVolumeConfirmation ? ' ✓' : ' ✗ (unconfirmed)'}` +
        (breakAboveBB ? `. Above Bollinger upper (${bbUpper.toFixed(2)})` : '');

      log.info({ signal: SIGNAL.BUY, confidence, breakoutPct, volumeRatio }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    // ─── Bearish Breakdown ───────────────────────────────
    if (breakBelowSupport || breakBelowBB) {
      let confidence = 40;

      const breakdownPct = ((supportLevel - currentPrice) / supportLevel) * 100;
      confidence += Math.min(breakdownPct * 10, 20);

      if (hasVolumeConfirmation) {
        confidence += 25;
      } else {
        confidence -= 10;
      }

      if (breakBelowBB) confidence += 10;
      confidence += Math.min(volumeRatio * 3, 10);

      const reason =
        `Bearish breakdown below ${this.lookbackPeriod}-period support ` +
        `(${supportLevel.toFixed(2)}). Price: ${currentPrice.toFixed(2)} (-${breakdownPct.toFixed(2)}%). ` +
        `Volume: ${volumeRatio.toFixed(1)}x avg${hasVolumeConfirmation ? ' ✓' : ' ✗ (unconfirmed)'}` +
        (breakBelowBB ? `. Below Bollinger lower (${bbLower.toFixed(2)})` : '');

      log.info({ signal: SIGNAL.SELL, confidence, breakdownPct, volumeRatio }, reason);
      return this.buildSignal(SIGNAL.SELL, confidence, reason);
    }

    // ─── No breakout ─────────────────────────────────────
    const range = resistanceLevel - supportLevel;
    const rangePct = ((range / supportLevel) * 100).toFixed(2);
    return this.hold(
      `No breakout. Range: ${supportLevel.toFixed(2)}–${resistanceLevel.toFixed(2)} (${rangePct}%). ` +
      `Price: ${currentPrice.toFixed(2)}. Volume: ${volumeRatio.toFixed(1)}x avg`
    );
  }
}
