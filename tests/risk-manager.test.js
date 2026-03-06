/**
 * Unit tests for the Risk Management Module.
 * Tests KillSwitch, RiskManager, and PositionSizer.
 *
 * These are the MOST CRITICAL tests in the entire app.
 * A bug here can wipe capital.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { KillSwitch } from '../src/risk/kill-switch.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { calculatePositionSize } from '../src/risk/position-sizer.js';

// ═══════════════════════════════════════════════════════════
// KILL SWITCH
// ═══════════════════════════════════════════════════════════

describe('KillSwitch', () => {
  let ks;
  let mockRedis;

  beforeEach(() => {
    mockRedis = { stored: null };
    ks = new KillSwitch({
      cacheGet: jest.fn(async () => mockRedis.stored),
      cacheSet: jest.fn(async (key, value) => { mockRedis.stored = value; }),
    });
  });

  // ─── Engagement ────────────────────────────────────────

  test('should start disengaged', () => {
    expect(ks.isEngaged()).toBe(false);
  });

  test('should engage and set in-memory state immediately', async () => {
    await ks.engage('Drawdown exceeded 5%', 5.2);

    expect(ks.isEngaged()).toBe(true);
    expect(ks.getStatus().reason).toBe('Drawdown exceeded 5%');
    expect(ks.getStatus().drawdownPct).toBe(5.2);
    expect(ks.getStatus().engagedAt).toBeDefined();
  });

  test('isEngaged() should be synchronous — no Promise returned', async () => {
    await ks.engage('test');
    const result = ks.isEngaged();

    // Must NOT be a Promise
    expect(result).toBe(true);
    expect(typeof result).toBe('boolean');
    expect(result).not.toBeInstanceOf(Promise);
  });

  // ─── Redis Persistence ────────────────────────────────

  test('engage() should AWAIT Redis write (not fire-and-forget)', async () => {
    await ks.engage('Critical failure', 6.5);

    // Redis should already be written — no setTimeout needed
    expect(mockRedis.stored).toBeTruthy();
    expect(mockRedis.stored.engaged).toBe(true);
    expect(mockRedis.stored.reason).toBe('Critical failure');
    expect(mockRedis.stored.drawdownPct).toBe(6.5);
  });

  test('engage() should propagate Redis write failure', async () => {
    const failKs = new KillSwitch({
      cacheGet: jest.fn(),
      cacheSet: jest.fn(async () => { throw new Error('Redis write failed'); }),
    });

    // engage() should throw because _persistToRedis now throws
    await expect(failKs.engage('test')).rejects.toThrow('Redis write failed');
    // But in-memory state should still be engaged (set before the write)
    expect(failKs.isEngaged()).toBe(true);
  });

  test('should restore state from Redis on loadFromRedis()', async () => {
    mockRedis.stored = {
      engaged: true,
      reason: 'Previous session crash',
      engagedAt: '2026-03-01T10:00:00.000Z',
      drawdownPct: 7.0,
    };

    await ks.loadFromRedis();

    expect(ks.isEngaged()).toBe(true);
    expect(ks.getStatus().reason).toBe('Previous session crash');
    expect(ks.getStatus().drawdownPct).toBe(7.0);
  });

  test('should not restore if Redis has no saved state', async () => {
    mockRedis.stored = null;
    await ks.loadFromRedis();

    expect(ks.isEngaged()).toBe(false);
  });

  test('should survive Redis failure on load', async () => {
    const failKs = new KillSwitch({
      cacheGet: jest.fn(async () => { throw new Error('Redis down'); }),
      cacheSet: jest.fn(),
    });

    await failKs.loadFromRedis(); // should not throw
    expect(failKs.isEngaged()).toBe(false);
  });

  // ─── Reset ────────────────────────────────────────────

  test('should reject reset without correct confirmation', async () => {
    await ks.engage('test');
    expect(await ks.reset('wrong')).toBe(false);
    expect(ks.isEngaged()).toBe(true); // still engaged
  });

  test('should accept reset with CONFIRM_RESET', async () => {
    await ks.engage('test');
    expect(await ks.reset('CONFIRM_RESET')).toBe(true);
    expect(ks.isEngaged()).toBe(false);
    expect(ks.getStatus().reason).toBeNull();
  });

  test('reset should AWAIT Redis clear', async () => {
    await ks.engage('test');
    await ks.reset('CONFIRM_RESET');

    // Redis should already be cleared — no setTimeout needed
    expect(mockRedis.stored.engaged).toBe(false);
  });

  // ─── Without Redis ────────────────────────────────────

  test('should work without Redis deps (in-memory only)', async () => {
    const standalone = new KillSwitch();
    await standalone.engage('test');
    expect(standalone.isEngaged()).toBe(true);
    await standalone.reset('CONFIRM_RESET');
    expect(standalone.isEngaged()).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════
// KILL SWITCH INTEGRITY VERIFICATION
// ═══════════════════════════════════════════════════════════

describe('KillSwitch verifyIntegrity()', () => {
  test('should PASS when both memory and Redis agree (both disengaged)', async () => {
    const ks = new KillSwitch({
      cacheGet: jest.fn(async () => null),
      cacheSet: jest.fn(),
    });

    const result = await ks.verifyIntegrity();
    expect(result.consistent).toBe(true);
    expect(result.action).toContain('match');
  });

  test('should PASS when both memory and Redis agree (both engaged)', async () => {
    const ks = new KillSwitch({
      cacheGet: jest.fn(async () => ({ engaged: true, reason: 'test' })),
      cacheSet: jest.fn(),
    });

    // Manually set memory state to match
    await ks.loadFromRedis();

    const result = await ks.verifyIntegrity();
    expect(result.consistent).toBe(true);
    expect(ks.isEngaged()).toBe(true);
  });

  test('should ENGAGE when Redis=engaged but memory=not (fail-safe)', async () => {
    const ks = new KillSwitch({
      cacheGet: jest.fn(async () => ({
        engaged: true,
        reason: 'Crash before memory restore',
        drawdownPct: 6.0,
      })),
      cacheSet: jest.fn(),
    });

    // Don't call loadFromRedis — simulates the race condition
    expect(ks.isEngaged()).toBe(false); // memory says no

    const result = await ks.verifyIntegrity();
    expect(result.consistent).toBe(false);
    expect(result.action).toContain('ENGAGED');
    expect(ks.isEngaged()).toBe(true); // now engaged (fail-safe)
  });

  test('should PERSIST when memory=engaged but Redis=not', async () => {
    const mockSet = jest.fn();
    const ks = new KillSwitch({
      cacheGet: jest.fn(async () => null), // Redis says not engaged
      cacheSet: mockSet,
    });

    // Force memory state without going through engage
    ks._engaged = true;
    ks._reason = 'Memory-only engage';

    const result = await ks.verifyIntegrity();
    expect(result.consistent).toBe(false);
    expect(result.action).toContain('PERSISTED');
    expect(mockSet).toHaveBeenCalled(); // Should have written to Redis
  });

  test('should ENGAGE when Redis is unreachable (fail-safe)', async () => {
    const ks = new KillSwitch({
      cacheGet: jest.fn(async () => { throw new Error('Connection refused'); }),
      cacheSet: jest.fn(),
    });

    const result = await ks.verifyIntegrity();
    expect(result.consistent).toBe(false);
    expect(result.action).toContain('Redis unreachable');
    expect(ks.isEngaged()).toBe(true); // fail-safe engaged
  });

  test('should skip when no Redis deps configured', async () => {
    const ks = new KillSwitch(); // no deps

    const result = await ks.verifyIntegrity();
    expect(result.consistent).toBe(true);
    expect(result.action).toContain('skipped');
  });
});

// ═══════════════════════════════════════════════════════════
// RISK MANAGER
// ═══════════════════════════════════════════════════════════

describe('RiskManager', () => {
  let rm;
  let ks;

  beforeEach(() => {
    ks = new KillSwitch();
    rm = new RiskManager({
      capital: 100000,
      killSwitch: ks,
      maxDailyLossPct: 2,
      perTradeStopLossPct: 1,
      maxPositionCount: 5,
      killSwitchDrawdownPct: 5,
    });
  });

  const validOrder = {
    symbol: 'RELIANCE',
    side: 'BUY',
    quantity: 10,
    price: 2500,
    strategy: 'EMA_CROSSOVER',
  };

  // ─── Order Approval ────────────────────────────────────

  test('should approve valid order within all limits', () => {
    const decision = rm.validateOrder(validOrder);

    expect(decision.allowed).toBe(true);
    expect(decision.reason).toBe('All risk checks passed');
    expect(decision.context).toBeDefined();
    expect(decision.context.symbol).toBe('RELIANCE');
  });

  test('validateOrder should be synchronous', () => {
    const result = rm.validateOrder(validOrder);
    expect(result).not.toBeInstanceOf(Promise);
    expect(typeof result.allowed).toBe('boolean');
  });

  // ─── Kill Switch Block ─────────────────────────────────

  test('should REJECT order when kill switch is engaged', async () => {
    await ks.engage('Manual stop');
    const decision = rm.validateOrder(validOrder);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('KILL SWITCH');
  });

  test('kill switch should be checked FIRST (before other checks)', async () => {
    // Even if daily loss is fine, kill switch should block
    await ks.engage('Emergency');
    rm.setOpenPositionCount(10); // Also exceeds max positions

    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('KILL SWITCH'); // NOT "max positions"
  });

  // ─── Daily Loss Limit ──────────────────────────────────

  test('should REJECT order when daily loss limit is breached', async () => {
    // Capital 100,000 × 2% = ₹2,000 max loss
    await rm.recordTradePnL(-1500); // trade 1 loss
    await rm.recordTradePnL(-600);  // trade 2 loss — total -2100, beyond 2000 limit

    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Daily loss limit breached');
  });

  test('should ALLOW order when daily loss is within limit', async () => {
    await rm.recordTradePnL(-500); // well within 2000 limit

    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(true);
  });

  test('positive PnL should offset losses', async () => {
    await rm.recordTradePnL(-1800); // close to limit
    await rm.recordTradePnL(1000);  // offset — net -800

    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(true);
  });

  // ─── Max Open Positions ────────────────────────────────

  test('should REJECT BUY when max positions reached', () => {
    rm.setOpenPositionCount(5); // maxPositionCount = 5

    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Max open positions');
  });

  test('should ALLOW SELL even when max positions reached', () => {
    rm.setOpenPositionCount(5);

    const sellOrder = { ...validOrder, side: 'SELL' };
    const decision = rm.validateOrder(sellOrder);
    expect(decision.allowed).toBe(true);
  });

  test('should ALLOW BUY when under max positions', () => {
    rm.setOpenPositionCount(4); // 4 < 5
    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(true);
  });

  // ─── Per-Trade Risk ────────────────────────────────────

  test('should REJECT order exceeding per-trade risk limit', () => {
    // Per-trade max = 100,000 × 1% = ₹1,000
    // This order: 100 × 2500 × 1% = ₹2,500 > ₹1,000
    const bigOrder = { ...validOrder, quantity: 100 };
    const decision = rm.validateOrder(bigOrder);

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('Per-trade risk');
  });

  test('should ALLOW order within per-trade risk limit', () => {
    // 10 × 2500 × 1% = ₹250 < ₹1,000
    const decision = rm.validateOrder(validOrder);
    expect(decision.allowed).toBe(true);
  });

  // ─── Kill Switch Auto-Engagement ───────────────────────

  test('should engage kill switch when drawdown exceeds threshold', async () => {
    // Kill switch at 5% = ₹5,000
    await rm.recordTradePnL(-2500);
    await rm.recordTradePnL(-2600); // total -5100 > 5000

    expect(ks.isEngaged()).toBe(true);
    expect(ks.getStatus().reason).toContain('Drawdown');
  });

  test('should NOT engage kill switch for manageable losses', async () => {
    await rm.recordTradePnL(-1000);
    await rm.recordTradePnL(-1000); // total -2000 < 5000

    expect(ks.isEngaged()).toBe(false);
  });

  // ─── Position Tracking ─────────────────────────────────

  test('addPosition/removePosition should update count', () => {
    rm.addPosition();
    rm.addPosition();
    expect(rm.getStatus().openPositions).toBe(2);

    rm.removePosition();
    expect(rm.getStatus().openPositions).toBe(1);
  });

  test('removePosition should not go below 0', () => {
    rm.removePosition();
    expect(rm.getStatus().openPositions).toBe(0);
  });

  // ─── Daily Reset ──────────────────────────────────────

  test('resetDaily should clear all daily state', async () => {
    await rm.recordTradePnL(-1000);
    rm.addPosition();
    rm.addPosition();
    rm.resetDaily();

    const status = rm.getStatus();
    expect(status.dailyPnL).toBe(0);
    expect(status.openPositions).toBe(0);
    expect(status.tradeCount).toBe(0);
  });

  // ─── Status ───────────────────────────────────────────

  test('getStatus should return comprehensive risk snapshot', async () => {
    await rm.recordTradePnL(-500);
    rm.addPosition();

    const status = rm.getStatus();
    expect(status.capital).toBe(100000);
    expect(status.dailyPnL).toBe(-500);
    expect(status.drawdownPct).toBeCloseTo(0.5, 1);
    expect(status.openPositions).toBe(1);
    expect(status.tradeCount).toBe(1);
    expect(status.killSwitch).toBeDefined();
    expect(status.killSwitch.engaged).toBe(false);
  });

  // ─── Context Logging ──────────────────────────────────

  test('decision context should include full order details', () => {
    const decision = rm.validateOrder(validOrder);

    expect(decision.context.symbol).toBe('RELIANCE');
    expect(decision.context.side).toBe('BUY');
    expect(decision.context.quantity).toBe(10);
    expect(decision.context.price).toBe(2500);
    expect(decision.context.strategy).toBe('EMA_CROSSOVER');
    expect(decision.context.dailyPnL).toBe(0);
    expect(decision.context.openPositions).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// POSITION SIZER (Kelly Criterion)
// ═══════════════════════════════════════════════════════════

describe('PositionSizer (Kelly Criterion)', () => {
  // ─── Basic Sizing ──────────────────────────────────────

  test('should calculate position size with valid inputs', () => {
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0.6,     // 60% win rate
      avgWin: 500,      // avg ₹500 per win
      avgLoss: 300,     // avg ₹300 per loss
      entryPrice: 2500,
    });

    expect(result.quantity).toBeGreaterThan(0);
    expect(result.riskAmount).toBeGreaterThan(0);
    expect(result.kellyPct).toBeGreaterThan(0);
    expect(result.positionValue).toBeGreaterThan(0);
    expect(typeof result.reasoning).toBe('string');
  });

  test('should return 0 quantity for negative Kelly', () => {
    // Low win rate + bad risk/reward → Kelly goes negative
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0.3,     // 30% win rate
      avgWin: 200,
      avgLoss: 500,     // lose more than win
      entryPrice: 1000,
    });

    expect(result.quantity).toBe(0);
    expect(result.reasoning).toContain('negative');
  });

  test('should use half Kelly (safety fractional)', () => {
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0.6,
      avgWin: 500,
      avgLoss: 300,
      entryPrice: 1000,
      kellyFraction: 0.5,
    });

    expect(result.reasoning).toContain('0.5×Kelly');
  });

  // ─── Caps and Guards ──────────────────────────────────

  test('should cap position at maxPositionPct of capital', () => {
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0.9,     // Very high confidence
      avgWin: 1000,
      avgLoss: 100,
      entryPrice: 100,   // cheap stock
      maxPositionPct: 20,
    });

    // Position should not exceed 20% of 100,000 = ₹20,000
    expect(result.positionValue).toBeLessThanOrEqual(20000);
  });

  test('should return 0 for invalid capital', () => {
    const result = calculatePositionSize({
      capital: 0,
      winRate: 0.6,
      avgWin: 500,
      avgLoss: 300,
      entryPrice: 1000,
    });

    expect(result.quantity).toBe(0);
    expect(result.reasoning).toContain('Invalid');
  });

  test('should return 0 for invalid entry price', () => {
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0.6,
      avgWin: 500,
      avgLoss: 300,
      entryPrice: 0,
    });

    expect(result.quantity).toBe(0);
  });

  test('should fall back to fixed fractional without history', () => {
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0,     // No history
      avgWin: 0,
      avgLoss: 0,
      entryPrice: 1000,
    });

    expect(result.quantity).toBeGreaterThan(0);
    expect(result.reasoning).toContain('fixed');
  });

  // ─── Risk Amount ──────────────────────────────────────

  test('risk amount should respect per-trade stop loss cap', () => {
    const result = calculatePositionSize({
      capital: 100000,
      winRate: 0.6,
      avgWin: 500,
      avgLoss: 300,
      entryPrice: 1000,
      maxRiskPct: 1, // 1% = ₹1,000 max
    });

    expect(result.riskAmount).toBeLessThanOrEqual(1000);
  });
});

// ═══════════════════════════════════════════════════════════
// INTEGRATION: RiskManager + KillSwitch
// ═══════════════════════════════════════════════════════════

describe('Risk Integration', () => {
  test('drawdown should auto-engage kill switch and block subsequent orders', async () => {
    const ks = new KillSwitch();
    const rm = new RiskManager({
      capital: 100000,
      killSwitch: ks,
      killSwitchDrawdownPct: 5,
    });

    // Accumulate losses to trigger kill switch
    await rm.recordTradePnL(-3000);
    await rm.recordTradePnL(-2500); // total -5500 > 5% of 100K

    expect(ks.isEngaged()).toBe(true);

    // All subsequent orders should be rejected
    const decision = rm.validateOrder({
      symbol: 'TCS',
      side: 'BUY',
      quantity: 1,
      price: 3000,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('KILL SWITCH');
  });

  test('resetting kill switch should allow trading again (after daily reset)', async () => {
    const ks = new KillSwitch();
    const rm = new RiskManager({
      capital: 100000,
      killSwitch: ks,
      killSwitchDrawdownPct: 5,
    });

    await rm.recordTradePnL(-5500);
    expect(ks.isEngaged()).toBe(true);

    await ks.reset('CONFIRM_RESET');
    rm.resetDaily();

    const decision = rm.validateOrder({
      symbol: 'TCS',
      side: 'BUY',
      quantity: 1,
      price: 3000,
    });

    expect(decision.allowed).toBe(true);
  });

  test('full startup flow: loadFromRedis → verifyIntegrity → validateOrder', async () => {
    const mockRedis = {
      stored: { engaged: true, reason: 'Previous crash', drawdownPct: 6.0 },
    };

    const ks = new KillSwitch({
      cacheGet: jest.fn(async () => mockRedis.stored),
      cacheSet: jest.fn(async (k, v) => { mockRedis.stored = v; }),
    });

    // Simulate startup sequence
    await ks.loadFromRedis();
    const integrity = await ks.verifyIntegrity();

    expect(integrity.consistent).toBe(true);
    expect(ks.isEngaged()).toBe(true);

    const rm = new RiskManager({ capital: 100000, killSwitch: ks });
    const decision = rm.validateOrder({
      symbol: 'TCS', side: 'BUY', quantity: 1, price: 3000,
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('KILL SWITCH');
  });
});
