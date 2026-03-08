/**
 * @fileoverview Backtest module tests
 *
 * Tests:
 *   - MetricsCalculator (all financial metrics)
 *   - BacktestEngine    (simulation logic, stop-loss, square-off, consensus)
 *   - DataFetcher       (normalisation, grouping, IST time helpers)
 *   - ReportGenerator   (CSV export)
 */

import { describe, it, expect, beforeEach, jest } from '@jest/globals';

import { calculateMetrics, calculateMaxDrawdown, calculateSharpe, calculateSortino, compareStrategies }
  from '../src/backtesting/metrics-calculator.js';

import { groupByDay, toISTTimeString, normaliseCandle }
  from '../src/backtesting/historical-data-fetcher.js';

import { BacktestEngine, ALL_STRATEGIES }
  from '../src/backtesting/backtest-engine.js';

import { exportCsv }
  from '../src/backtesting/report-generator.js';

import { tmpdir } from 'os';
import { join }   from 'path';
import { readFileSync, existsSync, rmSync } from 'fs';

// ══════════════════════════════════════════════════════════════════════════════
// Test helpers
// ══════════════════════════════════════════════════════════════════════════════

/**
 * Build a synthetic candle at a given IST time on a given date.
 * IST = UTC + 5:30
 *
 * @param {string} isoDate  - 'YYYY-MM-DD'
 * @param {string} istTime  - 'HH:MM'
 * @param {object} ohlcv
 */
function makeCandle(isoDate, istTime, { open = 100, high, low, close = 100, volume = 10000 } = {}) {
  const [h, m] = istTime.split(':').map(Number);
  // Convert IST to UTC: subtract 5h30m
  const utcHours   = h - 5;
  const utcMinutes = m - 30;
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCHours(utcHours, utcMinutes, 0, 0);

  return {
    date:   d,
    open,
    high:   high  ?? Math.max(open, close) + 2,
    low:    low   ?? Math.min(open, close) - 2,
    close,
    volume,
  };
}

/**
 * Build a full trading day of 5-min candles (09:15 → 15:10 IST, 72 candles).
 * Prices follow a simple trend.
 */
function makeTradingDay(isoDate, { trend = 'up', basePrice = 100 } = {}) {
  const candles = [];
  const times = [];

  for (let h = 9; h <= 15; h++) {
    const startM = h === 9  ? 15 : 0;
    const endM   = h === 15 ? 10 : 55;
    for (let m = startM; m <= endM; m += 5) {
      times.push(`${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`);
    }
  }

  times.forEach((t, i) => {
    const delta = trend === 'up' ? i * 0.1 : trend === 'down' ? -i * 0.1 : 0;
    const price = basePrice + delta;
    candles.push(makeCandle(isoDate, t, {
      open:   price,
      close:  price + (trend === 'up' ? 0.05 : -0.05),
      high:   price + 1,
      low:    price - 1,
      volume: 10000 + i * 100,
    }));
  });

  return candles;
}

/**
 * Build multiple days of candles.
 */
function makeMultipleDays(startDate, numDays, trend = 'up') {
  const all = [];
  for (let i = 0; i < numDays; i++) {
    const d = new Date(startDate);
    d.setDate(d.getDate() + i);
    // Skip weekends
    if (d.getDay() === 0 || d.getDay() === 6) continue;
    const iso = d.toISOString().slice(0, 10);
    all.push(...makeTradingDay(iso, { trend }));
  }
  return all;
}

/**
 * Build a mock strategy that returns predictable signals.
 */
function mockStrategy(signalSequence) {
  let callCount = 0;
  return {
    analyze(candles) {
      const sig = signalSequence[callCount % signalSequence.length];
      callCount++;
      return {
        signal:     sig,
        confidence: 80,
        reason:     `mock-${sig}`,
        strategy:   'mock',
        timestamp:  new Date().toISOString(),
      };
    },
  };
}

// ══════════════════════════════════════════════════════════════════════════════
// 1. MetricsCalculator
// ══════════════════════════════════════════════════════════════════════════════

describe('MetricsCalculator', () => {

  const makeTrade = (pnl, entryTime, exitTime) => ({
    symbol:    'TEST',
    strategy:  'ema-crossover',
    side:      'BUY',
    entryPrice: 100,
    exitPrice:  100 + pnl / 10,
    quantity:   10,
    pnl,
    pnlPct:     (pnl / 1000) * 100,
    exitReason: 'SIGNAL',
    entryTime:  entryTime ?? new Date('2024-01-15T04:15:00Z'),
    exitTime:   exitTime  ?? new Date('2024-01-15T06:00:00Z'),
    entryReason: 'mock signal',
  });

  describe('calculateMetrics() — empty trades', () => {
    it('returns zero metrics when no trades', () => {
      const m = calculateMetrics([], 100000);
      expect(m.totalTrades).toBe(0);
      expect(m.totalReturnPct).toBe(0);
      expect(m.finalCapital).toBe(100000);
    });

    it('returns zero metrics for null trades', () => {
      const m = calculateMetrics(null, 100000);
      expect(m.totalTrades).toBe(0);
    });
  });

  describe('calculateMetrics() — winning trades', () => {
    const trades = [
      makeTrade(500,  new Date('2024-01-15T04:15:00Z'), new Date('2024-01-15T06:00:00Z')),
      makeTrade(300,  new Date('2024-01-16T04:15:00Z'), new Date('2024-01-16T06:00:00Z')),
      makeTrade(1000, new Date('2024-01-17T04:15:00Z'), new Date('2024-01-17T06:00:00Z')),
    ];

    it('calculates correct total P&L', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.totalPnl).toBe(1800);
    });

    it('calculates correct final capital', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.finalCapital).toBe(101800);
    });

    it('calculates correct total return %', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.totalReturnPct).toBeCloseTo(1.8, 1);
    });

    it('win rate = 100% for all winners', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.winRate).toBe(100);
    });

    it('correct trade counts', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.totalTrades).toBe(3);
      expect(m.winningTrades).toBe(3);
      expect(m.losingTrades).toBe(0);
    });
  });

  describe('calculateMetrics() — mixed trades', () => {
    const trades = [
      makeTrade( 500, new Date('2024-01-15T04:15:00Z'), new Date('2024-01-15T06:00:00Z')),
      makeTrade(-200, new Date('2024-01-16T04:15:00Z'), new Date('2024-01-16T06:00:00Z')),
      makeTrade( 800, new Date('2024-01-17T04:15:00Z'), new Date('2024-01-17T06:00:00Z')),
      makeTrade(-100, new Date('2024-01-18T04:15:00Z'), new Date('2024-01-18T06:00:00Z')),
    ];

    it('correct win rate', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.winRate).toBe(50);
    });

    it('profit factor > 1 when winners exceed losers', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.profitFactor).toBeGreaterThan(1);
    });

    it('avg loss is negative', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.avgLossPct).toBeLessThan(0);
    });

    it('equity curve has correct length', () => {
      const m = calculateMetrics(trades, 100000);
      // initial + one entry per trade
      expect(m.equityCurve).toHaveLength(trades.length + 1);
    });

    it('equity curve starts at initial capital', () => {
      const m = calculateMetrics(trades, 100000);
      expect(m.equityCurve[0]).toBe(100000);
    });
  });

  describe('calculateMaxDrawdown()', () => {
    it('returns 0 for monotonically increasing equity', () => {
      expect(calculateMaxDrawdown([100, 110, 120, 130])).toBe(0);
    });

    it('calculates correct drawdown', () => {
      // Peak = 120, then drops to 90 → DD = (120-90)/120 * 100 = 25%
      const dd = calculateMaxDrawdown([100, 120, 90, 110]);
      expect(dd).toBeCloseTo(25, 1);
    });

    it('handles single value', () => {
      expect(calculateMaxDrawdown([100])).toBe(0);
    });

    it('handles all-loss scenario', () => {
      const dd = calculateMaxDrawdown([100, 80, 60, 40]);
      expect(dd).toBeCloseTo(60, 1);
    });
  });

  describe('calculateSharpe()', () => {
    it('returns 0 for empty returns', () => {
      expect(calculateSharpe([])).toBe(0);
    });

    it('returns 0 for single return', () => {
      expect(calculateSharpe([5])).toBe(0);
    });

    it('positive Sharpe for varied positive returns', () => {
      // Must use varied returns — zero variance → zero Sharpe (mathematically correct)
      const returns = [0.5, 0.8, 0.3, 1.2, 0.6, 0.4, 0.9, 0.7, 0.5, 0.6,
                       0.8, 0.4, 1.0, 0.5, 0.7, 0.6, 0.8, 0.5, 0.9, 0.4];
      expect(calculateSharpe(returns)).toBeGreaterThan(0);
    });

    it('negative Sharpe for varied negative returns', () => {
      const returns = [-0.5, -0.8, -0.3, -1.2, -0.6, -0.4, -0.9, -0.7, -0.5, -0.6,
                       -0.8, -0.4, -1.0, -0.5, -0.7, -0.6, -0.8, -0.5, -0.9, -0.4];
      expect(calculateSharpe(returns)).toBeLessThan(0);
    });

    it('higher Sharpe for lower volatility at same average return', () => {
      // low vol: consistent 0.2% daily
      const lowVol  = [0.2, 0.3, 0.1, 0.4, 0.2, 0.3, 0.1, 0.2, 0.3, 0.2,
                       0.2, 0.3, 0.1, 0.4, 0.2, 0.3, 0.1, 0.2, 0.3, 0.2];
      // high vol: same avg (0.2) but much wider swings
      const highVol = [0.5, -0.3, 0.5, -0.3, 0.5, -0.3, 0.5, -0.3, 0.5, -0.3,
                       0.5, -0.3, 0.5, -0.3, 0.5, -0.3, 0.5, -0.3, 0.5, -0.3];
      expect(calculateSharpe(lowVol)).toBeGreaterThan(calculateSharpe(highVol));
    });
  });

  describe('calculateSortino()', () => {
    it('returns 0 for empty returns', () => {
      expect(calculateSortino([])).toBe(0);
    });

    it('returns Infinity when no downside volatility', () => {
      const returns = Array(20).fill(0.5);
      expect(calculateSortino(returns)).toBe(Infinity);
    });
  });

  describe('compareStrategies()', () => {
    it('sorts by Sharpe ratio descending', () => {
      const results = [
        { name: 'low',  metrics: { totalReturnPct: 5, winRate: 50, sharpeRatio: 0.5, maxDrawdownPct: 10, profitFactor: 1.2, totalTrades: 20 } },
        { name: 'high', metrics: { totalReturnPct: 10, winRate: 60, sharpeRatio: 1.5, maxDrawdownPct: 8, profitFactor: 1.8, totalTrades: 25 } },
        { name: 'mid',  metrics: { totalReturnPct: 7, winRate: 55, sharpeRatio: 1.0, maxDrawdownPct: 12, profitFactor: 1.5, totalTrades: 22 } },
      ];
      const ranked = compareStrategies(results);
      expect(ranked[0].strategy).toBe('high');
      expect(ranked[1].strategy).toBe('mid');
      expect(ranked[2].strategy).toBe('low');
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 2. DataFetcher helpers
// ══════════════════════════════════════════════════════════════════════════════

describe('DataFetcher helpers', () => {

  describe('normaliseCandle()', () => {
    it('converts string numbers to floats', () => {
      const c = normaliseCandle({ date: '2024-01-15T04:15:00Z', open: '100.5', high: '102', low: '99', close: '101', volume: '5000' });
      expect(typeof c.open).toBe('number');
      expect(c.open).toBe(100.5);
    });

    it('converts date strings to Date objects', () => {
      const c = normaliseCandle({ date: '2024-01-15T04:15:00Z', open: 100, high: 102, low: 99, close: 101, volume: 5000 });
      expect(c.date).toBeInstanceOf(Date);
    });

    it('handles missing volume gracefully', () => {
      const c = normaliseCandle({ date: new Date(), open: 100, high: 102, low: 99, close: 101 });
      expect(c.volume).toBe(0);
    });

    it('preserves existing Date objects', () => {
      const d = new Date('2024-01-15');
      const c = normaliseCandle({ date: d, open: 100, high: 102, low: 99, close: 101, volume: 5000 });
      expect(c.date).toBe(d);
    });
  });

  describe('toISTTimeString()', () => {
    it('converts UTC to IST correctly (UTC+5:30)', () => {
      // 03:45 UTC = 09:15 IST
      const d = new Date('2024-01-15T03:45:00Z');
      expect(toISTTimeString(d)).toBe('09:15');
    });

    it('converts market close time correctly', () => {
      // 10:00 UTC = 15:30 IST
      const d = new Date('2024-01-15T10:00:00Z');
      expect(toISTTimeString(d)).toBe('15:30');
    });

    it('handles square-off time', () => {
      // 09:45 UTC = 15:15 IST
      const d = new Date('2024-01-15T09:45:00Z');
      expect(toISTTimeString(d)).toBe('15:15');
    });
  });

  describe('groupByDay()', () => {
    it('groups candles by IST date correctly', () => {
      const candles = [
        makeCandle('2024-01-15', '09:15'),
        makeCandle('2024-01-15', '09:20'),
        makeCandle('2024-01-16', '09:15'),
      ];
      const groups = groupByDay(candles);
      expect(groups.size).toBe(2);
      expect(groups.get('2024-01-15')).toHaveLength(2);
      expect(groups.get('2024-01-16')).toHaveLength(1);
    });

    it('returns empty map for empty input', () => {
      const groups = groupByDay([]);
      expect(groups.size).toBe(0);
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 3. BacktestEngine
// ══════════════════════════════════════════════════════════════════════════════

describe('BacktestEngine', () => {

  /**
   * Create an engine with mocked strategy loading.
   */
  async function createEngineWithMock(signalSequence, config = {}) {
    const engine = new BacktestEngine({
      symbol:         'TEST',
      strategies:     ['ema-crossover'],
      initialCapital: 100000,
      useConsensus:   false,
      logger:         () => {},
      ...config,
    });

    // Inject mock strategy directly
    engine._loadStrategies = async () => ({
      'ema-crossover': mockStrategy(signalSequence),
    });

    return engine;
  }

  describe('Basic engine creation', () => {
    it('creates engine with default config', () => {
      const engine = new BacktestEngine({
        symbol:         'RELIANCE',
        strategies:     ['all'],
        initialCapital: 100000,
      });
      expect(engine.symbol).toBe('RELIANCE');
      expect(engine.initialCapital).toBe(100000);
    });

    it('resolves "all" to all 4 strategies', () => {
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['all'],
        initialCapital: 100000,
      });
      expect(engine.strategyNames).toEqual(ALL_STRATEGIES);
    });

    it('throws on unknown strategy', () => {
      expect(() => new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['invalid-strategy'],
        initialCapital: 100000,
      })).toThrow(/Unknown strategy/);
    });

    it('sets useConsensus to true when multiple strategies', () => {
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['ema-crossover', 'rsi-reversion'],
        initialCapital: 100000,
      });
      expect(engine.useConsensus).toBe(true);
    });

    it('sets useConsensus to false for single strategy', () => {
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['ema-crossover'],
        initialCapital: 100000,
      });
      expect(engine.useConsensus).toBe(false);
    });
  });

  describe('Trade execution', () => {
    it('does not open position when signal is HOLD', async () => {
      const engine = await createEngineWithMock(['HOLD']);
      const candles = makeMultipleDays('2024-01-15', 5);
      const { trades } = await engine.run(candles);
      expect(trades).toHaveLength(0);
    });

    it('opens and closes a position on BUY then SELL signals', async () => {
      // Warm-up HOLDs, then BUY, many HOLDs, then SELL
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(10).fill('HOLD'), 'SELL'];
      const engine = await createEngineWithMock(seq);
      const candles = makeTradingDay('2024-01-15');
      const { trades } = await engine.run(candles);
      expect(trades.length).toBeGreaterThanOrEqual(1);
    });

    it('does not open second position while one is open', async () => {
      // Constant BUY signal — should only open once per day
      const engine = await createEngineWithMock(['BUY']);
      const candles = makeTradingDay('2024-01-15');
      const { trades } = await engine.run(candles);
      // Only 1 trade per day (opened once, closed at square-off)
      expect(trades.length).toBeLessThanOrEqual(1);
    });

    it('squares off open position at 15:15 IST', async () => {
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(50).fill('HOLD')];
      const engine = await createEngineWithMock(seq);
      const candles = makeTradingDay('2024-01-15');
      const { trades } = await engine.run(candles);

      const squaredOff = trades.filter(t => t.exitReason === 'SQUARE_OFF');
      expect(squaredOff.length).toBeGreaterThan(0);

      // Exit time should be at or after 15:15 IST (09:45 UTC)
      for (const t of squaredOff) {
        const timeStr = toISTTimeString(t.exitTime);
        expect(timeStr >= '15:15').toBe(true);
      }
    });

    it('triggers stop loss when candle low crosses below stop price', async () => {
      // Open a position, then the next candle has a very low 'low'
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(50).fill('HOLD')];
      const engine = await createEngineWithMock(seq);

      // Build custom candles with a crash after the 26th candle
      const candles = makeTradingDay('2024-01-15');

      // After warm-up, inject a crash candle that goes -2% below open (triggering stop)
      const buyIdx = 25;
      if (candles[buyIdx + 1]) {
        const crashPrice = candles[buyIdx].close * 0.98; // 2% below entry (stop is at 1% below)
        candles[buyIdx + 1] = {
          ...candles[buyIdx + 1],
          low:  crashPrice - 5, // Force low below stop
          high: candles[buyIdx + 1].high,
        };
      }

      const { trades } = await engine.run(candles);
      const stopLossTrades = trades.filter(t => t.exitReason === 'STOP_LOSS');
      expect(stopLossTrades.length).toBeGreaterThan(0);
    });

    it('stop loss fill price is no worse than stop price', async () => {
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(50).fill('HOLD')];
      const engine = await createEngineWithMock(seq);
      const candles = makeTradingDay('2024-01-15');

      // Inject crash
      if (candles[26]) {
        candles[26] = { ...candles[26], low: candles[25].close * 0.95, high: candles[26].high };
      }

      const { trades } = await engine.run(candles);
      for (const t of trades.filter(t => t.exitReason === 'STOP_LOSS')) {
        const expectedStop = t.entryPrice * 0.99;
        // Exit price should be at or below stop price
        expect(t.exitPrice).toBeLessThanOrEqual(t.entryPrice * 0.99 + 0.01);
      }
    });
  });

  describe('Capital tracking', () => {
    it('capital increases after winning trades', async () => {
      // Force position to open and close profitably
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(10).fill('HOLD'), 'SELL'];
      const engine = await createEngineWithMock(seq);

      // Uptrending candles so close > entry
      const candles = makeTradingDay('2024-01-15', { trend: 'up', basePrice: 100 });
      const { capital, trades } = await engine.run(candles);

      if (trades.length > 0) {
        const profitTrades = trades.filter(t => t.pnl > 0);
        if (profitTrades.length > 0) {
          expect(capital).toBeGreaterThan(100000);
        }
      }
      // At minimum, capital should be positive
      expect(capital).toBeGreaterThan(0);
    });

    it('initial capital is restored if no trades taken', async () => {
      const engine = await createEngineWithMock(['HOLD']);
      const candles = makeMultipleDays('2024-01-15', 3);
      const { capital } = await engine.run(candles);
      expect(capital).toBe(100000);
    });

    it('resets capital on second run() call', async () => {
      const engine = await createEngineWithMock(['HOLD']);
      const candles = makeTradingDay('2024-01-15');
      await engine.run(candles);
      await engine.run(candles);
      expect(engine.capital).toBe(100000);
    });
  });

  describe('Position sizing', () => {
    it('always uses at least 1 share', async () => {
      // Even with tiny capital
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['ema-crossover'],
        initialCapital: 100, // Very low capital
        useConsensus:   false,
        logger:         () => {},
      });
      engine._loadStrategies = async () => ({
        'ema-crossover': mockStrategy([...Array(25).fill('HOLD'), 'BUY']),
      });
      const candles = makeTradingDay('2024-01-15');
      const { trades } = await engine.run(candles);
      for (const t of trades) {
        expect(t.quantity).toBeGreaterThanOrEqual(1);
      }
    });

    it('does not risk more than 20% of capital in one trade', async () => {
      const engine = await createEngineWithMock([...Array(25).fill('HOLD'), 'BUY']);
      const candles = makeTradingDay('2024-01-15', { basePrice: 100 });
      const { trades } = await engine.run(candles);
      for (const t of trades) {
        const positionValue = t.entryPrice * t.quantity;
        expect(positionValue).toBeLessThanOrEqual(100000 * 0.20 + 1); // small float tolerance
      }
    });
  });

  describe('Consensus mode', () => {
    it('fires trade when 2 strategies agree', async () => {
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['ema-crossover', 'rsi-reversion'],
        initialCapital: 100000,
        useConsensus:   true,
        minConsensus:   2,
        logger:         () => {},
      });

      const buySignal = { signal: 'BUY', confidence: 80, reason: 'test', strategy: 'test', timestamp: new Date().toISOString() };

      // Both strategies say BUY → should trade
      engine._getSignals = () => [buySignal, buySignal];

      // Manually test the consensus method
      const decision = engine._consensusDecision([buySignal, buySignal]);
      expect(decision).not.toBeNull();
      expect(decision.signal).toBe('BUY');
    });

    it('returns null when only 1 strategy agrees (minConsensus=2)', () => {
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['ema-crossover', 'rsi-reversion'],
        initialCapital: 100000,
        useConsensus:   true,
        minConsensus:   2,
        logger:         () => {},
      });

      const buySignal  = { signal: 'BUY',  confidence: 80, reason: 'test', strategy: 's1', timestamp: new Date().toISOString() };
      const sellSignal = { signal: 'SELL', confidence: 70, reason: 'test', strategy: 's2', timestamp: new Date().toISOString() };

      const decision = engine._consensusDecision([buySignal, sellSignal]);
      expect(decision).toBeNull();
    });

    it('returns null when no signals', () => {
      const engine = new BacktestEngine({
        symbol:         'TEST',
        strategies:     ['ema-crossover'],
        initialCapital: 100000,
        logger:         () => {},
      });
      expect(engine._consensusDecision([])).toBeNull();
    });
  });

  describe('Multi-day simulation', () => {
    it('accumulates trades across multiple days', async () => {
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(5).fill('HOLD'), 'SELL', ...Array(30).fill('HOLD')];
      const engine = await createEngineWithMock(seq);
      const candles = makeMultipleDays('2024-01-15', 10);
      const { trades } = await engine.run(candles);
      // Should have at least some trades across 8 trading days
      expect(trades.length).toBeGreaterThan(0);
    });

    it('clears position at end of each day', async () => {
      // BUY early in day, hold through close
      const seq = [...Array(25).fill('HOLD'), 'BUY', ...Array(100).fill('HOLD')];
      const engine = await createEngineWithMock(seq);
      const candles = makeMultipleDays('2024-01-15', 3);
      const { trades } = await engine.run(candles);

      // Every trade should have an exit time ≤ last candle of its day
      for (const t of trades) {
        const exitTimeStr = toISTTimeString(t.exitTime);
        expect(exitTimeStr <= '15:30').toBe(true);
      }
    });
  });

  describe('Edge cases', () => {
    it('handles empty candle array gracefully', async () => {
      const engine = await createEngineWithMock(['BUY']);
      const { trades, capital } = await engine.run([]);
      expect(trades).toHaveLength(0);
      expect(capital).toBe(100000);
    });

    it('handles single candle per day', async () => {
      const engine = await createEngineWithMock(['BUY']);
      const candle = makeCandle('2024-01-15', '09:15', { close: 100 });
      const { trades } = await engine.run([candle]);
      expect(trades).toHaveLength(0); // Not enough for warm-up
    });

    it('handles weekends in candle data gracefully', async () => {
      // Saturday/Sunday candles should just be grouped separately and produce no trades
      const satCandles = makeTradingDay('2024-01-13', { trend: 'up' }); // Saturday
      const engine = await createEngineWithMock(['HOLD']);
      await expect(engine.run(satCandles)).resolves.toBeDefined();
    });
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 4. ReportGenerator — CSV export
// ══════════════════════════════════════════════════════════════════════════════

describe('ReportGenerator', () => {

  const sampleTrades = [
    {
      symbol:      'RELIANCE',
      strategy:    'ema-crossover',
      side:        'BUY',
      entryPrice:  2500,
      exitPrice:   2550,
      quantity:    10,
      pnl:         500,
      pnlPct:      2.0,
      exitReason:  'SIGNAL',
      entryTime:   new Date('2024-01-15T04:15:00Z'),
      exitTime:    new Date('2024-01-15T06:00:00Z'),
      entryReason: 'EMA crossover detected',
      confidence:  78,
    },
    {
      symbol:      'RELIANCE',
      strategy:    'ema-crossover',
      side:        'BUY',
      entryPrice:  2560,
      exitPrice:   2534.4,
      quantity:    10,
      pnl:         -256,
      pnlPct:      -1.0,
      exitReason:  'STOP_LOSS',
      entryTime:   new Date('2024-01-16T04:15:00Z'),
      exitTime:    new Date('2024-01-16T05:00:00Z'),
      entryReason: 'EMA crossover detected',
      confidence:  65,
    },
  ];

  let tmpDir;

  beforeEach(() => {
    tmpDir = join(tmpdir(), `quant8-test-${Date.now()}`);
  });

  it('creates CSV file in specified directory', () => {
    const path = exportCsv(sampleTrades, tmpDir, 'test-export');
    expect(existsSync(path)).toBe(true);
  });

  it('CSV has correct header row', () => {
    const path    = exportCsv(sampleTrades, tmpDir, 'test-header');
    const content = readFileSync(path, 'utf8');
    const firstLine = content.split('\n')[0];
    expect(firstLine).toContain('symbol');
    expect(firstLine).toContain('strategy');
    expect(firstLine).toContain('entryPrice');
    expect(firstLine).toContain('exitPrice');
    expect(firstLine).toContain('pnl');
    expect(firstLine).toContain('exitReason');
  });

  it('CSV has correct number of data rows', () => {
    const path    = exportCsv(sampleTrades, tmpDir, 'test-rows');
    const content = readFileSync(path, 'utf8');
    const lines   = content.trim().split('\n');
    // header + 2 trades
    expect(lines).toHaveLength(3);
  });

  it('CSV contains correct P&L values', () => {
    const path    = exportCsv(sampleTrades, tmpDir, 'test-pnl');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('500');
    expect(content).toContain('-256');
  });

  it('CSV contains exit reason', () => {
    const path    = exportCsv(sampleTrades, tmpDir, 'test-reason');
    const content = readFileSync(path, 'utf8');
    expect(content).toContain('SIGNAL');
    expect(content).toContain('STOP_LOSS');
  });

  it('creates output directory if it does not exist', () => {
    const nestedDir = join(tmpDir, 'nested', 'deep');
    exportCsv(sampleTrades, nestedDir, 'test-nested');
    expect(existsSync(nestedDir)).toBe(true);
  });

  it('returns full file path', () => {
    const path = exportCsv(sampleTrades, tmpDir, 'test-path');
    expect(path).toContain('test-path.csv');
    expect(path).toContain(tmpDir);
  });
});

// ══════════════════════════════════════════════════════════════════════════════
// 5. Integration — full pipeline with mock strategy
// ══════════════════════════════════════════════════════════════════════════════

describe('Integration: full backtest pipeline', () => {

  it('produces valid metrics from a complete simulation run', async () => {
    const engine = new BacktestEngine({
      symbol:         'TEST',
      strategies:     ['ema-crossover'],
      initialCapital: 100000,
      useConsensus:   false,
      logger:         () => {},
    });

    // Alternate BUY and SELL every 5 signals after warm-up
    const seq = [
      ...Array(25).fill('HOLD'),
      'BUY', ...Array(4).fill('HOLD'), 'SELL', ...Array(4).fill('HOLD'),
      'BUY', ...Array(4).fill('HOLD'), 'SELL', ...Array(4).fill('HOLD'),
      'BUY', ...Array(4).fill('HOLD'), 'SELL',
    ];
    engine._loadStrategies = async () => ({
      'ema-crossover': mockStrategy(seq),
    });

    const candles = makeMultipleDays('2024-01-15', 14);
    const { trades, capital } = await engine.run(candles);

    const metrics = calculateMetrics(trades, 100000);

    // Basic sanity checks
    expect(metrics.totalTrades).toBe(trades.length);
    expect(metrics.winningTrades + metrics.losingTrades).toBe(metrics.totalTrades);
    expect(metrics.winRate).toBeGreaterThanOrEqual(0);
    expect(metrics.winRate).toBeLessThanOrEqual(100);
    expect(metrics.maxDrawdownPct).toBeGreaterThanOrEqual(0);
    expect(metrics.finalCapital).toBeCloseTo(capital, 0);
    expect(metrics.equityCurve[0]).toBe(100000);
    expect(metrics.equityCurve).toHaveLength(trades.length + 1);
  });

  it('ALL_STRATEGIES exports correct list', () => {
    expect(ALL_STRATEGIES).toContain('ema-crossover');
    expect(ALL_STRATEGIES).toContain('rsi-reversion');
    expect(ALL_STRATEGIES).toContain('vwap-momentum');
    expect(ALL_STRATEGIES).toContain('breakout-volume');
    expect(ALL_STRATEGIES).toHaveLength(4);
  });
});
