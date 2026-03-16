import { EMA } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:ema-crossover');

/**
 * EMA 9/21 Moving Average Crossover Strategy.
 *
 * LIVE SETTINGS SUPPORT:
 *   Call await strategy.refreshParams() once per scan cycle before analyze().
 *   Overridable via /api/live-settings or /set Telegram command:
 *     EMA_FAST_PERIOD   (default: 9)
 *     EMA_SLOW_PERIOD   (default: 21)
 *     EMA_MIN_CANDLES   (default: auto = slowPeriod + 5, min 25)
 *
 * Generates BUY when fast EMA (9) crosses above slow EMA (21),
 * and SELL when fast crosses below slow.
 *
 * Confidence is based on the magnitude of the crossover gap
 * relative to the current price.
 *
 * @extends BaseStrategy
 */
export class EMACrossoverStrategy extends BaseStrategy {
  /**
   * @param {Object} [params]
   * @param {number} [params.fastPeriod=9] - Fast EMA period
   * @param {number} [params.slowPeriod=21] - Slow EMA period
   * @param {number} [params.minCandles=25] - Minimum candles required
   * @param {Function} [params.getLiveSetting] - Live settings reader fn(key, fallback)
   */
  constructor(params = {}) {
    super(STRATEGY.EMA_CROSSOVER, params);

    // Base defaults — used as fallback when no live override is set
    this._baseFastPeriod = params.fastPeriod ?? 9;
    this._baseSlowPeriod = params.slowPeriod ?? 21;

    // Live (active) values — start as base, updated by refreshParams()
    this.fastPeriod = this._baseFastPeriod;
    this.slowPeriod = this._baseSlowPeriod;
    this.minCandles = params.minCandles ?? Math.max(this.slowPeriod + 5, 25);

    // Optional live settings provider
    this._getLiveSetting = params.getLiveSetting || null;
  }

  /**
   * Pull latest parameter overrides from Redis.
   * Call once per scan cycle before analyze().
   * Safe to call even if getLiveSetting is not configured — no-op in that case.
   *
   * @returns {Promise<void>}
   */
  async refreshParams() {
    if (!this._getLiveSetting) return;

    try {
      this.fastPeriod = await this._getLiveSetting('EMA_FAST_PERIOD', this._baseFastPeriod);
      this.slowPeriod = await this._getLiveSetting('EMA_SLOW_PERIOD', this._baseSlowPeriod);

      // N7 FIX: prevent inverted periods. fast >= slow produces permanent HOLD
      // (equal periods) or mirrored signals (fast > slow) with no warning.
      if (this.fastPeriod >= this.slowPeriod) {
        log.warn({ fastPeriod: this.fastPeriod, slowPeriod: this.slowPeriod },
          'EMA fastPeriod must be < slowPeriod — clamping fast to slow - 1. Fix via /set EMA_FAST_PERIOD.');
        this.fastPeriod = this.slowPeriod - 1;
      }

      // minCandles must always be >= slowPeriod + 5 to have enough data
      const baseMinCandles = Math.max(this.slowPeriod + 5, 25);
      this.minCandles = await this._getLiveSetting('EMA_MIN_CANDLES', baseMinCandles);

      log.debug({
        fastPeriod: this.fastPeriod,
        slowPeriod: this.slowPeriod,
        minCandles: this.minCandles,
      }, 'EMA params refreshed');
    } catch (err) {
      log.warn({ err: err.message }, 'EMA refreshParams failed — keeping current values');
    }
  }

  /**
   * Analyze candles for EMA crossover signals.
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
   */
  analyze(candles) {
    if (!candles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles?.length || 0}`);
    }

    candles = this.validateCandles(candles);

    if (candles.length < this.minCandles) {
      return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles.length}`);
    }

    const closes = candles.map((c) => c.close);

    // Calculate EMAs
    const fastEMA = EMA.calculate({ period: this.fastPeriod, values: closes });
    const slowEMA = EMA.calculate({ period: this.slowPeriod, values: closes });

    if (fastEMA.length < 2 || slowEMA.length < 2) {
      return this.hold('Not enough EMA data points for crossover detection');
    }

    // EMA library outputs same-length arrays; tail indexing is safe without offset

    const currentFast = fastEMA[fastEMA.length - 1];
    const previousFast = fastEMA[fastEMA.length - 2];
    const currentSlow = slowEMA[slowEMA.length - 1];
    const previousSlow = slowEMA[slowEMA.length - 2];

    const currentPrice = closes[closes.length - 1];
    const gap = currentFast - currentSlow;
    const gapPct = Math.abs(gap / currentPrice) * 100;

    // Detect crossover
    const bullishCross = previousFast <= previousSlow && currentFast > currentSlow;
    const bearishCross = previousFast >= previousSlow && currentFast < currentSlow;

    // Trend strength: how far apart the EMAs are
    const trendStrength = Math.min(gapPct * 20, 50);

    // Momentum confirmation: is price above/below both EMAs?
    const priceAboveBoth = currentPrice > currentFast && currentPrice > currentSlow;
    const priceBelowBoth = currentPrice < currentFast && currentPrice < currentSlow;
    const momentumBonus = (priceAboveBoth || priceBelowBoth) ? 20 : 0;

    if (bullishCross) {
      const confidence = 50 + trendStrength + momentumBonus;
      const reason =
        `EMA ${this.fastPeriod} (${currentFast.toFixed(2)}) crossed above ` +
        `EMA ${this.slowPeriod} (${currentSlow.toFixed(2)}). ` +
        `Gap: ${gapPct.toFixed(2)}%. Price: ${currentPrice.toFixed(2)}`;

      log.info({ signal: SIGNAL.BUY, confidence, gapPct }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    if (bearishCross) {
      const confidence = 50 + trendStrength + momentumBonus;
      const reason =
        `EMA ${this.fastPeriod} (${currentFast.toFixed(2)}) crossed below ` +
        `EMA ${this.slowPeriod} (${currentSlow.toFixed(2)}). ` +
        `Gap: ${gapPct.toFixed(2)}%. Price: ${currentPrice.toFixed(2)}`;

      log.info({ signal: SIGNAL.SELL, confidence, gapPct }, reason);
      return this.buildSignal(SIGNAL.SELL, confidence, reason);
    }

    // No crossover — report trend direction
    const trendDir = currentFast > currentSlow ? 'bullish' : 'bearish';
    return this.hold(
      `No crossover. Trend: ${trendDir}. ` +
      `EMA${this.fastPeriod}=${currentFast.toFixed(2)}, EMA${this.slowPeriod}=${currentSlow.toFixed(2)}`
    );
  }
}