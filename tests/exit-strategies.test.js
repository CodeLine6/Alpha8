/**
 * @fileoverview Unit tests for exit-strategies.js
 * Run with: npx jest tests/exit-strategies.test.js
 */

import {
    computeExitLevels,
    evaluateExits,
    updateTrailStop,
    computeAtrPct,
} from '../src/risk/exit-strategies.js';

// ── Shared test config ────────────────────────────────────────────────────────

const BASE_CONFIG = {
    stopLossPct: 1.0,
    trailingStopPct: 1.5,
    profitTargetPct: 1.8,
    riskRewardRatio: 2.0,
    partialExitEnabled: true,
    partialExitPct: 50,
    signalReversalEnabled: true,
    maxHoldMinutes: 90,
};

// ── computeExitLevels ─────────────────────────────────────────────────────────

describe('computeExitLevels', () => {
    test('RSI uses fixed % profit target', () => {
        const levels = computeExitLevels({
            entryPrice: 1000, quantity: 10,
            openingStrategy: 'RSI_MEAN_REVERSION',
            allStrategies: ['RSI_MEAN_REVERSION'],
            regime: 'TRENDING',
            config: BASE_CONFIG,
        });
        expect(levels.profitTargetMode).toBe('FIXED_PCT');
        expect(levels.profitTargetPrice).toBeCloseTo(1018, 0); // 1.8% above 1000
        expect(levels.stopPrice).toBeCloseTo(990, 0);           // 1% below 1000
    });

    test('EMA uses risk/reward profit target', () => {
        const levels = computeExitLevels({
            entryPrice: 1000, quantity: 10,
            openingStrategy: 'EMA_CROSSOVER',
            allStrategies: ['EMA_CROSSOVER'],
            regime: 'TRENDING',
            config: BASE_CONFIG,
        });
        expect(levels.profitTargetMode).toBe('RISK_REWARD');
        // stop = 990, risk = 10, target = 1000 + 10 * 2 = 1020
        expect(levels.profitTargetPrice).toBeCloseTo(1020, 0);
    });

    test('VWAP uses risk/reward profit target', () => {
        const levels = computeExitLevels({
            entryPrice: 1000, quantity: 10,
            openingStrategy: 'VWAP_MOMENTUM',
            allStrategies: ['VWAP_MOMENTUM'],
            regime: 'TRENDING',
            config: BASE_CONFIG,
        });
        expect(levels.profitTargetMode).toBe('RISK_REWARD');
    });

    test('BREAKOUT uses risk/reward profit target', () => {
        const levels = computeExitLevels({
            entryPrice: 1000, quantity: 10,
            openingStrategy: 'BREAKOUT_VOLUME',
            allStrategies: ['BREAKOUT_VOLUME'],
            regime: 'TRENDING',
            config: BASE_CONFIG,
        });
        expect(levels.profitTargetMode).toBe('RISK_REWARD');
    });

    test('partial exit qty is floored to whole shares', () => {
        const levels = computeExitLevels({
            entryPrice: 1000, quantity: 7,
            openingStrategy: 'EMA_CROSSOVER',
            allStrategies: [],
            regime: 'TRENDING',
            config: { ...BASE_CONFIG, partialExitPct: 50 },
        });
        // 50% of 7 = 3.5 → floor to 3
        expect(levels.partialExitQty).toBe(3);
    });

    test('VOLATILE regime widens trail stop', () => {
        const trending = computeExitLevels({
            entryPrice: 1000, quantity: 10,
            openingStrategy: 'EMA_CROSSOVER',
            allStrategies: [],
            regime: 'TRENDING',
            config: BASE_CONFIG,
        });
        const volatile = computeExitLevels({
            entryPrice: 1000, quantity: 10,
            openingStrategy: 'EMA_CROSSOVER',
            allStrategies: [],
            regime: 'VOLATILE',
            config: BASE_CONFIG,
        });
        // VOLATILE trail stop should be further from entry than TRENDING
        expect(volatile.trailStopPrice).toBeLessThan(trending.trailStopPrice);
        expect(volatile.trailMultiplier).toBe(1.6);
        expect(trending.trailMultiplier).toBe(1.0);
    });

    test('ATR-based trail wider than fixed when ATR is high', () => {
        // Simulate high volatility candles (big ranges)
        const highs = Array(20).fill(0).map((_, i) => 1000 + i * 3 + 20);
        const lows = Array(20).fill(0).map((_, i) => 1000 + i * 3 - 20);
        const closes = Array(20).fill(0).map((_, i) => 1000 + i * 3);

        const levels = computeExitLevels({
            entryPrice: 1060, quantity: 10,
            openingStrategy: 'EMA_CROSSOVER',
            allStrategies: [],
            regime: 'TRENDING',
            recentCloses: closes,
            recentHighs: highs,
            recentLows: lows,
            config: { ...BASE_CONFIG, trailingStopPct: 0.5 }, // fixed would be tiny
        });
        // ATR-based trail should be wider than 0.5%
        const fixedTrailStop = 1060 * (1 - 0.005);
        expect(levels.trailStopPrice).toBeLessThan(fixedTrailStop);
    });
});

// ── evaluateExits ─────────────────────────────────────────────────────────────

describe('evaluateExits', () => {
    function makePosCtx(overrides = {}) {
        return {
            entryPrice: 1000,
            quantity: 10,
            timestamp: Date.now() - 30 * 60000, // 30 mins ago
            stopPrice: 990,
            trailStopPrice: 985,
            highWaterMark: 1010,
            profitTargetPrice: 1020,
            profitTargetMode: 'RISK_REWARD',
            trailPct: 1.5,
            partialExitEnabled: true,
            partialExitQty: 5,
            partialExitDone: false,
            signalReversalEnabled: true,
            openingStrategy: 'EMA_CROSSOVER',
            ...overrides,
        };
    }

    test('STOP_LOSS triggers when price <= stopPrice', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx(),
            currentPrice: 989,
            config: BASE_CONFIG,
        });
        expect(result.exit).toBe(true);
        expect(result.reason).toBe('STOP_LOSS');
    });

    test('STOP_LOSS is highest priority — fires even at target', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ stopPrice: 1025, profitTargetPrice: 1020 }),
            currentPrice: 1022,
            config: BASE_CONFIG,
        });
        expect(result.reason).toBe('STOP_LOSS');
    });

    test('PARTIAL_EXIT triggers at profit target when partial not done', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ highWaterMark: 1025, partialExitDone: false }),
            currentPrice: 1021,
            config: BASE_CONFIG,
        });
        expect(result.partial).toBe(true);
        expect(result.reason).toBe('PARTIAL_EXIT');
        expect(result.qty).toBe(5);
    });

    test('PROFIT_TARGET full exit fires after partial is done', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ highWaterMark: 1025, partialExitDone: true }),
            currentPrice: 1021,
            config: BASE_CONFIG,
        });
        expect(result.exit).toBe(true);
        expect(result.reason).toBe('PROFIT_TARGET');
    });

    test('PROFIT_TARGET fires directly when partial disabled', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ partialExitEnabled: false }),
            currentPrice: 1021,
            config: { ...BASE_CONFIG, partialExitEnabled: false },
        });
        expect(result.exit).toBe(true);
        expect(result.reason).toBe('PROFIT_TARGET');
    });

    test('TRAILING_STOP fires when price drops below trail and was profitable', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ trailStopPrice: 1005, highWaterMark: 1020 }),
            currentPrice: 1004,
            config: BASE_CONFIG,
        });
        expect(result.exit).toBe(true);
        expect(result.reason).toBe('TRAILING_STOP');
    });

    test('TRAILING_STOP does NOT fire if position never went green', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ highWaterMark: 1000, trailStopPrice: 985 }),
            currentPrice: 984,
            config: BASE_CONFIG,
        });
        // highWaterMark === entryPrice so trailing stop should not fire
        // But stop loss is 990, so stopLoss fires first
        expect(result.reason).toBe('STOP_LOSS');
    });

    test('SIGNAL_REVERSAL fires when opening strategy fires SELL', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ highWaterMark: 1000 }), // not profitable
            currentPrice: 1005, // above stop, below target
            latestSignals: { EMA_CROSSOVER: 'SELL' },
            config: BASE_CONFIG,
        });
        expect(result.exit).toBe(true);
        expect(result.reason).toBe('SIGNAL_REVERSAL');
        expect(result.meta.strategy).toBe('EMA_CROSSOVER');
    });

    test('SIGNAL_REVERSAL ignores other strategies', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ highWaterMark: 1000 }),
            currentPrice: 1005,
            latestSignals: { RSI_MEAN_REVERSION: 'SELL', EMA_CROSSOVER: 'BUY' },
            config: BASE_CONFIG,
        });
        // Only EMA_CROSSOVER (the opening strategy) matters — it's BUY, no reversal
        expect(result.exit).toBe(false);
    });

    test('SIGNAL_REVERSAL disabled when flag is false', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ signalReversalEnabled: false }),
            currentPrice: 1005,
            latestSignals: { EMA_CROSSOVER: 'SELL' },
            config: BASE_CONFIG,
        });
        expect(result.reason).not.toBe('SIGNAL_REVERSAL');
    });

    test('TIME_EXIT fires after maxHoldMinutes on flat position', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ timestamp: Date.now() - 100 * 60000 }), // 100 mins ago
            currentPrice: 1001, // only +0.1% — below 0.3% threshold
            config: BASE_CONFIG, // maxHoldMinutes: 90
        });
        expect(result.exit).toBe(true);
        expect(result.reason).toBe('TIME_EXIT');
    });

    test('TIME_EXIT does NOT fire on profitable position', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx({ timestamp: Date.now() - 100 * 60000 }),
            currentPrice: 1010, // +1% — above 0.3% threshold
            config: BASE_CONFIG,
        });
        expect(result.exit).toBe(false);
    });

    test('no exit returns exit:false', () => {
        const result = evaluateExits({
            symbol: 'RELIANCE',
            posCtx: makePosCtx(),
            currentPrice: 1005, // above stop, below target, no reversal, not timed out
            config: BASE_CONFIG,
        });
        expect(result.exit).toBe(false);
        expect(result.partial).toBe(false);
        expect(result.reason).toBeNull();
    });
});

// ── computeAtrPct ─────────────────────────────────────────────────────────────

describe('computeAtrPct', () => {
    test('returns null with insufficient data', () => {
        expect(computeAtrPct([100], [90], [95], 14)).toBeNull();
    });

    test('computes a positive ATR %', () => {
        const highs = Array(20).fill(0).map((_, i) => 1000 + i + 10);
        const lows = Array(20).fill(0).map((_, i) => 1000 + i - 10);
        const closes = Array(20).fill(0).map((_, i) => 1000 + i);
        const result = computeAtrPct(highs, lows, closes, 14);
        expect(result).toBeGreaterThan(0);
        expect(result).toBeLessThan(5); // sane range for these inputs
    });
});

// ── updateTrailStop ───────────────────────────────────────────────────────────

describe('updateTrailStop', () => {
    test('moves trail stop up when price makes new high', () => {
        const posCtx = {
            entryPrice: 1000,
            highWaterMark: 1010,
            trailStopPrice: 994,
            trailPct: 1.5,
            trailMode: 'PRICE_TRAIL',
        };
        const updates = updateTrailStop(
            posCtx, 1020, [], [], [], 'TRENDING', BASE_CONFIG
        );
        expect(updates.highWaterMark).toBe(1020);
        expect(updates.trailStopPrice).toBeGreaterThan(994);
    });

    test('does not move trail stop when price is not a new high', () => {
        const posCtx = {
            entryPrice: 1000,
            highWaterMark: 1020,
            trailStopPrice: 1004,
            trailPct: 1.5,
            trailMode: 'PRICE_TRAIL',
        };
        const updates = updateTrailStop(
            posCtx, 1015, [], [], [], 'TRENDING', BASE_CONFIG
        );
        expect(Object.keys(updates).length).toBe(0);
    });

    test('break-even protection locks trail at entry when barely profitable', () => {
        const posCtx = {
            entryPrice: 1000,
            highWaterMark: 1000,
            trailStopPrice: 985,
            trailPct: 1.5,
            trailMode: 'PRICE_TRAIL',
        };
        const updates = updateTrailStop(
            posCtx, 1006, [], [], [], 'TRENDING', BASE_CONFIG
        );
        // 0.6% above entry → should lock trail at entry
        expect(updates.trailStopPrice).toBe(1000);
    });
});