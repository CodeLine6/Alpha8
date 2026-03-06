import { VWAP, SMA } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:vwap-momentum');

/**
 * VWAP Intraday Momentum Strategy.
 *
 * Uses Volume-Weighted Average Price as dynamic support/resistance.
 * BUY when price crosses above VWAP with volume confirmation,
 * SELL when price crosses below VWAP with volume confirmation.
 *
 * Best suited for intraday (MIS) trades.
 *
 * @extends BaseStrategy
 */
export class VWAPMomentumStrategy extends BaseStrategy {
  /**
   * @param {Object} [params]
   * @param {number} [params.volumeMultiplier=1.2] - Min volume vs avg to confirm signal
   * @param {number} [params.priceBandPct=0.2] - % band around VWAP to filter noise
   * @param {number} [params.volumeAvgPeriod=20] - Period for avg volume calc
   * @param {number} [params.minCandles=15] - Minimum candles
   */
  constructor(params = {}) {
    super(STRATEGY.VWAP_MOMENTUM, params);
    this.volumeMultiplier = params.volumeMultiplier ?? 1.2;
    this.priceBandPct = params.priceBandPct ?? 0.2;
    this.volumeAvgPeriod = params.volumeAvgPeriod ?? 20;
    this.minCandles = params.minCandles ?? 15;
  }

  /**
   * Calculate VWAP from intraday OHLCV candles.
   * VWAP = Σ(Typical Price × Volume) / Σ(Volume)
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {number[]} Running VWAP values
   */
  calculateVWAP(candles) {
    const vwapValues = [];
    let cumulativeTPV = 0; // Typical Price × Volume
    let cumulativeVolume = 0;

    for (const c of candles) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      cumulativeTPV += typicalPrice * c.volume;
      cumulativeVolume += c.volume;
      vwapValues.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
    }

    return vwapValues;
  }

  /**
   * Analyze candles for VWAP momentum signals.
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
   */
  analyze(candles) {
    if (!candles || candles.length < this.minCandles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles?.length || 0}`);
    }

    const closes = candles.map((c) => c.close);
    const volumes = candles.map((c) => c.volume);

    // Calculate VWAP
    const vwapValues = this.calculateVWAP(candles);
    const currentVWAP = vwapValues[vwapValues.length - 1];
    const previousVWAP = vwapValues[vwapValues.length - 2];

    const currentPrice = closes[closes.length - 1];
    const previousPrice = closes[closes.length - 2];
    const currentVolume = volumes[volumes.length - 1];

    // Average volume
    const recentVolumes = volumes.slice(-this.volumeAvgPeriod);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;

    // Price deviation from VWAP
    const deviation = ((currentPrice - currentVWAP) / currentVWAP) * 100;
    const absDeviation = Math.abs(deviation);
    const bandThreshold = this.priceBandPct;

    // Volume confirmation
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
    const hasVolumeConfirmation = volumeRatio >= this.volumeMultiplier;

    // Detect VWAP crossover
    const bullishCross = previousPrice <= previousVWAP && currentPrice > currentVWAP;
    const bearishCross = previousPrice >= previousVWAP && currentPrice < currentVWAP;

    // ─── Bullish: Price crosses above VWAP ───────────────
    if (bullishCross && absDeviation > bandThreshold) {
      let confidence = 45;
      confidence += Math.min(absDeviation * 10, 25); // deviation bonus
      if (hasVolumeConfirmation) confidence += 20; // volume bonus
      confidence += Math.min(volumeRatio * 5, 10); // extra volume strength

      const reason =
        `Price crossed above VWAP. ` +
        `Price: ${currentPrice.toFixed(2)}, VWAP: ${currentVWAP.toFixed(2)} (+${deviation.toFixed(2)}%). ` +
        `Volume: ${volumeRatio.toFixed(1)}x avg${hasVolumeConfirmation ? ' ✓' : ''}`;

      log.info({ signal: SIGNAL.BUY, confidence, deviation, volumeRatio }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    // ─── Bearish: Price crosses below VWAP ───────────────
    if (bearishCross && absDeviation > bandThreshold) {
      let confidence = 45;
      confidence += Math.min(absDeviation * 10, 25);
      if (hasVolumeConfirmation) confidence += 20;
      confidence += Math.min(volumeRatio * 5, 10);

      const reason =
        `Price crossed below VWAP. ` +
        `Price: ${currentPrice.toFixed(2)}, VWAP: ${currentVWAP.toFixed(2)} (${deviation.toFixed(2)}%). ` +
        `Volume: ${volumeRatio.toFixed(1)}x avg${hasVolumeConfirmation ? ' ✓' : ''}`;

      log.info({ signal: SIGNAL.SELL, confidence, deviation, volumeRatio }, reason);
      return this.buildSignal(SIGNAL.SELL, confidence, reason);
    }

    // ─── Momentum continuation (no crossover but trending) ──
    if (absDeviation > bandThreshold * 2 && hasVolumeConfirmation) {
      if (deviation > 0 && currentPrice > previousPrice) {
        const confidence = 35 + Math.min(absDeviation * 5, 20);
        return this.buildSignal(SIGNAL.BUY, confidence,
          `Momentum continuation above VWAP (+${deviation.toFixed(2)}%). Volume confirmed.`);
      }
      if (deviation < 0 && currentPrice < previousPrice) {
        const confidence = 35 + Math.min(absDeviation * 5, 20);
        return this.buildSignal(SIGNAL.SELL, confidence,
          `Momentum continuation below VWAP (${deviation.toFixed(2)}%). Volume confirmed.`);
      }
    }

    // ─── Neutral ─────────────────────────────────────────
    const side = deviation > 0 ? 'above' : 'below';
    return this.hold(
      `Price ${side} VWAP (${deviation.toFixed(2)}%). ` +
      `VWAP=${currentVWAP.toFixed(2)}. Volume: ${volumeRatio.toFixed(1)}x avg`
    );
  }
}
