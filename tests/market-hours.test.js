/**
 * Unit tests for market hours utility.
 * Uses date injection to test different market states deterministically.
 */

import { describe, test, expect } from '@jest/globals';
import {
  getISTTime,
  isMarketOpen,
  isMarketHoliday,
  isWeekend,
  isTradingDay,
  isPreMarket,
  isSquareOffTime,
  minutesUntilOpen,
  minutesUntilClose,
  getMarketStatus,
} from '../src/data/market-hours.js';

// Helper: create a Date object from an IST time string
// We build a UTC date that corresponds to the desired IST time
function istDate(dateStr, timeStr) {
  // IST is UTC+5:30
  const [year, month, day] = dateStr.split('-').map(Number);
  const [hours, minutes] = timeStr.split(':').map(Number);
  // Create in IST by subtracting 5:30 to get UTC
  const utc = new Date(Date.UTC(year, month - 1, day, hours - 5, minutes - 30));
  return utc;
}

describe('Market Hours', () => {
  // ─── IST Time Parsing ─────────────────────────────────

  describe('getISTTime', () => {
    test('should return correct IST components', () => {
      // Wednesday, March 4, 2026, 10:30 IST
      const date = istDate('2026-03-04', '10:30');
      const ist = getISTTime(date);

      expect(ist.hours).toBe(10);
      expect(ist.minutes).toBe(30);
      expect(ist.day).toBe(3); // Wednesday
      expect(ist.dateStr).toBe('2026-03-04');
      expect(ist.timeStr).toBe('10:30');
    });
  });

  // ─── Weekend Detection ────────────────────────────────

  describe('isWeekend', () => {
    test('should return true for Saturday', () => {
      const sat = istDate('2026-03-07', '10:00'); // Saturday
      expect(isWeekend(sat)).toBe(true);
    });

    test('should return true for Sunday', () => {
      const sun = istDate('2026-03-08', '10:00'); // Sunday
      expect(isWeekend(sun)).toBe(true);
    });

    test('should return false for Wednesday', () => {
      const wed = istDate('2026-03-04', '10:00'); // Wednesday
      expect(isWeekend(wed)).toBe(false);
    });
  });

  // ─── Holiday Detection ────────────────────────────────

  describe('isMarketHoliday', () => {
    test('should return true for Republic Day', () => {
      const republicDay = istDate('2026-01-26', '10:00');
      expect(isMarketHoliday(republicDay)).toBe(true);
    });

    test('should return true for Independence Day', () => {
      const independenceDay = istDate('2026-08-15', '10:00');
      expect(isMarketHoliday(independenceDay)).toBe(true);
    });

    test('should return false for a regular trading day', () => {
      const normal = istDate('2026-03-04', '10:00');
      expect(isMarketHoliday(normal)).toBe(false);
    });
  });

  // ─── Trading Day ──────────────────────────────────────

  describe('isTradingDay', () => {
    test('should return true for regular weekday', () => {
      expect(isTradingDay(istDate('2026-03-04', '10:00'))).toBe(true);
    });

    test('should return false for weekend', () => {
      expect(isTradingDay(istDate('2026-03-07', '10:00'))).toBe(false);
    });

    test('should return false for holiday', () => {
      expect(isTradingDay(istDate('2026-01-26', '10:00'))).toBe(false);
    });
  });

  // ─── Market Open ──────────────────────────────────────

  describe('isMarketOpen', () => {
    test('should return true during market hours (10:00 AM)', () => {
      expect(isMarketOpen(istDate('2026-03-04', '10:00'))).toBe(true);
    });

    test('should return true at market open (9:15 AM)', () => {
      expect(isMarketOpen(istDate('2026-03-04', '09:15'))).toBe(true);
    });

    test('should return false before market open (9:14 AM)', () => {
      expect(isMarketOpen(istDate('2026-03-04', '09:14'))).toBe(false);
    });

    test('should return false at market close (3:30 PM)', () => {
      expect(isMarketOpen(istDate('2026-03-04', '15:30'))).toBe(false);
    });

    test('should return false on weekend', () => {
      expect(isMarketOpen(istDate('2026-03-07', '10:00'))).toBe(false);
    });

    test('should return false on holiday', () => {
      expect(isMarketOpen(istDate('2026-01-26', '10:00'))).toBe(false);
    });
  });

  // ─── Pre-Market ───────────────────────────────────────

  describe('isPreMarket', () => {
    test('should return true during pre-market (9:00 - 9:15)', () => {
      expect(isPreMarket(istDate('2026-03-04', '09:05'))).toBe(true);
    });

    test('should return false before pre-market (8:59)', () => {
      expect(isPreMarket(istDate('2026-03-04', '08:59'))).toBe(false);
    });

    test('should return false at market open (9:15)', () => {
      expect(isPreMarket(istDate('2026-03-04', '09:15'))).toBe(false);
    });
  });

  // ─── Square-Off Time ──────────────────────────────────

  describe('isSquareOffTime', () => {
    test('should return true at 3:15 PM', () => {
      expect(isSquareOffTime(istDate('2026-03-04', '15:15'))).toBe(true);
    });

    test('should return true at 3:20 PM', () => {
      expect(isSquareOffTime(istDate('2026-03-04', '15:20'))).toBe(true);
    });

    test('should return false before 3:15 PM', () => {
      expect(isSquareOffTime(istDate('2026-03-04', '15:14'))).toBe(false);
    });

    test('should return false at/after 3:30 PM', () => {
      expect(isSquareOffTime(istDate('2026-03-04', '15:30'))).toBe(false);
    });
  });

  // ─── Minutes Until Open/Close ─────────────────────────

  describe('minutesUntilOpen', () => {
    test('should return positive value before market open', () => {
      const mins = minutesUntilOpen(istDate('2026-03-04', '08:00'));
      expect(mins).toBe(75); // 9:15 - 8:00 = 75 minutes
    });

    test('should return 0 at market open', () => {
      expect(minutesUntilOpen(istDate('2026-03-04', '09:15'))).toBe(0);
    });

    test('should return negative after market open', () => {
      expect(minutesUntilOpen(istDate('2026-03-04', '10:00'))).toBeLessThan(0);
    });
  });

  describe('minutesUntilClose', () => {
    test('should return correct minutes during trading', () => {
      const mins = minutesUntilClose(istDate('2026-03-04', '14:00'));
      expect(mins).toBe(90); // 15:30 - 14:00 = 90 minutes
    });
  });

  // ─── Market Status ────────────────────────────────────

  describe('getMarketStatus', () => {
    test('should return OPEN during trading hours', () => {
      const status = getMarketStatus(istDate('2026-03-04', '10:00'));
      expect(status.status).toBe('OPEN');
      expect(status.isOpen).toBe(true);
      expect(status.isTradingDay).toBe(true);
    });

    test('should return WEEKEND on Saturday', () => {
      const status = getMarketStatus(istDate('2026-03-07', '10:00'));
      expect(status.status).toBe('WEEKEND');
      expect(status.isOpen).toBe(false);
    });

    test('should return HOLIDAY on market holiday', () => {
      const status = getMarketStatus(istDate('2026-01-26', '10:00'));
      expect(status.status).toBe('HOLIDAY');
    });

    test('should return PRE_MARKET during pre-market session', () => {
      const status = getMarketStatus(istDate('2026-03-04', '09:05'));
      expect(status.status).toBe('PRE_MARKET');
      expect(status.isPreMarket).toBe(true);
    });

    test('should return SQUARE_OFF during square-off window', () => {
      const status = getMarketStatus(istDate('2026-03-04', '15:20'));
      expect(status.status).toBe('SQUARE_OFF');
      expect(status.isSquareOff).toBe(true);
    });

    test('should return CLOSED when market is closed (after hours)', () => {
      const status = getMarketStatus(istDate('2026-03-04', '17:00'));
      expect(status.status).toBe('CLOSED');
      expect(status.isOpen).toBe(false);
    });
  });
});
