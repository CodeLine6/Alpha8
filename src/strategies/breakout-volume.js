import { BollingerBands } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:breakout');

/**
 * Breakout Detection with Volume Confirmation Strategy.
 *
 * LIVE SETTINGS SUPPORT:
 *   Call await strategy.refreshParams() once per scan cycle before analyze().
 *   Overridable via /api/live-settings or /set Telegram command:
 *     BREAKOUT_LOOKBACK           (default: 20)
 *     BREAKOUT_VOLUME_MULTIPLIER  (default: 1.5)
 *     BREAKOUT_BB_PERIOD          (default: 20)
 *     BREAKOUT_BB_STDDEV          (default: 2)
 *
 * @extends BaseStrategy
 */
export class BreakoutVolumeStrategy extends BaseStrategy {
  constructor(params = {}) {
    super(STRATEGY.BREAKOUT_VOLUME, params);

    this._baseLookbackPeriod = params.lookbackPeriod ?? 20;
    this._baseVolumeMultiplier = params.volumeMultiplier ?? 1.5;
    this._baseBbPeriod = params.bbPeriod ?? 20;
    this._baseBbStdDev = params.bbStdDev ?? 2;

    this.lookbackPeriod = this._baseLookbackPeriod;
    this.volumeMultiplier = this._baseVolumeMultiplier;
    this.bbPeriod = this._baseBbPeriod;
    this.bbStdDev = this._baseBbStdDev;
    this.minCandles = params.minCandles ?? 25;

    this._getLiveSetting = params.getLiveSetting || null;
  }

  async refreshParams() {
    if (!this._getLiveSetting) return;

    try {
      this.lookbackPeriod = await this._getLiveSetting('BREAKOUT_LOOKBACK', this._baseLookbackPeriod);
      this.volumeMultiplier = await this._getLiveSetting('BREAKOUT_VOLUME_MULTIPLIER', this._baseVolumeMultiplier);
      this.bbPeriod = await this._getLiveSetting('BREAKOUT_BB_PERIOD', this._baseBbPeriod);
      this.bbStdDev = await this._getLiveSetting('BREAKOUT_BB_STDDEV', this._baseBbStdDev);
      this.minCandles = Math.max(this.lookbackPeriod + 5, 25);

      log.debug({
        lookbackPeriod: this.lookbackPeriod, volumeMultiplier: this.volumeMultiplier,
        bbPeriod: this.bbPeriod, bbStdDev: this.bbStdDev, minCandles: this.minCandles,
      }, 'Breakout params refreshed');
    } catch (err) {
      log.warn({ err: err.message }, 'Breakout refreshParams failed — keeping current values');
    }
  }

  analyze(candles) {
    if (!candles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles?.length || 0}`);
    }

    candles = this.validateCandles(candles);

    if (candles.length < this.minCandles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles.length}`);
    }

    const closes = candles.map((c) => c.close);
    const highs = candles.map((c) => c.high);
    const lows = candles.map((c) => c.low);
    const volumes = candles.map((c) => c.volume);

    const currentPrice = closes[closes.length - 1];
    const currentVolume = volumes[volumes.length - 1];

    const lookbackHighs = highs.slice(-this.lookbackPeriod - 1, -1);
    const lookbackLows = lows.slice(-this.lookbackPeriod - 1, -1);
    const resistanceLevel = Math.max(...lookbackHighs);
    const supportLevel = Math.min(...lookbackLows);

    const recentVolumes = volumes.slice(-this.lookbackPeriod - 1, -1);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
    const hasVolumeConfirmation = volumeRatio >= this.volumeMultiplier;

    let bbUpper = null;
    let bbLower = null;

    const bbValues = BollingerBands.calculate({ period: this.bbPeriod, values: closes, stdDev: this.bbStdDev });
    if (bbValues.length > 0) {
      bbUpper = bbValues[bbValues.length - 1].upper;
      bbLower = bbValues[bbValues.length - 1].lower;
    }

    const breakAboveResistance = currentPrice > resistanceLevel;
    const breakAboveBB = bbUpper && currentPrice > bbUpper;
    const breakBelowSupport = currentPrice < supportLevel;
    const breakBelowBB = bbLower && currentPrice < bbLower;

    if (breakAboveResistance || breakAboveBB) {
      let confidence = 40;
      const breakoutPct = ((currentPrice - resistanceLevel) / resistanceLevel) * 100;
      confidence += Math.min(breakoutPct * 10, 20);
      if (hasVolumeConfirmation) { confidence += 25; } else { confidence -= 10; }
      if (breakAboveBB) confidence += 10;
      confidence += Math.min(volumeRatio * 3, 10);

      const reason =
        `Bullish breakout above ${this.lookbackPeriod}-period resistance ` +
        `(${resistanceLevel.toFixed(2)}). Price: ${currentPrice.toFixed(2)} (+${breakoutPct.toFixed(2)}%). ` +
        `Volume: ${volumeRatio.toFixed(1)}x avg${hasVolumeConfirmation ? ' ✓' : ' ✗ (unconfirmed)'}` +
        (breakAboveBB ? `. Above Bollinger upper (${bbUpper.toFixed(2)})` : '');

      log.info({ signal: SIGNAL.BUY, confidence, breakoutPct, volumeRatio }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    if (breakBelowSupport || breakBelowBB) {
      let confidence = 40;
      const breakdownPct = ((supportLevel - currentPrice) / supportLevel) * 100;
      confidence += Math.min(breakdownPct * 10, 20);
      if (hasVolumeConfirmation) { confidence += 25; } else { confidence -= 10; }
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

    const range = resistanceLevel - supportLevel;
    const rangePct = ((range / supportLevel) * 100).toFixed(2);
    return this.hold(
      `No breakout. Range: ${supportLevel.toFixed(2)}-${resistanceLevel.toFixed(2)} (${rangePct}%). ` +
      `Price: ${currentPrice.toFixed(2)}. Volume: ${volumeRatio.toFixed(1)}x avg`
    );
  }
}