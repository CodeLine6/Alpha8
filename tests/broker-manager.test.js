/**
 * Unit tests for BrokerManager — unified broker abstraction with failover.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { BrokerManager } from '../src/api/broker-manager.js';

/** Create a mock broker with controllable responses */
function createMockBroker(name, overrides = {}) {
  return {
    name,
    placeOrder: overrides.placeOrder || jest.fn(async () => ({ order_id: `${name}-ORD-001` })),
    cancelOrder: overrides.cancelOrder || jest.fn(async () => ({ status: 'cancelled' })),
    getOrders: overrides.getOrders || jest.fn(async () => [{ id: 1 }, { id: 2 }]),
    getPositions: overrides.getPositions || jest.fn(async () => ({ day: [], net: [] })),
    getHoldings: overrides.getHoldings || jest.fn(async () => []),
    getLTP: overrides.getLTP || jest.fn(async () => ({ 'NSE:RELIANCE': { last_price: 2500 } })),
    getQuote: overrides.getQuote || jest.fn(async () => ({})),
    getMargins: overrides.getMargins || jest.fn(async () => ({ equity: { available: 100000 } })),
    getCircuitStatus: jest.fn(() => ({ state: 'CLOSED', failureCount: 0, totalTrips: 0 })),
  };
}

describe('BrokerManager', () => {
  let primaryBroker;
  let fallbackBroker;
  let manager;

  beforeEach(() => {
    primaryBroker = createMockBroker('kite');
    fallbackBroker = createMockBroker('angel');
    manager = new BrokerManager(primaryBroker, fallbackBroker);
  });

  // ─── Normal Operation ─────────────────────────────────

  test('should route placeOrder to primary broker and return normalized response', async () => {
    const result = await manager.placeOrder({
      symbol: 'RELIANCE',
      exchange: 'NSE',
      side: 'BUY',
      quantity: 10,
      orderType: 'MARKET',
    });

    expect(result.broker).toBe('kite');
    expect(result.orderId).toBe('kite-ORD-001');
    expect(result.status).toBe('PLACED');
    expect(result.timestamp).toBeDefined();
    expect(result.symbol).toBe('RELIANCE');
    expect(result.side).toBe('BUY');
    expect(result.quantity).toBe(10);
    expect(result.raw).toBeDefined();
    expect(primaryBroker.placeOrder).toHaveBeenCalledTimes(1);
    expect(fallbackBroker.placeOrder).not.toHaveBeenCalled();
  });

  test('should route getOrders to primary broker', async () => {
    const orders = await manager.getOrders();
    expect(orders).toEqual([{ id: 1 }, { id: 2 }]);
    expect(primaryBroker.getOrders).toHaveBeenCalledTimes(1);
  });

  test('should route getPositions to primary broker', async () => {
    await manager.getPositions();
    expect(primaryBroker.getPositions).toHaveBeenCalledTimes(1);
  });

  test('should route getHoldings to primary broker', async () => {
    await manager.getHoldings();
    expect(primaryBroker.getHoldings).toHaveBeenCalledTimes(1);
  });

  test('should route getMargins to primary broker', async () => {
    await manager.getMargins();
    expect(primaryBroker.getMargins).toHaveBeenCalledTimes(1);
  });

  test('should route cancelOrder to primary broker', async () => {
    await manager.cancelOrder('ORD-123');
    expect(primaryBroker.cancelOrder).toHaveBeenCalledWith('ORD-123');
  });

  // ─── Fallback Behavior ────────────────────────────────

  test('should fallback to secondary when primary fails', async () => {
    primaryBroker.placeOrder = jest.fn(async () => { throw new Error('Kite API down'); });

    const result = await manager.placeOrder({
      symbol: 'TCS',
      exchange: 'NSE',
      side: 'BUY',
      quantity: 5,
    });

    expect(result.broker).toBe('angel');
    expect(result.orderId).toBe('angel-ORD-001');
    expect(manager.activeBroker).toBe('fallback');
  });

  test('should throw when both brokers fail', async () => {
    primaryBroker.placeOrder = jest.fn(async () => { throw new Error('Kite down'); });
    fallbackBroker.placeOrder = jest.fn(async () => { throw new Error('Angel down'); });

    await expect(
      manager.placeOrder({ symbol: 'INFY', side: 'BUY', quantity: 1 })
    ).rejects.toThrow(/Both brokers failed/);
  });

  test('should switch back to primary after it recovers', async () => {
    // First call fails on primary, falls back
    let callCount = 0;
    primaryBroker.getOrders = jest.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error('temporary failure');
      return [{ id: 1 }];
    });

    await manager.getOrders(); // Fails, falls back
    expect(manager.activeBroker).toBe('fallback');

    // Second call should try primary again and succeed
    const result = await manager.getOrders();
    expect(result).toEqual([{ id: 1 }]);
    expect(manager.activeBroker).toBe('primary');
  });

  // ─── No Fallback Configured ───────────────────────────

  test('should throw directly when primary fails with no fallback', async () => {
    const noFallbackManager = new BrokerManager(primaryBroker);
    primaryBroker.getOrders = jest.fn(async () => { throw new Error('fail'); });

    await expect(noFallbackManager.getOrders()).rejects.toThrow('fail');
  });

  // ─── Status Reporting ─────────────────────────────────

  test('should report combined status', () => {
    const status = manager.getStatus();

    expect(status.activeBroker).toBe('primary');
    expect(status.primary).toEqual({ state: 'CLOSED', failureCount: 0, totalTrips: 0 });
    expect(status.fallback).toEqual({ state: 'CLOSED', failureCount: 0, totalTrips: 0 });
  });

  test('should report null fallback when none configured', () => {
    const noFallback = new BrokerManager(primaryBroker);
    const status = noFallback.getStatus();
    expect(status.fallback).toBeNull();
  });

  // ─── Market Data ──────────────────────────────────────

  test('should pass through getLTP calls', async () => {
    const result = await manager.getLTP(['NSE:RELIANCE']);
    expect(result).toEqual({ 'NSE:RELIANCE': { last_price: 2500 } });
    expect(primaryBroker.getLTP).toHaveBeenCalledWith(['NSE:RELIANCE']);
  });

  test('should pass through getQuote calls', async () => {
    await manager.getQuote(['NSE:TCS']);
    expect(primaryBroker.getQuote).toHaveBeenCalledWith(['NSE:TCS']);
  });
});
