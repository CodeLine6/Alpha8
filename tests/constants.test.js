/**
 * Constants tests — verify market config values.
 */

import { describe, test, expect } from '@jest/globals';
import {
  TIMEZONE,
  MARKET_OPEN,
  MARKET_CLOSE,
  SQUARE_OFF_TIME,
  ORDER_STATE,
  SIGNAL,
  ORDER_TYPE,
  STRATEGY,
  MARKET_HOLIDAYS_2026,
} from '../src/config/constants.js';

describe('Constants', () => {
  test('TIMEZONE should be Asia/Kolkata', () => {
    expect(TIMEZONE).toBe('Asia/Kolkata');
  });

  test('Market hours should be IST times', () => {
    expect(MARKET_OPEN).toBe('09:15');
    expect(MARKET_CLOSE).toBe('15:30');
    expect(SQUARE_OFF_TIME).toBe('15:15');
  });

  test('ORDER_STATE should be frozen with correct values', () => {
    expect(Object.isFrozen(ORDER_STATE)).toBe(true);
    expect(ORDER_STATE.PENDING).toBe('PENDING');
    expect(ORDER_STATE.FILLED).toBe('FILLED');
  });

  test('SIGNAL should have BUY, SELL, HOLD', () => {
    expect(SIGNAL.BUY).toBe('BUY');
    expect(SIGNAL.SELL).toBe('SELL');
    expect(SIGNAL.HOLD).toBe('HOLD');
  });

  test('All strategies should be defined (6 total: 4 legacy + ORB + BAVI)', () => {
    expect(Object.keys(STRATEGY)).toHaveLength(6);
    // Legacy (retained — files not deleted)
    expect(STRATEGY.EMA_CROSSOVER).toBeDefined();
    expect(STRATEGY.RSI_MEAN_REVERSION).toBeDefined();
    // Unchanged active
    expect(STRATEGY.VWAP_MOMENTUM).toBeDefined();
    expect(STRATEGY.BREAKOUT_VOLUME).toBeDefined();
    // New active strategies (v1.1)
    expect(STRATEGY.ORB).toBeDefined();
    expect(STRATEGY.BAVI).toBeDefined();
  });

  test('Market holidays should be an array of date strings', () => {
    expect(Array.isArray(MARKET_HOLIDAYS_2026)).toBe(true);
    expect(MARKET_HOLIDAYS_2026.length).toBeGreaterThan(10);
    // Each entry should be YYYY-MM-DD format
    MARKET_HOLIDAYS_2026.forEach((date) => {
      expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
