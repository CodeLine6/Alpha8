import { BollingerBands, EMA } from 'technicalindicators';
import { SIGNAL, STRATEGY } from '../config/constants.js';
import { BaseStrategy } from './base-strategy.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('strategy:breakout');

// ── False-breakout protection constants ─────────────────────────────────
const MIN_BREAKOUT_PCT   = 0.15;  // breakout must exceed resistance/support by this %
const ENTRY_CUTOFF_HOUR  = 14;    // no new breakout entries after 2:30 PM IST
const ENTRY_CUTOFF_MIN   = 30;

/**
 * Breakout Detection with Volume Confirmation Strategy.
 *
 * FALSE-BREAKOUT PROTECTIONS:
 *   1. Minimum breakout magnitude (0.15%) — rejects wick-spike entries
 *   2. Mandatory volume confirmation — no entry without volume surge
 *   3. Time-of-day cutoff (14:30 IST) — late-session breakouts are traps
 *
 * LIVE SETTINGS SUPPORT:
 *   Call await strategy.refreshParams() once per scan cycle before analyze().
 *   Overridable via /api/live-settings or /set Telegram command:
 *     BREAKOUT_LOOKBACK           (default: 20)
 *     BREAKOUT_VOLUME_MULTIPLIER  (default: 1.5)
 *     BREAKOUT_BB_PERIOD          (default: 20)
 *     BREAKOUT_BB_STDDEV          (default: 2)
 *     BREAKOUT_MIN_PCT            (default: 0.15)
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
    this._baseMinBreakoutPct = params.minBreakoutPct ?? MIN_BREAKOUT_PCT;

    this.lookbackPeriod = this._baseLookbackPeriod;
    this.volumeMultiplier = this._baseVolumeMultiplier;
    this.bbPeriod = this._baseBbPeriod;
    this.bbStdDev = this._baseBbStdDev;
    this.minBreakoutPct = this._baseMinBreakoutPct;
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
      this.minBreakoutPct = await this._getLiveSetting('BREAKOUT_MIN_PCT', this._baseMinBreakoutPct);

      // N8 FIX: Bollinger Bands require bbPeriod candles. If bbPeriod > lookbackPeriod + 5,
      // the old formula set minCandles below what BB needs → BB silently disabled every scan.
      this.minCandles = Math.max(this.lookbackPeriod + 5, this.bbPeriod + 5, 25);

      log.debug({
        lookbackPeriod: this.lookbackPeriod, volumeMultiplier: this.volumeMultiplier,
        bbPeriod: this.bbPeriod, bbStdDev: this.bbStdDev, minCandles: this.minCandles,
        minBreakoutPct: this.minBreakoutPct,
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

    // ── Time-of-day guard ─────────────────────────────────────────────────
    // Late-session breakouts (after 2:30 PM) are frequently false — institutional
    // unwinding and square-off pressure cause wick spikes that immediately reverse.
    const now = new Date();
    const istHour = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', hour: 'numeric', hour12: false }));
    const istMin  = Number(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata', minute: 'numeric' }));
    if (istHour > ENTRY_CUTOFF_HOUR || (istHour === ENTRY_CUTOFF_HOUR && istMin >= ENTRY_CUTOFF_MIN)) {
      return this.hold(`Late session (${istHour}:${String(istMin).padStart(2, '0')} IST) — breakout entries blocked after ${ENTRY_CUTOFF_HOUR}:${String(ENTRY_CUTOFF_MIN).padStart(2, '0')}`);
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
    
    // EMA50 Trend Filter
    let ema50 = null;
    if (closes.length >= 50) {
      const emaValues = EMA.calculate({ period: 50, values: closes });
      if (emaValues.length > 0) ema50 = emaValues[emaValues.length - 1];
    }
    const isBroadTrendUp = ema50 ? currentPrice > ema50 : false;

    const breakAboveResistance = currentPrice > resistanceLevel;
    const breakAboveBB = bbUpper && currentPrice > bbUpper;
    const breakBelowSupport = currentPrice < supportLevel;
    const breakBelowBB = bbLower && currentPrice < bbLower;

    // ── Bullish breakout ──────────────────────────────────────────────────
    if (breakAboveResistance || breakAboveBB) {
      const breakoutPct = ((currentPrice - resistanceLevel) / resistanceLevel) * 100;

      // FALSE-BREAKOUT GUARD 1: minimum magnitude
      if (breakoutPct < this.minBreakoutPct) {
        return this.hold(
          `Weak bullish breakout: +${breakoutPct.toFixed(3)}% < min ${this.minBreakoutPct}%. ` +
          `Price ${currentPrice.toFixed(2)} barely above resistance ${resistanceLevel.toFixed(2)}`
        );
      }

      // FALSE-BREAKOUT GUARD 2: mandatory volume confirmation
      if (!hasVolumeConfirmation) {
        return this.hold(
          `Bullish breakout unconfirmed: volume ${volumeRatio.toFixed(1)}x avg < ${this.volumeMultiplier}x required. ` +
          `Price ${currentPrice.toFixed(2)} above resistance ${resistanceLevel.toFixed(2)}`
        );
      }

      let confidence = 40;
      confidence += Math.min(breakoutPct * 10, 20);
      confidence += 25; // volume confirmed (mandatory now)
      if (breakAboveBB) confidence += 10;
      confidence += Math.min(volumeRatio * 3, 10);

      const reason =
        `Bullish breakout above ${this.lookbackPeriod}-period resistance ` +
        `(${resistanceLevel.toFixed(2)}). Price: ${currentPrice.toFixed(2)} (+${breakoutPct.toFixed(2)}%). ` +
        `Volume: ${volumeRatio.toFixed(1)}x avg ✓` +
        (breakAboveBB ? `. Above Bollinger upper (${bbUpper.toFixed(2)})` : '');

      log.info({ signal: SIGNAL.BUY, confidence, breakoutPct, volumeRatio }, reason);
      return this.buildSignal(SIGNAL.BUY, confidence, reason);
    }

    // ── Bearish breakdown ─────────────────────────────────────────────────
    if (breakBelowSupport || breakBelowBB) {
      // Counter-trend block: do not short a breakdown if EMA50 indicates broad uptrend
      if (isBroadTrendUp) {
        log.debug({ currentPrice, ema50, supportLevel }, 'Blocked bearish breakdown sell signal due to broad EMA50 uptrend.');
      } else {
        const breakdownPct = ((supportLevel - currentPrice) / supportLevel) * 100;

        // FALSE-BREAKOUT GUARD 1: minimum magnitude
        if (breakdownPct < this.minBreakoutPct) {
          return this.hold(
            `Weak bearish breakdown: -${breakdownPct.toFixed(3)}% < min ${this.minBreakoutPct}%. ` +
            `Price ${currentPrice.toFixed(2)} barely below support ${supportLevel.toFixed(2)}`
          );
        }

        // FALSE-BREAKOUT GUARD 2: mandatory volume confirmation
        if (!hasVolumeConfirmation) {
          return this.hold(
            `Bearish breakdown unconfirmed: volume ${volumeRatio.toFixed(1)}x avg < ${this.volumeMultiplier}x required. ` +
            `Price ${currentPrice.toFixed(2)} below support ${supportLevel.toFixed(2)}`
          );
        }

        let confidence = 40;
        confidence += Math.min(breakdownPct * 10, 20);
        confidence += 25; // volume confirmed (mandatory now)
        if (breakBelowBB) confidence += 10;
        confidence += Math.min(volumeRatio * 3, 10);

        const reason =
          `Bearish breakdown below ${this.lookbackPeriod}-period support ` +
          `(${supportLevel.toFixed(2)}). Price: ${currentPrice.toFixed(2)} (-${breakdownPct.toFixed(2)}%). ` +
          `Volume: ${volumeRatio.toFixed(1)}x avg ✓` +
          (breakBelowBB ? `. Below Bollinger lower (${bbLower.toFixed(2)})` : '');

        log.info({ signal: SIGNAL.SELL, confidence, breakdownPct, volumeRatio }, reason);
        return this.buildSignal(SIGNAL.SELL, confidence, reason);
      }
    }

    const range = resistanceLevel - supportLevel;
    const rangePct = ((range / supportLevel) * 100).toFixed(2);
    return this.hold(
      `No breakout. Range: ${supportLevel.toFixed(2)}-${resistanceLevel.toFixed(2)} (${rangePct}%). ` +
      `Price: ${currentPrice.toFixed(2)}. Volume: ${volumeRatio.toFixed(1)}x avg`
    );
  }
}