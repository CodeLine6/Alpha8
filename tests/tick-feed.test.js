/**
 * Unit tests for TickFeed — WebSocket tick feed.
 * Tests event emission, OHLCV aggregation, and subscription management.
 * (WebSocket connection itself is not tested — that would be integration.)
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { TickFeed } from '../src/data/tick-feed.js';

describe('TickFeed', () => {
  let feed;

  beforeEach(() => {
    feed = new TickFeed({
      apiKey: 'test_key',
      accessToken: 'test_token',
      respectMarketHours: false, // Don't gate on market hours in tests
      ohlcvIntervalMs: 100,
      symbolMap: {
        738561: 'RELIANCE',
        256265: 'TCS',
      },
    });
  });

  afterEach(() => {
    feed.stop();
  });

  // ─── Subscription ─────────────────────────────────────

  test('should subscribe to instrument tokens', () => {
    feed.subscribe([738561, 256265]);
    expect(feed.subscribedTokens).toEqual([738561, 256265]);
  });

  test('should deduplicate subscribed tokens', () => {
    feed.subscribe([738561]);
    feed.subscribe([738561, 256265]);
    expect(feed.subscribedTokens).toEqual([738561, 256265]);
  });

  test('should unsubscribe tokens', () => {
    feed.subscribe([738561, 256265]);
    feed.unsubscribe([738561]);
    expect(feed.subscribedTokens).toEqual([256265]);
  });

  // ─── OHLCV Buffer Update ──────────────────────────────

  test('should update OHLCV buffer on tick', () => {
    const tick = {
      symbol: 'RELIANCE',
      ltp: 2500,
      volume: 100000,
    };

    feed._updateOHLCVBuffer(738561, tick);
    const buffer = feed._ohlcvBuffers.get(738561);

    expect(buffer).toBeDefined();
    expect(buffer.open).toBe(2500);
    expect(buffer.high).toBe(2500);
    expect(buffer.low).toBe(2500);
    expect(buffer.close).toBe(2500);
    expect(buffer.tickCount).toBe(1);
  });

  test('should track high/low correctly across multiple ticks', () => {
    feed._updateOHLCVBuffer(738561, { symbol: 'REL', ltp: 100, volume: 0 });
    feed._updateOHLCVBuffer(738561, { symbol: 'REL', ltp: 120, volume: 0 });
    feed._updateOHLCVBuffer(738561, { symbol: 'REL', ltp: 90, volume: 0 });
    feed._updateOHLCVBuffer(738561, { symbol: 'REL', ltp: 110, volume: 0 });

    const buffer = feed._ohlcvBuffers.get(738561);
    expect(buffer.open).toBe(100);
    expect(buffer.high).toBe(120);
    expect(buffer.low).toBe(90);
    expect(buffer.close).toBe(110);
    expect(buffer.tickCount).toBe(4);
  });

  // ─── OHLCV Aggregation Emission ───────────────────────

  test('should emit ohlcv events periodically', async () => {
    feed._updateOHLCVBuffer(738561, { symbol: 'REL', ltp: 100, volume: 500 });
    feed._updateOHLCVBuffer(738561, { symbol: 'REL', ltp: 110, volume: 800 });

    const ohlcvPromise = new Promise((resolve) => {
      feed.on('ohlcv', (candle) => resolve(candle));
    });

    feed._startOHLCVAggregation();

    const candle = await ohlcvPromise;
    expect(candle.instrumentToken).toBe(738561);
    expect(candle.open).toBe(100);
    expect(candle.high).toBe(110);
    expect(candle.close).toBe(110);
    expect(candle.timestamp).toBeDefined();
  });

  // ─── Latest Ticks ─────────────────────────────────────

  test('should store and retrieve latest ticks', () => {
    const tick = {
      instrumentToken: 738561,
      symbol: 'RELIANCE',
      ltp: 2500,
      volume: 100000,
    };

    feed.latestTicks.set(738561, tick);
    expect(feed.getLatestTick(738561)).toEqual(tick);
    expect(feed.getLatestTick(999999)).toBeNull();
  });

  // ─── Status ───────────────────────────────────────────

  test('should report correct status', () => {
    feed.subscribe([738561, 256265]);
    const status = feed.getStatus();

    expect(status.isConnected).toBe(false); // Not actually connected
    expect(status.subscribedTokens).toBe(2);
    expect(status.reconnectAttempts).toBe(0);
  });

  // ─── EventEmitter ─────────────────────────────────────

  test('should be an EventEmitter', () => {
    expect(typeof feed.on).toBe('function');
    expect(typeof feed.emit).toBe('function');
    expect(typeof feed.removeListener).toBe('function');
  });
});
