/**
 * Unit tests for the Order Execution Engine module.
 * Tests SignalConsensus, OrderStateMachine, and ExecutionEngine.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { SignalConsensus } from '../src/engine/signal-consensus.js';
import { createOrder, transitionOrder, isTerminal } from '../src/engine/order-state-machine.js';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { KillSwitch } from '../src/risk/kill-switch.js';
import { RiskManager } from '../src/risk/risk-manager.js';

// ─── Mock Strategy Helper ─────────────────────────────────

function mockStrategy(name, signal, confidence) {
  return {
    name,
    analyze: jest.fn(() => ({
      signal,
      confidence,
      reason: `${name}: ${signal} at ${confidence}%`,
      strategy: name,
      timestamp: new Date().toISOString(),
    })),
  };
}

// ═══════════════════════════════════════════════════════════
// ORDER STATE MACHINE
// ═══════════════════════════════════════════════════════════

describe('OrderStateMachine', () => {
  test('createOrder should return PENDING order with all fields', () => {
    const order = createOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.id).toMatch(/^ORD-/);
    expect(order.state).toBe('PENDING');
    expect(order.symbol).toBe('RELIANCE');
    expect(order.side).toBe('BUY');
    expect(order.quantity).toBe(10);
    expect(order.price).toBe(2500);
    expect(order.brokerId).toBeNull();
    expect(order.rejectionReason).toBeNull();
    expect(order.history).toHaveLength(1);
    expect(order.history[0].state).toBe('PENDING');
  });

  test('PENDING → PLACED should succeed', () => {
    const order = createOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
    transitionOrder(order, 'PLACED', { brokerId: 'BRK-123' });

    expect(order.state).toBe('PLACED');
    expect(order.brokerId).toBe('BRK-123');
    expect(order.history).toHaveLength(2);
  });

  test('PENDING → REJECTED should succeed', () => {
    const order = createOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
    transitionOrder(order, 'REJECTED', { rejectionReason: 'Risk limit exceeded' });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toBe('Risk limit exceeded');
  });

  test('PLACED → FILLED should succeed', () => {
    const order = createOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
    transitionOrder(order, 'PLACED');
    transitionOrder(order, 'FILLED');

    expect(order.state).toBe('FILLED');
    expect(order.history).toHaveLength(3);
  });

  test('PLACED → CANCELLED should succeed', () => {
    const order = createOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
    transitionOrder(order, 'PLACED');
    transitionOrder(order, 'CANCELLED');

    expect(order.state).toBe('CANCELLED');
  });

  test('PENDING → FILLED should throw (invalid transition)', () => {
    const order = createOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
    expect(() => transitionOrder(order, 'FILLED')).toThrow('Invalid order transition');
  });

  test('FILLED → anything should throw (terminal state)', () => {
    const order = createOrder({ symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000 });
    transitionOrder(order, 'PLACED');
    transitionOrder(order, 'FILLED');

    expect(() => transitionOrder(order, 'CANCELLED')).toThrow('Invalid order transition');
  });

  test('isTerminal should identify terminal states', () => {
    const filled = createOrder({ symbol: 'A', side: 'BUY', quantity: 1, price: 100 });
    transitionOrder(filled, 'PLACED');
    transitionOrder(filled, 'FILLED');
    expect(isTerminal(filled)).toBe(true);

    const rejected = createOrder({ symbol: 'B', side: 'BUY', quantity: 1, price: 100 });
    transitionOrder(rejected, 'REJECTED');
    expect(isTerminal(rejected)).toBe(true);

    const pending = createOrder({ symbol: 'C', side: 'BUY', quantity: 1, price: 100 });
    expect(isTerminal(pending)).toBe(false);
  });

  test('history should maintain full audit trail', () => {
    const order = createOrder({ symbol: 'INFY', side: 'BUY', quantity: 1, price: 1500 });
    transitionOrder(order, 'PLACED', { brokerId: 'B-1' });
    transitionOrder(order, 'FILLED');

    expect(order.history).toHaveLength(3);
    expect(order.history[0].state).toBe('PENDING');
    expect(order.history[1].state).toBe('PLACED');
    expect(order.history[1].brokerId).toBe('B-1');
    expect(order.history[2].state).toBe('FILLED');
  });
});

// ═══════════════════════════════════════════════════════════
// SIGNAL CONSENSUS
// ═══════════════════════════════════════════════════════════

describe('SignalConsensus', () => {
  test('should return HOLD with no strategies', () => {
    const consensus = new SignalConsensus();
    const result = consensus.evaluate([]);

    expect(result.signal).toBe('HOLD');
    expect(result.reason).toContain('No strategies');
  });

  test('should return BUY when 2+ strategies agree on BUY', () => {
    const consensus = new SignalConsensus({ minAgreement: 2 });
    consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
    consensus.addStrategy(mockStrategy('RSI', 'BUY', 65));
    consensus.addStrategy(mockStrategy('VWAP', 'HOLD', 0));

    const result = consensus.evaluate([]);

    expect(result.signal).toBe('BUY');
    expect(result.votes.buy).toBe(2);
    expect(result.confidence).toBeGreaterThan(0);
    expect(result.reason).toContain('BUY consensus');
  });

  test('should return SELL when 2+ strategies agree on SELL', () => {
    const consensus = new SignalConsensus({ minAgreement: 2 });
    consensus.addStrategy(mockStrategy('EMA', 'SELL', 80));
    consensus.addStrategy(mockStrategy('RSI', 'SELL', 60));
    consensus.addStrategy(mockStrategy('VWAP', 'HOLD', 0));

    const result = consensus.evaluate([]);

    expect(result.signal).toBe('SELL');
    expect(result.votes.sell).toBe(2);
  });

  test('should return HOLD when no consensus reached', () => {
    const consensus = new SignalConsensus({ minAgreement: 2 });
    consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
    consensus.addStrategy(mockStrategy('RSI', 'SELL', 60));
    consensus.addStrategy(mockStrategy('VWAP', 'HOLD', 0));

    const result = consensus.evaluate([]);

    expect(result.signal).toBe('HOLD');
    expect(result.reason).toContain('No consensus');
  });

  test('low-confidence signals should count as HOLD', () => {
    const consensus = new SignalConsensus({ minAgreement: 2, minConfidence: 50 });
    consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));  // counts
    consensus.addStrategy(mockStrategy('RSI', 'BUY', 30));  // too low → HOLD
    consensus.addStrategy(mockStrategy('VWAP', 'HOLD', 0)); // HOLD

    const result = consensus.evaluate([]);

    expect(result.signal).toBe('HOLD');
    expect(result.votes.buy).toBe(1); // only 1 strong enough
  });

  test('should handle strategy errors gracefully', () => {
    const consensus = new SignalConsensus({ minAgreement: 1 });
    consensus.addStrategy({
      name: 'broken',
      analyze: () => { throw new Error('Strategy crashed'); },
    });
    consensus.addStrategy(mockStrategy('RSI', 'BUY', 70));

    const result = consensus.evaluate([]);
    // Broken strategy counts as HOLD, RSI is BUY → 1 BUY vote
    expect(result.signal).toBe('BUY'); // minAgreement=1
    expect(result.details).toHaveLength(2);
  });

  test('should return individual strategy details', () => {
    const consensus = new SignalConsensus();
    consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
    consensus.addStrategy(mockStrategy('RSI', 'SELL', 60));

    const result = consensus.evaluate([]);
    expect(result.details).toHaveLength(2);
    expect(result.votes).toEqual(expect.objectContaining({ buy: 1, sell: 1 }));
  });

  test('BUY should win over SELL when BUY has more votes', () => {
    const consensus = new SignalConsensus({ minAgreement: 2 });
    consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
    consensus.addStrategy(mockStrategy('RSI', 'BUY', 60));
    consensus.addStrategy(mockStrategy('VWAP', 'SELL', 80));

    const result = consensus.evaluate([]);
    expect(result.signal).toBe('BUY');
  });
});

// ═══════════════════════════════════════════════════════════
// EXECUTION ENGINE
// ═══════════════════════════════════════════════════════════

describe('ExecutionEngine', () => {
  let engine;
  let ks;
  let rm;
  let consensus;

  beforeEach(async () => {
    ks = new KillSwitch();
    rm = new RiskManager({
      capital: 100000,
      killSwitch: ks,
      maxDailyLossPct: 2,
      perTradeStopLossPct: 1,
      maxPositionCount: 5,
      killSwitchDrawdownPct: 5,
    });

    consensus = new SignalConsensus({ minAgreement: 2 });
    consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
    consensus.addStrategy(mockStrategy('RSI', 'BUY', 65));

    engine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: true,
      maxRetries: 2,
      retryDelayMs: 10,
    });
  });

  // ─── Requirement #7: Startup Integrity ─────────────────

  test('should call verifyIntegrity at startup', async () => {
    const result = await engine.initialize();

    expect(result.ready).toBe(true);
    expect(result.integrity).toBeDefined();
  });

  test('should NOT start if kill switch is engaged', async () => {
    await ks.engage('Critical drawdown');

    const result = await engine.initialize();

    expect(result.ready).toBe(false);
  });

  test('should reject orders if not initialized', async () => {
    const result = await engine.processSignal('TCS', [], 3000, 5);

    expect(result.action).toBe('ENGINE_NOT_INITIALIZED');
    expect(result.order).toBeNull();
  });

  // ─── Requirement #3: Paper Mode ────────────────────────

  test('paper mode should place and fill orders', async () => {
    await engine.initialize();

    const order = await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('FILLED');
    expect(order.brokerId).toContain('PAPER');
    expect(order.history).toHaveLength(3); // PENDING → PLACED → FILLED
  });

  // ─── Requirement #1: Risk Gate ─────────────────────────

  test('should REJECT order when risk check fails', async () => {
    await engine.initialize();

    // Big order that exceeds per-trade risk
    const order = await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 100, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toContain('Risk gate');
  });

  test('should REJECT order when kill switch is engaged', async () => {
    await engine.initialize();
    await ks.engage('Emergency');

    const order = await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toContain('KILL SWITCH');
  });

  // ─── Requirement #5: Duplicate Pending Guard ───────────

  test('should REJECT duplicate pending order for same symbol', async () => {
    await engine.initialize();

    // Manually add a pending symbol to simulate in-flight order
    engine._pendingSymbols.add('RELIANCE');

    const order = await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toContain('Duplicate');
  });

  test('should allow orders for different symbols simultaneously', async () => {
    await engine.initialize();

    const order1 = await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });
    const order2 = await engine.executeOrder({
      symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000,
    });

    expect(order1.state).toBe('FILLED');
    expect(order2.state).toBe('FILLED');
  });

  test('pending symbol should be cleared after order completes', async () => {
    await engine.initialize();

    await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(engine.hasPendingOrder('RELIANCE')).toBe(false);
  });

  // ─── Requirement #6: Signal Consensus ──────────────────

  test('processSignal should use consensus layer', async () => {
    await engine.initialize();

    const result = await engine.processSignal('RELIANCE', [], 2500, 10);

    // Both mock strategies return BUY → consensus BUY → order placed
    expect(result.action).toBe('EXECUTED');
    expect(result.consensus.signal).toBe('BUY');
    expect(result.order.state).toBe('FILLED');
  });

  test('processSignal should HOLD when consensus disagrees', async () => {
    // Replace strategies with disagreeing ones
    engine.consensus = new SignalConsensus({ minAgreement: 2 });
    engine.consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
    engine.consensus.addStrategy(mockStrategy('RSI', 'SELL', 60));

    await engine.initialize();
    const result = await engine.processSignal('RELIANCE', [], 2500, 10);

    expect(result.action).toBe('HOLD');
    expect(result.order).toBeNull();
  });

  // ─── Retry Logic: Retryable vs Non-Retryable ────────────

  test('should RETRY on network timeout (retryable)', async () => {
    const timeoutErr = new Error('Broker timeout');
    const mockPlaceOrder = jest.fn().mockRejectedValue(timeoutErr);

    const liveEngine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: false,
      maxRetries: 3,
      retryDelayMs: 10,
      broker: { placeOrder: mockPlaceOrder },
    });

    await liveEngine.initialize();

    const order = await liveEngine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toContain('retries');
    // Should have been called 3 times (all retries)
    expect(mockPlaceOrder).toHaveBeenCalledTimes(3);
  });

  test('should NOT RETRY on 4xx broker rejection (non-retryable)', async () => {
    const rejectionErr = new Error('Insufficient margin');
    rejectionErr.response = { status: 403, data: { message: 'Insufficient margin' } };

    const mockPlaceOrder = jest.fn().mockRejectedValue(rejectionErr);

    const liveEngine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: false,
      maxRetries: 3,
      retryDelayMs: 10,
      broker: { placeOrder: mockPlaceOrder },
    });

    await liveEngine.initialize();

    const order = await liveEngine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toContain('Broker rejected');
    expect(order.rejectionReason).toContain('Insufficient margin');
    // Should have been called ONLY ONCE — no retry
    expect(mockPlaceOrder).toHaveBeenCalledTimes(1);
  });

  test('should RETRY on 5xx server error (retryable)', async () => {
    const serverErr = new Error('Internal Server Error');
    serverErr.response = { status: 500, data: {} };

    const mockPlaceOrder = jest.fn().mockRejectedValue(serverErr);

    const liveEngine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: false,
      maxRetries: 2,
      retryDelayMs: 10,
      broker: { placeOrder: mockPlaceOrder },
    });

    await liveEngine.initialize();

    const order = await liveEngine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    // Should have retried (called 2 times)
    expect(mockPlaceOrder).toHaveBeenCalledTimes(2);
  });

  test('should RETRY on ECONNRESET (retryable)', async () => {
    const connErr = new Error('socket hang up');
    connErr.code = 'ECONNRESET';

    const mockPlaceOrder = jest.fn().mockRejectedValue(connErr);

    const liveEngine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: false,
      maxRetries: 2,
      retryDelayMs: 10,
      broker: { placeOrder: mockPlaceOrder },
    });

    await liveEngine.initialize();

    const order = await liveEngine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(mockPlaceOrder).toHaveBeenCalledTimes(2);
  });

  test('should NOT RETRY on missing broker (non-retryable)', async () => {
    const noBrokerEngine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: false,
      maxRetries: 3,
      retryDelayMs: 10,
    });

    await noBrokerEngine.initialize();

    const order = await noBrokerEngine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('REJECTED');
    expect(order.rejectionReason).toContain('requires a broker instance');
  });

  test('live mode should succeed on first try', async () => {
    const liveEngine = new ExecutionEngine({
      riskManager: rm,
      killSwitch: ks,
      consensus,
      paperMode: false,
      maxRetries: 3,
      retryDelayMs: 10,
      broker: {
        placeOrder: jest.fn().mockResolvedValue({
          orderId: 'KITE-12345',
          status: 'COMPLETE',
          broker: 'kite',
        }),
      },
    });

    await liveEngine.initialize();

    const order = await liveEngine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    expect(order.state).toBe('PLACED');
    expect(order.brokerId).toBe('KITE-12345');
  });

  test('_isRetryable should classify correctly', async () => {
    await engine.initialize();

    // Retryable
    expect(engine._isRetryable({ code: 'ECONNRESET' })).toBe(true);
    expect(engine._isRetryable({ code: 'ETIMEDOUT' })).toBe(true);
    expect(engine._isRetryable({ response: { status: 502 } })).toBe(true);
    expect(engine._isRetryable({ message: 'Request timeout' })).toBe(true);

    // NOT retryable
    expect(engine._isRetryable({ response: { status: 400 } })).toBe(false);
    expect(engine._isRetryable({ response: { status: 403 } })).toBe(false);
    expect(engine._isRetryable(new Error('Live trading requires a broker instance'))).toBe(false);
    expect(engine._isRetryable(new TypeError('Cannot read properties'))).toBe(false);
  });

  // ─── Order Management ─────────────────────────────────

  test('cancelOrder should cancel non-terminal orders', async () => {
    await engine.initialize();

    const order = await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    // In paper mode, orders are FILLED immediately, so cancel should not change
    const cancelled = engine.cancelOrder(order.id);
    expect(cancelled.state).toBe('FILLED'); // already terminal
  });

  test('getOrder should return order by ID', async () => {
    await engine.initialize();

    const order = await engine.executeOrder({
      symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000,
    });

    expect(engine.getOrder(order.id)).toBe(order);
    expect(engine.getOrder('nonexistent')).toBeNull();
  });

  test('getAllOrders should return all tracked orders', async () => {
    await engine.initialize();

    await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });
    await engine.executeOrder({
      symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000,
    });

    expect(engine.getAllOrders()).toHaveLength(2);
  });

  test('getStatus should return comprehensive engine state', async () => {
    await engine.initialize();

    await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    const status = engine.getStatus();
    expect(status.initialized).toBe(true);
    expect(status.paperMode).toBe(true);
    expect(status.totalOrders).toBe(1);
    expect(status.ordersByState.filled).toBe(1);
    expect(status.riskStatus).toBeDefined();
  });
});
