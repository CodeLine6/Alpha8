import { RSI } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:rsi-reversion');

/**
 * RSI-based Mean Reversion Strategy.
 *
 * LIVE SETTINGS SUPPORT:
 *   Call await strategy.refreshParams() once per scan cycle before analyze().
 *   Overridable via /api/live-settings or /set Telegram command:
 *     RSI_PERIOD             (default: 14)
 *     RSI_OVERSOLD           (default: 30)
 *     RSI_OVERBOUGHT         (default: 70)
 *     RSI_EXTREME_OVERSOLD   (default: 20)
 *     RSI_EXTREME_OVERBOUGHT (default: 80)
 *
 * @extends BaseStrategy
 */
export class RSIMeanReversionStrategy extends BaseStrategy {
  /**
   * @param {Object} [params]
   * @param {number} [params.period=14]
   * @param {number} [params.oversold=30]
   * @param {number} [params.overbought=70]
   * @param {number} [params.extremeOversold=20]
   * @param {number} [params.extremeOverbought=80]
   * @param {number} [params.minCandles=20]
   * @param {Function} [params.getLiveSetting]
   */
  constructor(params = {}) {
    super(STRATEGY.RSI_MEAN_REVERSION, params);

    this._basePeriod = params.period ?? 14;
    this._baseOversold = params.oversold ?? 30;
    this._baseOverbought = params.overbought ?? 70;
    this._baseExtremeOversold = params.extremeOversold ?? 20;
    this._baseExtremeOverbought = params.extremeOverbought ?? 80;

    this.period = this._basePeriod;
    this.oversold = this._baseOversold;
    this.overbought = this._baseOverbought;
    this.extremeOversold = this._baseExtremeOversold;
    this.extremeOverbought = this._baseExtremeOverbought;
    this.minCandles = params.minCandles ?? 20;

    this._getLiveSetting = params.getLiveSetting || null;
  }

  /**
   * Pull latest parameter overrides from Redis.
   * Call once per scan cycle before analyze().
   * @returns {Promise<void>}
   */
  async refreshParams() {
    if (!this._getLiveSetting) return;

    try {
      this.period = await this._getLiveSetting('RSI_PERIOD', this._basePeriod);
      this.oversold = await this._getLiveSetting('RSI_OVERSOLD', this._baseOversold);
      this.overbought = await this._getLiveSetting('RSI_OVERBOUGHT', this._baseOverbought);
      this.extremeOversold = await this._getLiveSetting('RSI_EXTREME_OVERSOLD', this._baseExtremeOversold);
      this.extremeOverbought = await this._getLiveSetting('RSI_EXTREME_OVERBOUGHT', this._baseExtremeOverbought);

      // Guard: extreme levels must sit inside oversold/overbought range
      if (this.extremeOversold >= this.oversold) {
        log.warn({ extremeOversold: this.extremeOversold, oversold: this.oversold },
          'RSI_EXTREME_OVERSOLD must be < RSI_OVERSOLD — clamping');
        this.extremeOversold = this.oversold - 5;
      }
      if (this.extremeOverbought <= this.overbought) {
        log.warn({ extremeOverbought: this.extremeOverbought, overbought: this.overbought },
          'RSI_EXTREME_OVERBOUGHT must be > RSI_OVERBOUGHT — clamping');
        this.extremeOverbought = this.overbought + 5;
      }

      log.debug({
        period: this.period, oversold: this.oversold, overbought: this.overbought,
        extremeOversold: this.extremeOversold, extremeOverbought: this.extremeOverbought,
      }, 'RSI params refreshed');
    } catch (err) {
      log.warn({ err: err.message }, 'RSI refreshParams failed — keeping current values');
    }
  }

  /**
   * Analyze candles for RSI-based mean reversion signals.
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
    const rsiValues = RSI.calculate({ period: this.period, values: closes });

    if (rsiValues.length < 2) {
      return this.hold('Not enough RSI data points');
    }

    const currentRSI = rsiValues[rsiValues.length - 1];
    const previousRSI = rsiValues[rsiValues.length - 2];
    const currentPrice = closes[closes.length - 1];

    // ─── Oversold → BUY ──────────────────────────────────
    if (currentRSI < this.oversold) {
      const isReversingUp = currentRSI > previousRSI;
      let confidence = 50;
      confidence += (this.oversold - currentRSI) * 1.5;
      if (isReversingUp) confidence += 15;
      if (currentRSI < this.extremeOversold) confidence += 10;

      const reason =
        `RSI oversold at ${currentRSI.toFixed(1)} (threshold: ${this.oversold}). ` +
        `${isReversingUp ? 'RSI turning up — reversal likely.' : 'Still declining.'} ` +
        `Price: ${currentPrice.toFixed(2)}`;

      log.info({ signal: SIGNAL.BUY, rsi: currentRSI, confidence }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    // ─── Overbought → SELL ───────────────────────────────
    if (currentRSI > this.overbought) {
      const isReversingDown = currentRSI < previousRSI;
      let confidence = 50;
      confidence += (currentRSI - this.overbought) * 1.5;
      if (isReversingDown) confidence += 15;
      if (currentRSI > this.extremeOverbought) confidence += 10;

      const reason =
        `RSI overbought at ${currentRSI.toFixed(1)} (threshold: ${this.overbought}). ` +
        `${isReversingDown ? 'RSI turning down — reversal likely.' : 'Still climbing.'} ` +
        `Price: ${currentPrice.toFixed(2)}`;

      log.info({ signal: SIGNAL.SELL, rsi: currentRSI, confidence }, reason);
      return this.buildSignal(SIGNAL.SELL, confidence, reason);
    }

    return this.hold(
      `RSI neutral at ${currentRSI.toFixed(1)} ` +
      `(oversold: <${this.oversold}, overbought: >${this.overbought}). Price: ${currentPrice.toFixed(2)}`
    );
  }
}