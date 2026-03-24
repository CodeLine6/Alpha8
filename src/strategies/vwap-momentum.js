import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';
import { EMA } from 'technicalindicators';

const log = createLogger('strategy:vwap-momentum');

/**
 * VWAP Intraday Momentum Strategy.
 *
 * LIVE SETTINGS SUPPORT:
 *   Call await strategy.refreshParams() once per scan cycle before analyze().
 *   Overridable via /api/live-settings or /set Telegram command:
 *     VWAP_VOLUME_MULTIPLIER  (default: 1.2) — min volume vs avg to confirm signal
 *     VWAP_PRICE_BAND_PCT     (default: 0.2) — % band around VWAP to filter noise
 *     VWAP_VOLUME_AVG_PERIOD  (default: 20)  — period for avg volume calc
 *
 * Uses Volume-Weighted Average Price as dynamic support/resistance.
 * BUY when price crosses above VWAP with volume confirmation,
 * SELL when price crosses below VWAP with volume confirmation.
 *
 * @extends BaseStrategy
 */
export class VWAPMomentumStrategy extends BaseStrategy {
  /**
   * @param {Object} [params]
   * @param {number} [params.volumeMultiplier=1.2]
   * @param {number} [params.priceBandPct=0.2]
   * @param {number} [params.volumeAvgPeriod=20]
   * @param {number} [params.minCandles=15]
   * @param {boolean} [params.anchorToday=true]
   * @param {Function} [params.getLiveSetting]
   */
  constructor(params = {}) {
    super(STRATEGY.VWAP_MOMENTUM, params);

    this._baseVolumeMultiplier = params.volumeMultiplier ?? 1.2;
    this._basePriceBandPct = params.priceBandPct ?? 0.2;
    this._baseVolumeAvgPeriod = params.volumeAvgPeriod ?? 20;

    this.volumeMultiplier = this._baseVolumeMultiplier;
    this.priceBandPct = this._basePriceBandPct;
    this.volumeAvgPeriod = this._baseVolumeAvgPeriod;
    this.minCandles = params.minCandles ?? 15;
    this.anchorToday = params.anchorToday ?? true;

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
      this.volumeMultiplier = await this._getLiveSetting('VWAP_VOLUME_MULTIPLIER', this._baseVolumeMultiplier);
      this.priceBandPct = await this._getLiveSetting('VWAP_PRICE_BAND_PCT', this._basePriceBandPct);
      this.volumeAvgPeriod = await this._getLiveSetting('VWAP_VOLUME_AVG_PERIOD', this._baseVolumeAvgPeriod);

      log.debug({
        volumeMultiplier: this.volumeMultiplier,
        priceBandPct: this.priceBandPct,
        volumeAvgPeriod: this.volumeAvgPeriod,
      }, 'VWAP params refreshed');
    } catch (err) {
      log.warn({ err: err.message }, 'VWAP refreshParams failed — keeping current values');
    }

  }

  /**
   * Calculate VWAP from intraday OHLCV candles.
   * VWAP = Σ(Typical Price × Volume) / Σ(Volume)
   *
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @param {Object} [options]
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @param {Object} [options]
   * @param {boolean} [options.anchorToday=true] - When true, filters to current IST session (09:15 onwards). Set false for backtesting with pre-sliced daily candles.
   * @returns {number[]} Running VWAP values

   */
  calculateVWAP(candles, { anchorToday = true } = {}) {
    let filteredCandles = candles;

    if (anchorToday && candles.length > 0) {
      // Find today's date in IST from the latest candle safely
      const validCandles = candles.filter(c => {
        if (!c) return false;
        const ts = c.timestamp || c.date;
        if (!ts) return false;
        const t = new Date(ts).getTime();

        return !isNaN(t) && t > 0;
      });

      if (validCandles.length === 0) return [];

      let maxTime = -Infinity;
      for (const c of validCandles) {
        const ts = c.timestamp || c.date;
        const t = new Date(ts).getTime();
        if (t > maxTime) maxTime = t;
      }

      // 19800000 = 330 minutes * 60 * 1000 = +5:30 IST

      const latestIstDate = new Date(maxTime + 19800000);
      if (isNaN(latestIstDate.getTime())) return [];

      const todayDateStr = latestIstDate.toISOString().split('T')[0];

      filteredCandles = validCandles.filter(c => {
        const ts = c.timestamp || c.date;
        const cTime = new Date(ts).getTime();
        const istDate = new Date(cTime + 19800000);

        if (isNaN(istDate.getTime())) return false;

        const isToday = istDate.toISOString().split('T')[0] === todayDateStr;

        const uDate = new Date(cTime);
        const utcMinutes = uDate.getUTCHours() * 60 + uDate.getUTCMinutes();
        return isToday && utcMinutes >= 225;
      });

      if (filteredCandles.length < this.minCandles) {
        return [];
      }

    }

    const vwapValues = [];
    let cumulativeTPV = 0;
    let cumulativeVolume = 0;

    for (const c of filteredCandles) {
      const typicalPrice = (c.high + c.low + c.close) / 3;
      cumulativeTPV += typicalPrice * c.volume;
      cumulativeVolume += c.volume;
      vwapValues.push(cumulativeVolume > 0 ? cumulativeTPV / cumulativeVolume : typicalPrice);
    }

    return vwapValues;
  }

  /**
   * Analyze candles for VWAP momentum signals.
   * @param {import('../data/historical-data.js').Candle[]} candles
   * @returns {{ signal: 'BUY'|'SELL'|'HOLD', confidence: number, reason: string }}
   */
  analyze(candles) {
    try {
      if (!candles) {
        return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles?.length || 0}`);
      }

      candles = this.validateCandles(candles);

      if (candles.length < this.minCandles) {
        return this.hold(`Insufficient data: need ${this.minCandles} candles, got ${candles.length}`);
      }

      // Calculate VWAP

      const vwapValues = this.calculateVWAP(candles, { anchorToday: this.anchorToday });

      if (vwapValues.length === 0) {
        return this.hold('Insufficient intraday candles for VWAP');
      }

      const closes = candles.map((c) => c.close);
      const volumes = candles.map((c) => c.volume);

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
      
      // Calculate EMA50 for broad trend filtering
      let ema50 = null;
      if (closes.length >= 50) {
        const emaValues = EMA.calculate({ period: 50, values: closes });
        if (emaValues.length > 0) ema50 = emaValues[emaValues.length - 1];
      }
      const isBroadTrendUp = ema50 ? currentPrice > ema50 : false;

      // Volume confirmation
      const volumeRatio = avgVolume > 0 ? currentVolume / avgVolume : 0;
      const hasVolumeConfirmation = volumeRatio >= this.volumeMultiplier;
      // Asymmetric volume requirement: if counter-trend shorting, require 1.5x more volume
      const counterTrendShortVolumeReq = this.volumeMultiplier * 1.5;
      const hasCounterTrendVolume = volumeRatio >= counterTrendShortVolumeReq;

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
        // If the broad trend is up, we must have extreme volume to justify shorting
        if (isBroadTrendUp && !hasCounterTrendVolume) {
          log.debug({ currentPrice, ema50, volumeRatio }, 'Blocked VWAP short crossover due to broad uptrend EMA50 filter.');
        } else {
          let confidence = 45;
          confidence += Math.min(absDeviation * 10, 25);
          if (hasVolumeConfirmation) confidence += 20;
          confidence += Math.min(volumeRatio * 5, 10);
          
          if (isBroadTrendUp) confidence -= 15; // penalize counter-trend trades

          const reason =
            `Price crossed below VWAP. ` +
            `Price: ${currentPrice.toFixed(2)}, VWAP: ${currentVWAP.toFixed(2)} (${deviation.toFixed(2)}%). ` +
            `Volume: ${volumeRatio.toFixed(1)}x avg${hasVolumeConfirmation ? ' ✓' : ''}` +
            (isBroadTrendUp ? ` (Counter-Trend)` : '');

          log.info({ signal: SIGNAL.SELL, confidence, deviation, volumeRatio }, reason);
          return this.buildSignal(SIGNAL.SELL, confidence, reason);
        }
      }

      // ─── Momentum continuation (no crossover but trending) ──
      if (absDeviation > bandThreshold * 2 && hasVolumeConfirmation) {
        if (deviation > 0 && currentPrice > previousPrice) {
          const confidence = 40 + Math.min(absDeviation * 10, 20);
          return this.buildSignal(SIGNAL.BUY, confidence,
            `Momentum continuation above VWAP (+${deviation.toFixed(2)}%). Volume confirmed.`);
        }
        if (deviation < 0 && currentPrice < previousPrice) {
          if (isBroadTrendUp) {
            log.debug('Blocked VWAP momentum continuation short due to broad uptrend EMA50.');
            // fall through to neutral
          } else {
            const confidence = 40 + Math.min(absDeviation * 10, 20);
            return this.buildSignal(SIGNAL.SELL, confidence,
              `Momentum continuation below VWAP (${deviation.toFixed(2)}%). Volume confirmed.`);
          }
        }
      }


      // ─── Neutral ─────────────────────────────────────────

      const side = deviation > 0 ? 'above' : 'below';
      return this.hold(
        `Price ${side} VWAP (${deviation.toFixed(2)}%). ` +
        `VWAP=${currentVWAP.toFixed(2)}. Volume: ${volumeRatio.toFixed(1)}x avg`
      );
    } catch (err) {
      // We append a specialized tag so if this bubbles up, we know EXACTLY where it came from.

      err.message = '[VWAP_CRITICAL] ' + err.message + '\nStack: ' + err.stack;
      throw err;
    }
  }
}