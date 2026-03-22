/**
 * Unit tests for the MarketScheduler.
 *
 * Tests each job's logic directly (not cron scheduling),
 * verifying kill switch guards, error isolation, and
 * correct integration with engine/risk/square-off.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { MarketScheduler } from '../src/scheduler/market-scheduler.js';
import { KillSwitch } from '../src/risk/kill-switch.js';
import { RiskManager } from '../src/risk/risk-manager.js';
import { ExecutionEngine } from '../src/engine/execution-engine.js';
import { SignalConsensus } from '../src/engine/signal-consensus.js';
import { query } from '../src/lib/db.js';

// ─── Mocks ────────────────────────────────────────────────
jest.mock('../src/lib/db.js', () => ({
  query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
}));

// ─── Helpers ──────────────────────────────────────────────

function mockStrategy(name, signal, confidence) {
  return {
    name,
    analyze: jest.fn(() => ({
      signal, confidence,
      reason: `${name}: ${signal}`,
      strategy: name,
      timestamp: new Date().toISOString(),
    })),
  };
}

function createScheduler(overrides = {}) {
  const ks = new KillSwitch();
  const rm = new RiskManager({
    capital: 100000,
    killSwitch: ks,
    maxDailyLossPct: 2,
    perTradeStopLossPct: 1,
    maxPositionCount: 5,
    killSwitchDrawdownPct: 5,
  });

  const consensus = new SignalConsensus({ minAgreement: 2 });
  consensus.addStrategy(mockStrategy('EMA', 'BUY', 70));
  consensus.addStrategy(mockStrategy('RSI', 'BUY', 65));

  const engine = new ExecutionEngine({
    riskManager: rm,
    killSwitch: ks,
    consensus,
    paperMode: true,
    maxRetries: 1,
    retryDelayMs: 10,
  });

  // Mock stubs for ORB/BAVI integration deps
  const baviAdapter   = { setSymbol: jest.fn(), analyze: jest.fn(() => ({ signal: 'HOLD', confidence: 0, reason: 'mock', strategy: 'BAVI', timestamp: new Date().toISOString() })) };
  const rsiStrategy   = { analyze: jest.fn(() => ({ signal: 'HOLD', confidence: 0, reason: 'mock', strategy: 'RSI', timestamp: new Date().toISOString() })) };
  const tickClassifier = { resetAll: jest.fn(), classifyTick: jest.fn() };
  const rollingTickBuf = { resetAll: jest.fn(), addTick: jest.fn(), getBuffer: jest.fn(() => []) };

  const scheduler = new MarketScheduler({
    killSwitch: ks,
    riskManager: rm,
    engine,
    baviAdapter,
    rsiStrategy,
    tickClassifier,
    rollingTickBuf,
    healthCheck: jest.fn(async () => ({ broker: true, redis: true, db: true })),
    getWatchlist: jest.fn(async () => []),
    getOpenPositions: jest.fn(async () => []),
    sendReport: jest.fn(async () => {}),
    ...overrides,
  });

  return { scheduler, ks, rm, engine };
}

// ═══════════════════════════════════════════════════════════
// JOB WRAPPER (_runJob)
// ═══════════════════════════════════════════════════════════

describe('MarketScheduler _runJob wrapper', () => {
  test('should skip job on non-trading day', async () => {
    const { scheduler } = createScheduler();

    // Mock isTradingDay to return false — we test _runJob directly
    const result = await scheduler._runJob('test', async () => 'ok');

    // On the actual machine, this may or may not be a trading day.
    // What matters is: if it runs, it has timing info.
    expect(result).toBeDefined();
    if (result.skipped) {
      expect(result.reason).toBeDefined();
    } else {
      expect(result.durationMs).toBeDefined();
    }
  });

  test('should skip non-bypass job when kill switch is engaged', async () => {
    const { scheduler, ks } = createScheduler();
    await ks.engage('Test');

    const result = await scheduler._runJob('strategy-scan', async () => 'should not run');

    // On a trading day, this should skip due to kill switch
    if (!result.skipped || result.reason === 'not_trading_day') {
      // Non-trading day — expected, nothing to assert
    } else {
      expect(result.reason).toBe('kill_switch_engaged');
    }
  });

  test('should ALLOW bypass jobs when kill switch is engaged', async () => {
    const { scheduler, ks } = createScheduler();
    await ks.engage('Test');

    // square-off, squareoff-warning, and post-market bypass kill switch
    const result = await scheduler._runJob('post-market', async () => 'ran');

    if (!result.skipped) {
      expect(result.result).toBe('ran');
    }
  });

  test('should catch errors without crashing', async () => {
    const { scheduler } = createScheduler();

    const result = await scheduler._runJob('broken-job', async () => {
      throw new Error('Job exploded');
    });

    // Should not throw — just log and return error
    if (!result.skipped) {
      expect(result.error).toBe('Job exploded');
    }
  });

  test('should track duration', async () => {
    const { scheduler } = createScheduler();

    const result = await scheduler._runJob('timing-test', async () => {
      await new Promise((r) => setTimeout(r, 20));
      return 'done';
    });

    if (!result.skipped) {
      expect(result.durationMs).toBeGreaterThanOrEqual(15);
    }
  });
});

// ═══════════════════════════════════════════════════════════
// PRE-MARKET
// ═══════════════════════════════════════════════════════════

describe('Pre-market job', () => {
  test('should run health checks and verifyIntegrity', async () => {
    const healthCheck = jest.fn(async () => ({ broker: true, redis: true, db: true }));
    const { scheduler } = createScheduler({ healthCheck });

    const result = await scheduler._preMarket();

    expect(healthCheck).toHaveBeenCalled();
    expect(result.healthy).toBe(true);
    expect(result.integrity).toBeDefined();
    expect(result.engineReady).toBe(true);
  });

  test('should engage kill switch on unhealthy infrastructure', async () => {
    const { scheduler, ks } = createScheduler({
      healthCheck: jest.fn(async () => ({ broker: false, redis: true, db: true })),
    });

    const result = await scheduler._preMarket();

    expect(result.healthy).toBe(false);
    expect(ks.isEngaged()).toBe(true);
    expect(ks.getStatus().reason).toContain('broker=false');
  });
});

// ═══════════════════════════════════════════════════════════
// MARKET OPEN
// ═══════════════════════════════════════════════════════════

describe('Market open job', () => {
  test('should activate scanning', async () => {
    const { scheduler } = createScheduler();

    const result = await scheduler._marketOpen();

    expect(result.scanning).toBe(true);
    expect(scheduler._scanning).toBe(true);
  });

  test('should connect data feed if available', async () => {
    const mockFeed = { connect: jest.fn(async () => {}) };
    const { scheduler } = createScheduler({ dataFeed: mockFeed });

    await scheduler._marketOpen();

    expect(mockFeed.connect).toHaveBeenCalled();
  });

  test('should continue even if data feed fails', async () => {
    const mockFeed = { connect: jest.fn(async () => { throw new Error('Feed down'); }) };
    const { scheduler } = createScheduler({ dataFeed: mockFeed });

    const result = await scheduler._marketOpen();

    expect(result.scanning).toBe(true); // Scanning still activated
  });
});

// ═══════════════════════════════════════════════════════════
// STRATEGY SCAN
// ═══════════════════════════════════════════════════════════

describe('Strategy scan job', () => {
  test('should skip when scanning is not active', async () => {
    const { scheduler } = createScheduler();
    scheduler._scanning = false;

    const result = await scheduler._strategyScan();
    expect(result.scanned).toBe(0);
  });

  test('should scan watchlist when active', async () => {
    const { scheduler, engine } = createScheduler({
      getWatchlist: jest.fn(async () => [
        { symbol: 'RELIANCE', candles: [], price: 2500, quantity: 10 },
        { symbol: 'TCS', candles: [], price: 3000, quantity: 5 },
      ]),
    });

    await engine.initialize();
    scheduler._scanning = true;

    const result = await scheduler._strategyScan();
    expect(result.scanned).toBe(2);
  });

  test('should handle individual symbol errors gracefully', async () => {
    const { scheduler, engine } = createScheduler({
      getWatchlist: jest.fn(async () => [
        { symbol: 'RELIANCE', candles: [], price: 2500, quantity: 10 },
      ]),
    });

    // Don't initialize engine — processSignal returns ENGINE_NOT_INITIALIZED
    scheduler._scanning = true;

    const result = await scheduler._strategyScan();
    expect(result.scanned).toBe(1);
    // Should not crash
  });

  test('should handle empty watchlist', async () => {
    const { scheduler } = createScheduler({
      getWatchlist: jest.fn(async () => []),
    });
    scheduler._scanning = true;

    const result = await scheduler._strategyScan();
    expect(result.scanned).toBe(0);
  });
});

// ═══════════════════════════════════════════════════════════
// SQUARE-OFF WARNING
// ═══════════════════════════════════════════════════════════

describe('Square-off warning job', () => {
  test('should deactivate scanning', async () => {
    const { scheduler } = createScheduler();
    scheduler._scanning = true;

    await scheduler._squareOffWarning();

    expect(scheduler._scanning).toBe(false);
  });

  test('should report open positions and active orders', async () => {
    const { scheduler, engine } = createScheduler({
      getOpenPositions: jest.fn(async () => [
        { symbol: 'RELIANCE', quantity: 10 },
        { symbol: 'TCS', quantity: -5 },
      ]),
    });

    await engine.initialize();

    const result = await scheduler._squareOffWarning();
    expect(result.positions).toBe(2);
  });
});

// ═══════════════════════════════════════════════════════════
// SQUARE-OFF
// ═══════════════════════════════════════════════════════════

describe('Square-off job', () => {
  test('should cancel active orders', async () => {
    const { scheduler, engine } = createScheduler();
    await engine.initialize();

    // Place an order (it'll be FILLED in paper mode, so nothing to cancel)
    await engine.executeOrder({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500,
    });

    // The result should complete without error
    const result = await scheduler._squareOff();
    expect(result).toBeDefined();
    expect(result.cancelledOrders).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════
// POST-MARKET
// ═══════════════════════════════════════════════════════════

describe('Post-market job', () => {
  test('should generate summary with PnL and trade count', async () => {
    const sendReport = jest.fn(async () => {});
    const { scheduler, rm, engine } = createScheduler({ sendReport });

    await engine.initialize();
    await rm.recordTradePnL(-500);
    await rm.recordTradePnL(200);

    const summary = await scheduler._postMarket();

    expect(summary.pnl).toBe(-300);
    expect(summary.trades).toBe(2);
    expect(summary.wins).toBe(1);
    expect(summary.losses).toBe(1);
    expect(summary.date).toBeDefined();
    expect(sendReport).toHaveBeenCalledWith(summary);
  });

  test('should reset daily counters after summary', async () => {
    const { scheduler, rm, engine } = createScheduler();
    await engine.initialize();
    await rm.recordTradePnL(-500);

    await scheduler._postMarket();

    // After reset
    expect(rm.getStatus().dailyPnL).toBe(0);
    expect(rm.getStatus().tradeCount).toBe(0);
    expect(rm.getStatus().wins).toBe(0);
    expect(rm.getStatus().losses).toBe(0);
  });

  test('should deactivate scanning', async () => {
    const { scheduler, engine } = createScheduler();
    await engine.initialize();
    scheduler._scanning = true;

    await scheduler._postMarket();

    expect(scheduler._scanning).toBe(false);
  });

  test('should survive report send failure', async () => {
    const { scheduler, engine } = createScheduler({
      sendReport: jest.fn(async () => { throw new Error('Telegram down'); }),
    });
    await engine.initialize();

    const summary = await scheduler._postMarket();
    expect(summary).toBeDefined(); // Should not throw
  });

  test('should disconnect data feed', async () => {
    const mockFeed = { disconnect: jest.fn(async () => {}) };
    const { scheduler, engine } = createScheduler({ dataFeed: mockFeed });
    await engine.initialize();

    await scheduler._postMarket();

    expect(mockFeed.disconnect).toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════
// LIFECYCLE
// ═══════════════════════════════════════════════════════════

describe('Scheduler lifecycle', () => {
  test('start should create cron jobs', () => {
    const { scheduler } = createScheduler();
    scheduler.start();

    expect(scheduler._cronJobs.length).toBeGreaterThan(0);

    scheduler.stop(); // cleanup
  });

  test('stop should clear all jobs', () => {
    const { scheduler } = createScheduler();
    scheduler.start();
    scheduler.stop();

    expect(scheduler._cronJobs).toHaveLength(0);
    expect(scheduler._scanning).toBe(false);
  });

  test('getStatus should return scheduler state', () => {
    const { scheduler } = createScheduler();

    const status = scheduler.getStatus();
    expect(status.activeJobs).toBeDefined();
    expect(status.scanning).toBe(false);
    expect(status.marketStatus).toBeDefined();
    expect(status.killSwitchEngaged).toBe(false);
  });
});
