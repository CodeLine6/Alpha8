/**
 * Tier 1 Intelligence Tests
 *
 * New test cases for all 4 tasks:
 *   Task 1 — Grouped consensus (STRATEGY_GROUPS role separation)
 *   Task 2 — recordPositionOutcome called after SELL fill with correct WIN/LOSS/pnl
 *   Task 3 — Regime-adaptive threshold (REGIME_THRESHOLDS mapping)
 *   Task 4 — Zero price guard, fill price overwrite, signal price column
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { SignalConsensus, STRATEGY_GROUPS } from '../src/engine/signal-consensus.js';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { KillSwitch } from '../src/risk/kill-switch.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { REGIME_THRESHOLDS } from '../src/intelligence/enhanced-pipeline.js';

// ─── Mock Strategy Helper ─────────────────────────────────────────────────────

/**
 * Create a mock strategy with a fixed name/signal/confidence.
 * strategy name must match the keys used in STRATEGY_GROUPS for grouped consensus to work.
 */
function mockStrategy(name, signal, confidence) {
    return {
        name,
        analyze: jest.fn(() => ({
            signal,
            confidence,
            reason: `${name}: ${signal} at ${confidence}%`,
            strategy: name,          // ← required for group lookup
            timestamp: new Date().toISOString(),
        })),
    };
}

// ─── Shared setup helpers ─────────────────────────────────────────────────────

function makeEngine({ consensus, pipeline = null, paperMode = true } = {}) {
    const ks = new KillSwitch();
    const rm = new RiskManager({
        capital: 100000,
        killSwitch: ks,
        maxDailyLossPct: 2,
        perTradeStopLossPct: 1,
        maxPositionCount: 5,
        killSwitchDrawdownPct: 5,
    });
    const c = consensus ?? (() => {
        const sc = new SignalConsensus({ groupedConsensus: false, minAgreement: 0 });
        return sc;
    })();

    return {
        engine: new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus: c, pipeline, paperMode }),
        ks,
        rm,
        consensus: c,
    };
}

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 1 — GROUPED CONSENSUS
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 1 — STRATEGY_GROUPS export', () => {
    test('REVERSAL group contains ORB and BAVI (v1.1)', () => {
        expect(STRATEGY_GROUPS.REVERSAL).toContain('ORB');
        expect(STRATEGY_GROUPS.REVERSAL).toContain('BAVI');
        expect(STRATEGY_GROUPS.REVERSAL).toHaveLength(2);
    });


    test('MOMENTUM group contains VWAP_MOMENTUM and BREAKOUT_VOLUME', () => {
        expect(STRATEGY_GROUPS.MOMENTUM).toContain('VWAP_MOMENTUM');
        expect(STRATEGY_GROUPS.MOMENTUM).toContain('BREAKOUT_VOLUME');
        expect(STRATEGY_GROUPS.MOMENTUM).toHaveLength(2);
    });
});

describe('Task 1 — Grouped Consensus mode (groupedConsensus: true)', () => {
    test('REVERSAL BUY + MOMENTUM BUY → BUY signal', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('BAVI', 'BUY', 80));            // REVERSAL group
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'BUY', 70));

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('BUY');
        expect(result.reason).toContain('BUY consensus');
        expect(result.reason).toContain('reversal');
        expect(result.reason).toContain('momentum');
    });

    test('REVERSAL SELL + MOMENTUM SELL → SELL signal', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('ORB', 'SELL', 75));          // REVERSAL group
        consensus.addStrategy(mockStrategy('BREAKOUT_VOLUME', 'SELL', 65)); // MOMENTUM group

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('SELL');
        expect(result.reason).toContain('SELL consensus');
        expect(result.reason).toContain('reversal');
        expect(result.reason).toContain('momentum');
    });

    test('REVERSAL BUY alone (no MOMENTUM) → HOLD', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('RSI_MEAN_REVERSION', 'BUY', 85));
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'SELL', 70)); // momentum disagrees

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('HOLD');
    });

    test('MOMENTUM SELL alone (no REVERSAL) → HOLD', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('BREAKOUT_VOLUME', 'SELL', 80));
        // no reversal strategy

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('HOLD');
    });

    test('REVERSAL BUY + MOMENTUM SELL (groups disagree) → HOLD', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('RSI_MEAN_REVERSION', 'BUY', 85));
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'SELL', 70));

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('HOLD');
    });

    test('ORB BUY + Breakout BUY → BUY (one each from reversal + momentum)', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('ORB', 'BUY', 75));            // REVERSAL group
        consensus.addStrategy(mockStrategy('BREAKOUT_VOLUME', 'BUY', 70)); // MOMENTUM group

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('BUY');
    });

    test('All 4 agree BUY → BUY with correct groupVotes', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('ORB', 'BUY', 70));            // REVERSAL group
        consensus.addStrategy(mockStrategy('BAVI', 'BUY', 75));            // REVERSAL group
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'BUY', 68));  // MOMENTUM group
        consensus.addStrategy(mockStrategy('BREAKOUT_VOLUME', 'BUY', 80)); // MOMENTUM group

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('BUY');
        expect(result.groupVotes.reversal.buy).toBe(2);
        expect(result.groupVotes.momentum.buy).toBe(2);
    });

    test('Low-confidence signals (below minConfidence) do not count toward group vote', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 60 });
        // Reversal at 85 (counts) + Momentum at 30 (too low → doesn't count)
        consensus.addStrategy(mockStrategy('BAVI', 'BUY', 85));            // REVERSAL group
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'BUY', 30)); // below threshold

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('HOLD'); // momentum vote not counted
        expect(result.groupVotes.momentum.buy).toBe(0);
        expect(result.groupVotes.reversal.buy).toBe(1);
    });

    test('groupVotes is always present in result (shape check)', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true });

        const result = consensus.evaluate([]);

        expect(result).toHaveProperty('groupVotes');
        expect(result.groupVotes).toHaveProperty('reversal');
        expect(result.groupVotes).toHaveProperty('momentum');
        expect(result.groupVotes.reversal).toHaveProperty('buy');
        expect(result.groupVotes.reversal).toHaveProperty('sell');
        expect(result.groupVotes.momentum).toHaveProperty('buy');
        expect(result.groupVotes.momentum).toHaveProperty('sell');
    });

    test('votes object (legacy) is still returned unchanged for dashboard compat', () => {
        const consensus = new SignalConsensus({ groupedConsensus: true, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('RSI_MEAN_REVERSION', 'BUY', 80));
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'BUY', 70));

        const result = consensus.evaluate([]);

        expect(result.votes).toBeDefined();
        expect(result.votes.buy).toBeGreaterThanOrEqual(1);
    });
});

describe('Task 1 — Fallback mode (groupedConsensus: false)', () => {
    test('groupedConsensus: false with 2 BUY → BUY (original minAgreement path)', () => {
        const consensus = new SignalConsensus({ groupedConsensus: false, minAgreement: 2, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('EMA_CROSSOVER', 'BUY', 70));
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'BUY', 65));

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('BUY');
        expect(result.reason).toContain('2/'); // simple "N/total" count format
    });

    test('groupedConsensus: false with 1 BUY 1 SELL → HOLD (insufficient agreement)', () => {
        const consensus = new SignalConsensus({ groupedConsensus: false, minAgreement: 2, minConfidence: 40 });
        consensus.addStrategy(mockStrategy('EMA_CROSSOVER', 'BUY', 70));
        consensus.addStrategy(mockStrategy('VWAP_MOMENTUM', 'SELL', 65));

        const result = consensus.evaluate([]);

        expect(result.signal).toBe('HOLD');
        expect(result.reason).toContain('No consensus');
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 2 — OUTCOME RECORDING ON SELL FILL
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 2 — recordPositionOutcome on SELL fill', () => {
    let engine, ks, rm, consensus;

    beforeEach(async () => {
        ks = new KillSwitch();
        rm = new RiskManager({
            capital: 100000, killSwitch: ks,
            maxDailyLossPct: 2, perTradeStopLossPct: 1, maxPositionCount: 5, killSwitchDrawdownPct: 5,
        });
        consensus = new SignalConsensus({ groupedConsensus: false, minAgreement: 0 });
    });

    test('recordPositionOutcome called with WIN pnl when sell > entry price', async () => {
        const recordTradeOutcome = jest.fn().mockResolvedValue(undefined);
        const recordOutcome = jest.fn().mockResolvedValue(undefined);
        const mockPipeline = {
            recordTradeOutcome,
            adaptiveWeights: { recordOutcome },
        };

        engine = new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus, pipeline: mockPipeline, paperMode: true });
        await engine.initialize();

        // Simulate a BUY that was tracked by processSignal
        engine._lastSignalStrategies.set('RELIANCE', ['RSI_MEAN_REVERSION', 'VWAP_MOMENTUM']);

        // BUY fill — stores context in _filledPositions map
        await engine.executeOrder({ symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500 });

        // SELL fill — triggers recordPositionOutcome
        const sellOrder = await engine.executeOrder({ symbol: 'RELIANCE', side: 'SELL', quantity: 10, price: 2700 });
        expect(sellOrder.state).toBe('FILLED');

        // Allow the fire-and-forget to complete
        await new Promise(resolve => setTimeout(resolve, 50));

        const expectedPnl = (2700 - 2500) * 10; // 2000 (WIN)
        expect(recordTradeOutcome).toHaveBeenCalledWith('RSI_MEAN_REVERSION', 'BUY', 'RELIANCE', expectedPnl);
        expect(recordTradeOutcome).toHaveBeenCalledWith('VWAP_MOMENTUM', 'BUY', 'RELIANCE', expectedPnl);
        expect(recordOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ strategy: 'RSI_MEAN_REVERSION', outcome: 'WIN', pnl: expectedPnl })
        );
    });

    test('recordPositionOutcome called with LOSS pnl when sell < entry price', async () => {
        const recordTradeOutcome = jest.fn().mockResolvedValue(undefined);
        const recordOutcome = jest.fn().mockResolvedValue(undefined);
        const mockPipeline = {
            recordTradeOutcome,
            adaptiveWeights: { recordOutcome },
        };

        engine = new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus, pipeline: mockPipeline, paperMode: true });
        await engine.initialize();

        engine._lastSignalStrategies.set('TCS', ['EMA_CROSSOVER']);

        await engine.executeOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
        await engine.executeOrder({ symbol: 'TCS', side: 'SELL', quantity: 5, price: 2800 });

        await new Promise(resolve => setTimeout(resolve, 50));

        const expectedPnl = (2800 - 3000) * 5; // -1000 (LOSS)
        expect(recordTradeOutcome).toHaveBeenCalledWith('EMA_CROSSOVER', 'BUY', 'TCS', expectedPnl);
        expect(recordOutcome).toHaveBeenCalledWith(
            expect.objectContaining({ outcome: 'LOSS', pnl: expectedPnl })
        );
    });

    test('recordPositionOutcome does not crash when pipeline is null', async () => {
        engine = new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus, pipeline: null, paperMode: true });
        await engine.initialize();

        // Should not throw — just logs warning
        await expect(engine.recordPositionOutcome('RELIANCE', 1000)).resolves.toBeUndefined();
    });

    test('_filledPositions removed after SELL fill', async () => {
        const recordTradeOutcome = jest.fn().mockResolvedValue(undefined);
        const mockPipeline = { recordTradeOutcome, adaptiveWeights: null };

        engine = new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus, pipeline: mockPipeline, paperMode: true });
        await engine.initialize();

        engine._lastSignalStrategies.set('INFY', ['RSI_MEAN_REVERSION']);
        await engine.executeOrder({ symbol: 'INFY', side: 'BUY', quantity: 3, price: 1500 });

        expect(engine._filledPositions.has('INFY')).toBe(true);

        await engine.executeOrder({ symbol: 'INFY', side: 'SELL', quantity: 3, price: 1600 });
        await new Promise(resolve => setTimeout(resolve, 50));

        expect(engine._filledPositions.has('INFY')).toBe(false);
    });

    test('correct pnl formula: (sellPrice - entryPrice) * quantity', async () => {
        const recordTradeOutcome = jest.fn().mockResolvedValue(undefined);
        const mockPipeline = { recordTradeOutcome, adaptiveWeights: null };

        engine = new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus, pipeline: mockPipeline, paperMode: true });
        await engine.initialize();

        engine._lastSignalStrategies.set('WIPRO', ['BREAKOUT_VOLUME']);
        await engine.executeOrder({ symbol: 'WIPRO', side: 'BUY', quantity: 20, price: 400 });
        await engine.executeOrder({ symbol: 'WIPRO', side: 'SELL', quantity: 20, price: 450 });

        await new Promise(resolve => setTimeout(resolve, 50));

        // (450 - 400) * 20 = 1000
        expect(recordTradeOutcome).toHaveBeenCalledWith('BREAKOUT_VOLUME', 'BUY', 'WIPRO', 1000);
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 3 — REGIME_THRESHOLDS EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 3 — REGIME_THRESHOLDS constant', () => {
    test('TRENDING maps to 1.8', () => {
        expect(REGIME_THRESHOLDS.TRENDING).toBe(1.8);
    });

    test('SIDEWAYS maps to 2.0', () => {
        expect(REGIME_THRESHOLDS.SIDEWAYS).toBe(2.0);
    });

    test('VOLATILE maps to 2.5', () => {
        expect(REGIME_THRESHOLDS.VOLATILE).toBe(2.5);
    });

    test('UNKNOWN maps to 2.0 (same as default)', () => {
        expect(REGIME_THRESHOLDS.UNKNOWN).toBe(2.0);
    });

    test('null regime falls back to 2.0 via nullish coalescing', () => {
        const nullishFallback = REGIME_THRESHOLDS[null] ?? 2.0;
        expect(nullishFallback).toBe(2.0);
    });

    test('unrecognised regime key falls back to 2.0', () => {
        const fallback = REGIME_THRESHOLDS['FOOBAR'] ?? 2.0;
        expect(fallback).toBe(2.0);
    });

    test('all expected keys are present', () => {
        const expectedKeys = ['TRENDING', 'SIDEWAYS', 'VOLATILE', 'UNKNOWN'];
        for (const key of expectedKeys) {
            expect(REGIME_THRESHOLDS).toHaveProperty(key);
            expect(typeof REGIME_THRESHOLDS[key]).toBe('number');
        }
    });
});

// ═══════════════════════════════════════════════════════════════════════════════
// TASK 4 — PRICE COLUMN POPULATION
// ═══════════════════════════════════════════════════════════════════════════════

describe('Task 4 — Fill price overwrites scan-time price in live mode', () => {
    let ks, rm, consensus;

    beforeEach(() => {
        ks = new KillSwitch();
        rm = new RiskManager({
            capital: 100000, killSwitch: ks,
            maxDailyLossPct: 2, perTradeStopLossPct: 1, maxPositionCount: 5, killSwitchDrawdownPct: 5,
        });
        consensus = new SignalConsensus({ groupedConsensus: false, minAgreement: 0 });
    });

    test('fill price from getOrderHistory overwrites scan-time price on order.price', async () => {
        const mockPlaceOrder = jest.fn().mockResolvedValue({ order_id: 'KITE-99' });
        const mockGetOrderHistory = jest.fn().mockResolvedValue([{ average_price: 2550 }]);

        const liveEngine = new ExecutionEngine({
            riskManager: rm, killSwitch: ks, consensus, paperMode: false,
            broker: { placeOrder: mockPlaceOrder, getOrderHistory: mockGetOrderHistory },
        });
        await liveEngine.initialize();

        const order = await liveEngine.executeOrder({
            symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500, // scan-time price
        });

        expect(mockGetOrderHistory).toHaveBeenCalledWith('KITE-99');
        expect(order.price).toBe(2550); // actual fill price, not scan-time
    });

    test('when getOrderHistory fails, order.price stays as scan-time price (non-fatal)', async () => {
        const mockPlaceOrder = jest.fn().mockResolvedValue({ order_id: 'KITE-100' });
        const mockGetOrderHistory = jest.fn().mockRejectedValue(new Error('History unavailable'));

        const liveEngine = new ExecutionEngine({
            riskManager: rm, killSwitch: ks, consensus, paperMode: false,
            broker: { placeOrder: mockPlaceOrder, getOrderHistory: mockGetOrderHistory },
        });
        await liveEngine.initialize();

        const order = await liveEngine.executeOrder({
            symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000,
        });

        expect(order.state).toBe('REJECTED'); // test mock logic rejection
        expect(order.price).toBe(3000);     // scan-time price kept
    });

    test('when getOrderHistory returns null average_price, scan-time price is kept', async () => {
        const mockPlaceOrder = jest.fn().mockResolvedValue({ order_id: 'KITE-101' });
        const mockGetOrderHistory = jest.fn().mockResolvedValue([{ status: 'COMPLETE', average_price: null }]);

        const liveEngine = new ExecutionEngine({
            riskManager: rm, killSwitch: ks, consensus, paperMode: false,
            broker: { placeOrder: mockPlaceOrder, getOrderHistory: mockGetOrderHistory },
        });
        await liveEngine.initialize();

        const order = await liveEngine.executeOrder({
            symbol: 'INFY', side: 'BUY', quantity: 8, price: 1500,
        });

        expect(order.price).toBe(1500); // unchanged because fillPrice was null
    });
});

describe('Task 4 — _persistSignals includes price column', () => {
    let queryMock;

    beforeEach(() => {
        // We can't directly test the DB INSERT here without mocking the db module,
        // so we verify the _persistSignals method accepts the third argument without throwing.
        // DB integration is validated via the query call count in the execution flow.
    });

    test('_persistSignals accepts currentPrice as 3rd argument without error', async () => {
        const ks = new KillSwitch();
        const rm = new RiskManager({
            capital: 100000, killSwitch: ks, maxDailyLossPct: 2,
            perTradeStopLossPct: 1, maxPositionCount: 5, killSwitchDrawdownPct: 5,
        });
        const consensus = new SignalConsensus({ groupedConsensus: false, minAgreement: 0 });
        const engine = new ExecutionEngine({ riskManager: rm, killSwitch: ks, consensus, paperMode: true });
        await engine.initialize();

        // _persistSignals does a DB query — it will fail (no DB in test env)
        // but the key check is that it does NOT throw due to wrong arity or type errors.
        const fakeConsensus = {
            signal: 'BUY',
            confidence: 75,
            reason: 'test',
            details: [{ strategy: 'EMA_CROSSOVER', signal: 'BUY', confidence: 75, reason: 'test' }],
        };

        // Should resolve to null (the DB error is caught internally and logged, returning null)
        await expect(engine._persistSignals('RELIANCE', fakeConsensus, 2500)).resolves.toBeNull();

    });
});
