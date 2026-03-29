/**
 * price-engine.js
 *
 * Real-time synthetic price engine for the Alpha8 Market Simulator.
 *
 * Drives per-symbol price action using Geometric Brownian Motion (GBM):
 *   S(t+dt) = S(t) * exp((µ - σ²/2)*dt + σ*√dt*Z)
 *
 * where:
 *   µ  = per-minute drift  (from data-seeder.js)
 *   σ  = per-minute vol    (from data-seeder.js, scaled by intraday regime)
 *   Z  = N(0,1) Gaussian random variable
 *   dt = 1 (one tick per interval)
 *
 * Intraday structure:
 *   • 0–15 min  : "ORB window" — higher vol (1.8x) + trend bias
 *   • 15–60 min : morning trend — moderate vol (1.2x)
 *   • 60–300 min: midday doldrums — reduced vol (0.7x)
 *   • 300–360 min: closing rally — elevated vol (1.4x)
 *
 * Usage:
 *   const engine = new PriceEngine(seedDataMap);
 *   engine.on('tick', (ticks) => { ... });
 *   engine.start();
 *   // ...later
 *   engine.stop();
 */

import EventEmitter from 'node:events';

/** Volume shape: fraction of avgVolume per minute of session */
const VOLUME_CURVE = (minuteOfSession, totalMinutes) => {
  const pct = minuteOfSession / totalMinutes;
  // U-shaped volume: high at open and close, low midday
  if (pct < 0.1)  return 3.0;
  if (pct < 0.25) return 1.5;
  if (pct < 0.75) return 0.6;
  if (pct < 0.9)  return 1.2;
  return 2.5;
};

/** Intraday volatility multiplier */
const VOL_REGIME = (minuteOfSession) => {
  if (minuteOfSession < 15)  return 1.8;
  if (minuteOfSession < 60)  return 1.2;
  if (minuteOfSession < 300) return 0.7;
  return 1.4;
};

/**
 * Box-Muller transform — returns N(0,1) random variable.
 */
function randn() {
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
}

export class PriceEngine extends EventEmitter {
  /**
   * @param {Map<string, import('./data-seeder.js').SeedData>} seedData
   * @param {Object} [opts]
   * @param {number} [opts.tickIntervalMs=1000]       - How often to emit ticks (ms). Default: 1s
   * @param {number} [opts.sessionDurationMs]         - Total session length. Default: 6h in ms
   * @param {Map}    [opts.intradayCandles]            - symbol → [{time(UTC ms),open,high,low,close,volume}]
   * @param {number} [opts.sourceSessionStartMs=0]    - UTC ms of 09:15 IST on source date
   */
  constructor(seedData, {
    tickIntervalMs       = 1000,
    sessionDurationMs    = 6 * 60 * 60 * 1000,
    intradayCandles      = null,
    sourceSessionStartMs = 0,
  } = {}) {
    super();

    this.seedData            = seedData;
    this.tickIntervalMs      = tickIntervalMs;
    this.sessionDurationMs   = sessionDurationMs;
    this.intradayCandles     = intradayCandles;      // real-data replay
    this.sourceSessionStartMs = sourceSessionStartMs;

    /** Per-symbol state */
    this._state = new Map();

    /** Timer handle */
    this._timer = null;

    /** Session start wall-clock time */
    this._startedAt = null;

    /** Elapsed simulated minutes (1 tick = 1 second = simulates ~1/60 of a real minute) */
    this._elapsedMs  = 0;

    this._running = false;

    this._initState();
  }

  /** Build per-symbol price state from seed data (or first intraday candle when available) */
  _initState() {
    for (const [symbol, seed] of this.seedData) {
      const firstCandle = this.intradayCandles?.get(symbol)?.[0];
      const startPrice  = firstCandle?.open ?? seed.open ?? seed.lastClose;
      this._state.set(symbol, {
        price:      startPrice,
        open:       startPrice,
        high:       startPrice,
        low:        startPrice,
        prevClose:  seed.lastClose,   // yesterday's close — used for change %
        drift:      seed.drift      ?? 0,
        volatility: seed.volatility ?? 0.0002,
        avgVolume:  seed.avgVolume  ?? 500_000,
        cumulativeVolume: 0,
        _candleIdx: 0,               // replay cursor (ignored in GBM mode)
      });
    }
  }

  /**
   * Advance price for one symbol by one tick.
   *
   * REPLAY MODE  — when intradayCandles has data for this symbol:
   *   Walks through the real 5m candles at 1:1 real-time pace.
   *   sourceNow = sourceSessionStart + elapsedMs
   *   The tick's ltp is the close of whichever candle covers sourceNow.
   *
   * GBM FALLBACK — when no intraday data is available.
   * @private
   */
  _advancePrice(symbol, minuteOfSession, totalMinutes) {
    const s = this._state.get(symbol);
    if (!s) return null;

    // ── Candle replay ────────────────────────────────────────────────────────
    const candles = this.intradayCandles?.get(symbol);
    if (candles?.length > 0 && this.sourceSessionStartMs > 0) {
      const sourceNowMs = this.sourceSessionStartMs + this._elapsedMs;

      // Advance index until the next candle is still in the future
      while (
        s._candleIdx + 1 < candles.length &&
        candles[s._candleIdx + 1].time <= sourceNowMs
      ) {
        s._candleIdx++;
        s.cumulativeVolume += candles[s._candleIdx].volume;
      }

      const c = candles[s._candleIdx];
      if (c && c.time <= sourceNowMs) {
        // Interpolate through O → H → L → C (or O → L → H → C for bearish candles)
        // within each 5m candle so ticks touch the real intraday extremes,
        // not just a flat ramp from open to close.
        const nextCandle       = candles[s._candleIdx + 1];
        const candleDurationMs = nextCandle ? nextCandle.time - c.time : 5 * 60 * 1000;
        const fracThrough      = Math.min((sourceNowMs - c.time) / candleDurationMs, 1.0);

        // Determine candle direction: bullish goes O→L→H→C, bearish goes O→H→L→C
        // This ensures stop-losses can trigger on realistic wicks.
        const bullish = c.close >= c.open;
        const p0 = c.open;
        const p1 = bullish ? c.low  : c.high;   // first extreme
        const p2 = bullish ? c.high : c.low;     // second extreme
        const p3 = c.close;

        // 4 waypoints at frac 0.0, 0.25, 0.75, 1.0 — with noise via randn()
        let interpPrice;
        if (fracThrough <= 0.25) {
          // Open → first extreme (wick into low for bullish, spike to high for bearish)
          interpPrice = p0 + (p1 - p0) * (fracThrough / 0.25);
        } else if (fracThrough <= 0.75) {
          // First extreme → second extreme (main body movement)
          interpPrice = p1 + (p2 - p1) * ((fracThrough - 0.25) / 0.50);
        } else {
          // Second extreme → close (settling)
          interpPrice = p2 + (p3 - p2) * ((fracThrough - 0.75) / 0.25);
        }
        interpPrice = parseFloat(interpPrice.toFixed(2));

        s.price = interpPrice;
        s.high  = Math.max(s.high,  interpPrice);
        s.low   = Math.min(s.low,   interpPrice);
        const change = parseFloat((((s.price - s.prevClose) / s.prevClose) * 100).toFixed(2));
        return { symbol, ltp: s.price, open: s.open, high: s.high, low: s.low, close: s.prevClose, volume: s.cumulativeVolume, change };
      }
      return null; // no candle available yet (before session open)
    }

    // ── GBM fallback ─────────────────────────────────────────────────────────
    const volMult  = VOL_REGIME(minuteOfSession);
    const sigmaT   = s.volatility * volMult;
    const Z        = randn();
    const logRet   = (s.drift - 0.5 * sigmaT ** 2) + sigmaT * Z;
    const newPrice = parseFloat((s.price * Math.exp(logRet)).toFixed(2));

    s.high  = Math.max(s.high,  newPrice);
    s.low   = Math.min(s.low,   newPrice);
    s.price = newPrice;

    const volFraction = VOLUME_CURVE(minuteOfSession, totalMinutes);
    s.cumulativeVolume += Math.round(
      (s.avgVolume / (totalMinutes * 60)) * volFraction * (0.5 + Math.random())
    );

    const change = parseFloat((((s.price - s.prevClose) / s.prevClose) * 100).toFixed(2));
    return { symbol, ltp: s.price, open: s.open, high: s.high, low: s.low, close: s.prevClose, volume: s.cumulativeVolume, change };
  }

  /**
   * Start the price engine.
   * Emits 'tick' with an array of price objects (one per subscribed symbol)
   * every `tickIntervalMs` milliseconds.
   * Emits 'session_end' when `sessionDurationMs` has elapsed.
   */
  start() {
    if (this._running) return;
    this._running   = true;
    this._startedAt = Date.now();
    this._elapsedMs = 0;

    this._initState(); // fresh state on start

    const totalMinutes = this.sessionDurationMs / 60_000;

    this._timer = setInterval(() => {
      this._elapsedMs += this.tickIntervalMs;

      if (this._elapsedMs > this.sessionDurationMs) {
        this.stop();
        this.emit('session_end');
        return;
      }

      const minuteOfSession = this._elapsedMs / 60_000;
      const ticks = [];

      for (const [symbol] of this._state) {
        const tick = this._advancePrice(symbol, minuteOfSession, totalMinutes);
        if (tick) ticks.push(tick);
      }

      if (ticks.length > 0) {
        this.emit('tick', ticks);
      }
    }, this.tickIntervalMs);

    this._timer.unref();

    this.emit('started', {
      symbols:           [...this._state.keys()],
      sessionDurationMs: this.sessionDurationMs,
      tickIntervalMs:    this.tickIntervalMs,
    });

    console.log(
      `[price-engine] Started — ${this._state.size} symbols, ` +
      `session=${this.sessionDurationMs / 3600000}h, ` +
      `tick=${this.tickIntervalMs}ms`
    );
  }

  /**
   * Stop the price engine.
   */
  stop() {
    if (this._timer) {
      clearInterval(this._timer);
      this._timer = null;
    }
    this._running = false;
    this.emit('stopped');
    console.log('[price-engine] Stopped');
  }

  /**
   * Subscribe new symbols mid-session.
   * @param {Map<string, import('./data-seeder.js').SeedData>} newSeedData
   */
  addSymbols(newSeedData) {
    for (const [symbol, seed] of newSeedData) {
      if (!this._state.has(symbol)) {
        this._state.set(symbol, {
          price:      seed.open ?? seed.lastClose,
          open:       seed.open ?? seed.lastClose,
          high:       seed.open ?? seed.lastClose,
          low:        seed.open ?? seed.lastClose,
          prevClose:  seed.lastClose,
          drift:      seed.drift      ?? 0,
          volatility: seed.volatility ?? 0.0002,
          avgVolume:  seed.avgVolume  ?? 500000,
          cumulativeVolume: 0,
        });
      }
    }
  }

  /**
   * Get current status of the engine.
   */
  getStatus() {
    const elapsed = this._startedAt ? Date.now() - this._startedAt : 0;
    return {
      running:            this._running,
      symbols:            this._state.size,
      elapsedMs:          elapsed,
      remainingMs:        Math.max(0, this.sessionDurationMs - (this._elapsedMs ?? 0)),
      sessionDurationMs:  this.sessionDurationMs,
    };
  }

  /**
   * Get latest price snapshot for all symbols.
   * @returns {Map<string, Object>}
   */
  getLatestPrices() {
    const out = new Map();
    for (const [symbol, s] of this._state) {
      out.set(symbol, {
        symbol,
        ltp:    s.price,
        open:   s.open,
        high:   s.high,
        low:    s.low,
        close:  s.prevClose,
        volume: s.cumulativeVolume,
        change: parseFloat(
          (((s.price - s.prevClose) / s.prevClose) * 100).toFixed(2)
        ),
      });
    }
    return out;
  }
}
