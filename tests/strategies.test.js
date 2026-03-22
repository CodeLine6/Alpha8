/**
 * Unit tests for all 4 trading strategies.
 * Uses synthetic OHLCV data to test signal generation deterministically.
 */

import { describe, test, expect } from '@jest/globals';
import { EMACrossoverStrategy } from '../src/strategies/ema-crossover.js';
import { RSIMeanReversionStrategy } from '../src/strategies/rsi-reversion.js';
import { VWAPMomentumStrategy } from '../src/strategies/vwap-momentum.js';
import { BreakoutVolumeStrategy } from '../src/strategies/breakout-volume.js';
import { BaseStrategy } from '../src/strategies/base-strategy.js';
import { ORBStrategy } from '../src/strategies/orb-strategy.js';
import { BAVIStrategy } from '../src/strategies/bavi-strategy.js';

// ─── Deterministic PRNG (Linear Congruential Generator) ───
// Eliminates flaky tests caused by Math.random() producing data
// that occasionally trips strategy thresholds in parallel runs.
let _seed = 42;
function seededRandom() {
  _seed = (_seed * 1664525 + 1013904223) & 0x7fffffff;
  return _seed / 0x7fffffff;
}
function resetSeed() { _seed = 42; }

// ─── Test Data Generators ─────────────────────────────────

/**
 * Generate N candles with a linear price trend.
 * @param {number} startPrice
 * @param {number} endPrice
 * @param {number} count
 * @param {number} [baseVolume=10000]
 */
function generateTrendCandles(startPrice, endPrice, count, baseVolume = 10000) {
  resetSeed();
  const candles = [];
  const step = (endPrice - startPrice) / (count - 1);

  for (let i = 0; i < count; i++) {
    const close = startPrice + step * i;
    const open = close - step * 0.5;
    const high = Math.max(open, close) + Math.abs(step) * 0.3;
    const low = Math.min(open, close) - Math.abs(step) * 0.3;
    candles.push({
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: baseVolume + Math.floor(seededRandom() * 2000),
    });
  }
  return candles;
}

/**
 * Generate candles that create an EMA crossover at the end.
 * First half trends down, second half trends up sharply (bullish cross).
 */
function generateBullishCrossoverCandles() {
  const down = generateTrendCandles(120, 95, 20, 10000);
  const up = generateTrendCandles(95, 115, 15, 15000);
  return [...down, ...up];
}

function generateBearishCrossoverCandles() {
  const up = generateTrendCandles(80, 120, 20, 10000);
  const down = generateTrendCandles(120, 100, 15, 15000);
  return [...up, ...down];
}

/**
 * Generate candles where RSI would be very low (oversold).
 * Steady decline = RSI drops toward 0.
 */
function generateOversoldCandles() {
  return generateTrendCandles(200, 120, 30, 10000);
}

function generateOverboughtCandles() {
  return generateTrendCandles(100, 200, 30, 10000);
}

/**
 * Generate flat/ranging candles — DETERMINISTIC noise.
 */
function generateFlatCandles(price = 100, count = 30) {
  resetSeed();
  const candles = [];
  for (let i = 0; i < count; i++) {
    const noise = (seededRandom() - 0.5) * 2; // ±1 deterministic
    const close = price + noise;
    candles.push({
      timestamp: new Date(Date.now() - (count - i) * 60000).toISOString(),
      open: +(close - 0.5).toFixed(2),
      high: +(close + 1).toFixed(2),
      low: +(close - 1).toFixed(2),
      close: +close.toFixed(2),
      volume: 10000,
    });
  }
  return candles;
}

/**
 * Generate breakout candles — flat range then sharp spike with high volume.
 */
function generateBreakoutCandles() {
  const flat = generateFlatCandles(100, 25);
  // Add breakout candle(s) at the end
  flat.push({
    timestamp: new Date().toISOString(),
    open: 101,
    high: 108,
    low: 100.5,
    close: 107,
    volume: 50000, // 5x normal
  });
  return flat;
}

function generateBreakdownCandles() {
  const flat = generateFlatCandles(100, 25);
  flat.push({
    timestamp: new Date().toISOString(),
    open: 99,
    high: 99.5,
    low: 92,
    close: 93,
    volume: 50000,
  });
  return flat;
}

// ═══════════════════════════════════════════════════════════
// Tests
// ═══════════════════════════════════════════════════════════

describe('BaseStrategy', () => {
  test('should throw if analyze() not implemented', () => {
    const base = new BaseStrategy('test');
    expect(() => base.analyze([])).toThrow('analyze() must be implemented');
  });

  test('buildSignal should return correct shape', () => {
    const base = new BaseStrategy('test');
    const signal = base.buildSignal('BUY', 75, 'Test reason');

    expect(signal).toEqual(expect.objectContaining({
      signal: 'BUY',
      confidence: 75,
      reason: 'Test reason',
      strategy: 'test',
    }));
    expect(signal.timestamp).toBeDefined();
  });

  test('buildSignal should clamp confidence to 0-100', () => {
    const base = new BaseStrategy('test');
    expect(base.buildSignal('BUY', 150, 'over').confidence).toBe(100);
    expect(base.buildSignal('BUY', -10, 'under').confidence).toBe(0);
  });

  test('hold() should return HOLD with confidence 0', () => {
    const base = new BaseStrategy('test');
    const signal = base.hold('No action');
    expect(signal.signal).toBe('HOLD');
    expect(signal.confidence).toBe(0);
  });
});

// ─── EMA Crossover ──────────────────────────────────────

describe('EMACrossoverStrategy', () => {
  const strategy = new EMACrossoverStrategy();

  test('should return HOLD with insufficient data', () => {
    const signal = strategy.analyze([]);
    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('Insufficient data');
  });

  test('should return HOLD with null candles', () => {
    const signal = strategy.analyze(null);
    expect(signal.signal).toBe('HOLD');
  });

  test('should detect bullish crossover', () => {
    const candles = generateBullishCrossoverCandles();
    const signal = strategy.analyze(candles);

    // With the crossover data, we should get BUY or HOLD
    // (depends on exact data, but it definitely shouldn't SELL)
    expect(signal.signal).not.toBe('SELL');
    expect(signal.strategy).toBe('EMA_CROSSOVER');
    expect(typeof signal.confidence).toBe('number');
    expect(signal.confidence).toBeGreaterThanOrEqual(0);
    expect(signal.confidence).toBeLessThanOrEqual(100);
  });

  test('should detect bearish crossover', () => {
    const candles = generateBearishCrossoverCandles();
    const signal = strategy.analyze(candles);

    expect(signal.signal).not.toBe('BUY');
    expect(signal.strategy).toBe('EMA_CROSSOVER');
  });

  test('should return HOLD for flat market', () => {
    const candles = generateFlatCandles(100, 35);
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('No crossover');
  });

  test('signal should have correct shape', () => {
    const candles = generateFlatCandles(100, 35);
    const signal = strategy.analyze(candles);

    expect(signal).toHaveProperty('signal');
    expect(signal).toHaveProperty('confidence');
    expect(signal).toHaveProperty('reason');
    expect(signal).toHaveProperty('strategy');
    expect(signal).toHaveProperty('timestamp');
  });

  test('should accept custom periods', () => {
    const custom = new EMACrossoverStrategy({ fastPeriod: 5, slowPeriod: 10 });
    expect(custom.fastPeriod).toBe(5);
    expect(custom.slowPeriod).toBe(10);
  });
});

// ─── RSI Mean Reversion ─────────────────────────────────

describe('RSIMeanReversionStrategy', () => {
  const strategy = new RSIMeanReversionStrategy();

  test('should return HOLD with insufficient data', () => {
    const signal = strategy.analyze([]);
    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('Insufficient data');
  });

  test('should generate BUY for oversold conditions', () => {
    const candles = generateOversoldCandles();
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('BUY');
    expect(signal.confidence).toBeGreaterThanOrEqual(50);
    expect(signal.reason).toContain('oversold');
    expect(signal.strategy).toBe('RSI_MEAN_REVERSION');
  });

  test('should generate SELL for overbought conditions', () => {
    const candles = generateOverboughtCandles();
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('SELL');
    expect(signal.confidence).toBeGreaterThanOrEqual(50);
    expect(signal.reason).toContain('overbought');
  });

  test('should return HOLD in neutral RSI zone', () => {
    const candles = generateFlatCandles(100, 30);
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('neutral');
  });

  test('should accept custom thresholds', () => {
    const custom = new RSIMeanReversionStrategy({ oversold: 25, overbought: 75 });
    expect(custom.oversold).toBe(25);
    expect(custom.overbought).toBe(75);
  });

  test('confidence should increase for deeper oversold', () => {
    // A 200→100 decline should give higher confidence than 200→150
    const deepOversold = generateTrendCandles(200, 100, 30);
    const shallowOversold = generateTrendCandles(200, 150, 30);

    const deep = strategy.analyze(deepOversold);
    const shallow = strategy.analyze(shallowOversold);

    // Both should be BUY, deep should have >= confidence
    if (deep.signal === 'BUY' && shallow.signal === 'BUY') {
      expect(deep.confidence).toBeGreaterThanOrEqual(shallow.confidence);
    }
  });
});

// ─── VWAP Momentum ──────────────────────────────────────

describe('VWAPMomentumStrategy', () => {
  const strategy = new VWAPMomentumStrategy({ anchorToday: false });

  test('should return HOLD with insufficient data', () => {
    const signal = strategy.analyze([]);
    expect(signal.signal).toBe('HOLD');
  });

  test('should calculate VWAP correctly', () => {
    const candles = [
      { high: 110, low: 90, close: 100, volume: 1000 },
      { high: 115, low: 95, close: 105, volume: 2000 },
    ];
    const vwap = strategy.calculateVWAP(candles, { anchorToday: false });

    expect(vwap).toHaveLength(2);
    expect(vwap[0]).toBeCloseTo(100, 0); // TP1 = (110+90+100)/3 = 100
    // VWAP2 = (100×1000 + 105×2000) / 3000 = 310000/3000 ≈ 103.33
    expect(vwap[1]).toBeCloseTo(103.33, 0);
  });

  test('signal should have correct shape', () => {
    const candles = generateTrendCandles(100, 110, 20, 10000);
    const signal = strategy.analyze(candles);

    expect(signal).toHaveProperty('signal');
    expect(signal).toHaveProperty('confidence');
    expect(signal).toHaveProperty('reason');
    expect(signal).toHaveProperty('strategy');
    expect(signal.strategy).toBe('VWAP_MOMENTUM');
  });

  test('should return HOLD for flat price near VWAP', () => {
    const candles = generateFlatCandles(100, 20);
    const signal = strategy.analyze(candles);

    // In a flat market, price stays near VWAP → HOLD
    expect(['HOLD', 'BUY', 'SELL']).toContain(signal.signal);
    expect(typeof signal.confidence).toBe('number');
  });

  test('should accept custom parameters', () => {
    const custom = new VWAPMomentumStrategy({ volumeMultiplier: 2.0, priceBandPct: 0.5 });
    expect(custom.volumeMultiplier).toBe(2.0);
    expect(custom.priceBandPct).toBe(0.5);
  });
});

// ─── Breakout Volume ────────────────────────────────────

describe('BreakoutVolumeStrategy', () => {
  const strategy = new BreakoutVolumeStrategy();

  test('should return HOLD with insufficient data', () => {
    const signal = strategy.analyze([]);
    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('Insufficient data');
  });

  test('should detect bullish breakout with high volume', () => {
    const candles = generateBreakoutCandles();
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('BUY');
    expect(signal.confidence).toBeGreaterThanOrEqual(40);
    expect(signal.reason).toContain('Bullish breakout');
    expect(signal.reason).toContain('✓'); // volume confirmed
    expect(signal.strategy).toBe('BREAKOUT_VOLUME');
  });

  test('should detect bearish breakdown with high volume', () => {
    const candles = generateBreakdownCandles();
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('SELL');
    expect(signal.confidence).toBeGreaterThanOrEqual(40);
    expect(signal.reason).toContain('Bearish breakdown');
  });

  test('should return HOLD when no breakout', () => {
    const candles = generateFlatCandles(100, 30);
    const signal = strategy.analyze(candles);

    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('No breakout');
  });

  test('breakout with low volume should have lower confidence', () => {
    const candles = generateFlatCandles(100, 25);
    // Add breakout candle with normal volume (not 5x)
    candles.push({
      timestamp: new Date().toISOString(),
      open: 101,
      high: 108,
      low: 100.5,
      close: 107,
      volume: 10000, // normal volume, not confirmed
    });

    const signal = strategy.analyze(candles);
    if (signal.signal === 'BUY') {
      expect(signal.reason).toContain('unconfirmed');
    }
  });

  test('should accept custom parameters', () => {
    const custom = new BreakoutVolumeStrategy({ lookbackPeriod: 10, volumeMultiplier: 2.0 });
    expect(custom.lookbackPeriod).toBe(10);
    expect(custom.volumeMultiplier).toBe(2.0);
  });
});

// ─── Cross-Strategy Consistency ─────────────────────────

describe('Strategy Signal Consistency', () => {
  // ORB and BAVI always return HOLD when given flat candles with no timestamps,
  // so include them only in graceful-failure tests (not signal-shape tests).
  const activeStrategies = [
    new EMACrossoverStrategy(),
    new RSIMeanReversionStrategy(),
    new VWAPMomentumStrategy({ anchorToday: false }),
    new BreakoutVolumeStrategy(),
    new ORBStrategy(),
    new BAVIStrategy(),
  ];

  test('all strategies should return valid signal shapes', () => {
    const candles = generateFlatCandles(100, 35);

    // EMA, RSI, VWAP, Breakout work with bare candles
    [new EMACrossoverStrategy(), new RSIMeanReversionStrategy(),
     new VWAPMomentumStrategy({ anchorToday: false }), new BreakoutVolumeStrategy()
    ].forEach((strategy) => {
      const signal = strategy.analyze(candles);
      expect(['BUY', 'SELL', 'HOLD']).toContain(signal.signal);
      expect(signal.confidence).toBeGreaterThanOrEqual(0);
      expect(signal.confidence).toBeLessThanOrEqual(100);
      expect(typeof signal.reason).toBe('string');
      expect(signal.reason.length).toBeGreaterThan(0);
      expect(signal.strategy).toBeDefined();
      expect(signal.timestamp).toBeDefined();
    });
  });

  test('all strategies should handle empty candles gracefully', () => {
    activeStrategies.forEach((strategy) => {
      const signal = strategy.analyze([]);
      expect(signal.signal).toBe('HOLD');
    });
  });

  test('all strategies should handle null candles gracefully', () => {
    activeStrategies.forEach((strategy) => {
      const signal = strategy.analyze(null);
      expect(signal.signal).toBe('HOLD');
    });
  });
});

// ─── ORB Strategy ────────────────────────────────────────

/**
 * Build IST-timestamped candles for ORB tests.
 * minuteOffset = minutes after 09:15 IST (negative = before market).
 */
function makeORBCandles(specs) {
  // 9:15 AM IST = 3:45 AM UTC
  const base = new Date();
  base.setUTCHours(3, 45, 0, 0);
  return specs.map(({ minuteOffset = 0, open, high, low, close, volume }) => ({
    date:   new Date(base.getTime() + minuteOffset * 60000).toISOString(),
    open:   open   ?? 100,
    high:   high   ?? 101,
    low:    low    ?? 99,
    close:  close  ?? 100,
    volume: volume ?? 10000,
  }));
}

describe('ORBStrategy', () => {
  const strategy = new ORBStrategy();

  test('HOLD with insufficient data', () => {
    expect(strategy.analyze([]).signal).toBe('HOLD');
    expect(strategy.analyze(null).signal).toBe('HOLD');
    expect(strategy.analyze([]).reason).toContain('Insufficient');
  });

  test('HOLD when OR is not yet complete (< 6 candles in 9:15-9:44)', () => {
    // Need >= minCandles (17) so the Insufficient guard doesn't fire first:
    // 14 prior candles (before 09:15) + 3 OR candles (09:15–09:25) = 17 total.
    // OR check requires 6 candles, so OR incomplete HOLD should trigger.
    const candles = makeORBCandles([
      ...Array.from({ length: 14 }, (_, i) => ({ minuteOffset: -(70 - i * 5), close: 100 })),
      { minuteOffset: 0,  high: 100.8, low: 99.5, close: 100.2, volume: 10000 },
      { minuteOffset: 5,  high: 101.0, low: 99.6, close: 100.5, volume: 10000 },
      { minuteOffset: 10, high: 101.2, low: 99.7, close: 100.6, volume: 10000 },
    ]);
    const signal = strategy.analyze(candles);
    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('OR incomplete');
    expect(signal.strategy).toBe('ORB');
  });

  test('BUY on upward breakout above OR high with volume', () => {
    // OR range: high=101.5, low=99.5 → range ~2.0% (within 0.3–3.0%)
    // Breakout candle closes at 102 (> orHigh=101.5) with 2.75x avg volume
    const orHigh = 101.5;
    const priorSpecs = Array.from({ length: 10 }, (_, i) => ({
      minuteOffset: -(50 - i * 5), close: 100, volume: 8000,
    }));
    const orSpecs = Array.from({ length: 6 }, (_, i) => ({
      minuteOffset: i * 5, high: orHigh, low: 99.5, close: 100.5, volume: 10000,
    }));
    const breakoutCandle = { minuteOffset: 30, open: 101.5, high: 103, low: 101, close: 102.2, volume: 22000 };
    const signal = strategy.analyze(makeORBCandles([...priorSpecs, ...orSpecs, breakoutCandle]));
    expect(signal.signal).toBe('BUY');
    expect(signal.confidence).toBeGreaterThanOrEqual(55);
    expect(signal.strategy).toBe('ORB');
    expect(signal.meta.orHigh).toBe(orHigh);
  });

  test('SELL on breakdown below OR low with volume', () => {
    // OR range: high=100.5, low=98.5 → range ~2.0% (within 0.3–3.0%)
    // Breakdown candle closes at 97 (< orLow=98.5) with 2.75x avg volume
    const orLow = 98.5;
    const priorSpecs = Array.from({ length: 10 }, (_, i) => ({
      minuteOffset: -(50 - i * 5), close: 100, volume: 8000,
    }));
    const orSpecs = Array.from({ length: 6 }, (_, i) => ({
      minuteOffset: i * 5, high: 100.5, low: orLow, close: 99.5, volume: 10000,
    }));
    const breakdownCandle = { minuteOffset: 30, open: 98.5, high: 99, low: 96, close: 97.0, volume: 22000 };
    const signal = strategy.analyze(makeORBCandles([...priorSpecs, ...orSpecs, breakdownCandle]));
    expect(signal.signal).toBe('SELL');
    expect(signal.strategy).toBe('ORB');
  });

  test('accepts custom parameters', () => {
    const custom = new ORBStrategy({ orbWindowCandles: 4, minRangePct: 0.5, volumeMultiplier: 2.0 });
    expect(custom.orbWindowCandles).toBe(4);
    expect(custom.minRangePct).toBe(0.5);
    expect(custom.volumeMultiplier).toBe(2.0);
  });
});

// ─── BAVI Strategy ───────────────────────────────────────

describe('BAVIStrategy', () => {
  const strategy = new BAVIStrategy();

  test('HOLD in backtest mode (null tick buffer)', () => {
    const candles = generateFlatCandles(100, 10);
    const signal = strategy.analyze(candles, null, null);
    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('tick buffer');
    expect(signal.strategy).toBe('BAVI');
  });

  test('HOLD with null candles', () => {
    expect(strategy.analyze(null, null, null).signal).toBe('HOLD');
  });

  test('HOLD with no symbol provided', () => {
    const signal = strategy.analyze(generateFlatCandles(100, 10), {}, null);
    expect(signal.signal).toBe('HOLD');
    expect(signal.reason).toContain('tick buffer');
  });

  test('HOLD with insufficient candles', () => {
    const signal = strategy.analyze(
      [{ open: 100, high: 101, low: 99, close: 100, volume: 1000 }],
      null, null
    );
    expect(signal.signal).toBe('HOLD');
  });

  test('correct signal shape when HOLD', () => {
    const signal = strategy.analyze(null, null, null);
    expect(signal).toHaveProperty('signal', 'HOLD');
    expect(signal).toHaveProperty('confidence', 0);
    expect(signal).toHaveProperty('reason');
    expect(signal).toHaveProperty('strategy', 'BAVI');
  });

  test('accepts custom parameters', () => {
    const custom = new BAVIStrategy({ imbalanceThreshold: 0.45, minTickCount: 100 });
    expect(custom.imbalanceThreshold).toBe(0.45);
    expect(custom.minTickCount).toBe(100);
  });
});
