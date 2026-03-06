/**
 * Unit tests for historical data module.
 * Tests candle normalization and data flow (broker calls are mocked).
 */

import { describe, test, expect } from '@jest/globals';
import { normalizeKiteCandles } from '../src/data/historical-data.js';

describe('Historical Data', () => {
  // ─── Kite Candle Normalization ────────────────────────

  describe('normalizeKiteCandles', () => {
    test('should normalize array-format candles (Kite raw)', () => {
      const raw = {
        candles: [
          ['2026-03-04T09:15:00+0530', 2500.0, 2520.0, 2495.0, 2510.0, 150000],
          ['2026-03-04T09:20:00+0530', 2510.0, 2530.0, 2505.0, 2525.0, 120000],
        ],
      };

      const candles = normalizeKiteCandles(raw);

      expect(candles).toHaveLength(2);
      expect(candles[0]).toEqual({
        timestamp: '2026-03-04T09:15:00+0530',
        open: 2500.0,
        high: 2520.0,
        low: 2495.0,
        close: 2510.0,
        volume: 150000,
      });
    });

    test('should normalize object-format candles', () => {
      const raw = [
        { date: '2026-03-04', open: 100, high: 110, low: 95, close: 105, volume: 5000 },
      ];

      const candles = normalizeKiteCandles(raw);

      expect(candles).toHaveLength(1);
      expect(candles[0].timestamp).toBe('2026-03-04');
      expect(candles[0].open).toBe(100);
      expect(candles[0].close).toBe(105);
    });

    test('should handle nested data.candles format', () => {
      const raw = {
        data: {
          candles: [
            ['2026-03-04T09:15:00+0530', 100, 110, 90, 105, 1000],
          ],
        },
      };

      const candles = normalizeKiteCandles(raw);
      expect(candles).toHaveLength(1);
      expect(candles[0].open).toBe(100);
    });

    test('should return empty array for invalid input', () => {
      expect(normalizeKiteCandles(null)).toEqual([]);
      expect(normalizeKiteCandles(undefined)).toEqual([]);
      expect(normalizeKiteCandles('invalid')).toEqual([]);
    });

    test('should handle missing volume in array format', () => {
      const raw = { candles: [['2026-03-04', 100, 110, 90, 105]] };
      const candles = normalizeKiteCandles(raw);

      expect(candles[0].volume).toBe(0);
    });

    test('should handle missing volume in object format', () => {
      const raw = [{ date: '2026-03-04', open: 100, high: 110, low: 90, close: 105 }];
      const candles = normalizeKiteCandles(raw);

      expect(candles[0].volume).toBe(0);
    });
  });
});
