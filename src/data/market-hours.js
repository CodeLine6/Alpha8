import {
  TIMEZONE,
  MARKET_OPEN,
  MARKET_CLOSE,
  SQUARE_OFF_TIME,
  PRE_MARKET_OPEN,
  MARKET_HOLIDAYS_2026,
} from '../config/constants.js';
import { createLogger } from '../lib/logger.js';

const log = createLogger('market-hours');

/**
 * Returns true when Alpha8 is running against the local simulator
 * (SIM_URL env var is set). Used to bypass market-hours guards
 * so strategies run freely on weekends.
 * @returns {boolean}
 */
export function isSimMode() {
  return !!process.env.SIM_URL;
}

/**
 * Market hours and holiday utility for NSE/BSE.
 *
 * All time checks are performed in IST (Asia/Kolkata) regardless of
 * the server's system timezone.
 *
 * @module market-hours
 */

/**
 * Get current date/time in IST.
 * @param {Date} [now] - Override for testing; defaults to current time
 * @returns {{ hours: number, minutes: number, day: number, dateStr: string, timeStr: string }}
 */
export function getISTTime(now = new Date()) {
  const istStr = now.toLocaleString('en-US', { timeZone: TIMEZONE });
  const ist = new Date(istStr);

  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const day = ist.getDay(); // 0=Sun, 6=Sat

  const year = ist.getFullYear();
  const month = String(ist.getMonth() + 1).padStart(2, '0');
  const date = String(ist.getDate()).padStart(2, '0');
  const dateStr = `${year}-${month}-${date}`;

  const timeStr = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`;

  return { hours, minutes, day, dateStr, timeStr };
}

/**
 * Parse HH:MM time string into { hours, minutes }.
 * @param {string} timeStr - e.g. '09:15'
 * @returns {{ hours: number, minutes: number }}
 */
function parseTime(timeStr) {
  const [hours, minutes] = timeStr.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Convert hours:minutes to total minutes since midnight.
 * @param {number} hours
 * @param {number} minutes
 * @returns {number}
 */
function toMinutes(hours, minutes) {
  return hours * 60 + minutes;
}

/**
 * Check if today is a market holiday.
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isMarketHoliday(now = new Date()) {
  const { dateStr } = getISTTime(now);
  return MARKET_HOLIDAYS_2026.includes(dateStr);
}

/**
 * Check if today is a weekend (Saturday or Sunday).
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isWeekend(now = new Date()) {
  const { day } = getISTTime(now);
  return day === 0 || day === 6;
}

/**
 * Check if today is a trading day (not weekend, not holiday).
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isTradingDay(now = new Date()) {
  return !isWeekend(now) && !isMarketHoliday(now);
}

/**
 * Check if current time is within market hours (9:15 AM – 3:30 PM IST).
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isMarketOpen(now = new Date()) {
  // In SIM mode the clock is always "open" — the session timer in the
  // simulator controls session start/end instead.
  if (isSimMode()) return true;

  if (!isTradingDay(now)) return false;

  const { hours, minutes } = getISTTime(now);
  const currentMin = toMinutes(hours, minutes);
  const openMin = toMinutes(...Object.values(parseTime(MARKET_OPEN)));
  const closeMin = toMinutes(...Object.values(parseTime(MARKET_CLOSE)));

  return currentMin >= openMin && currentMin < closeMin;
}

/**
 * Check if current time is within pre-market session (9:00 AM – 9:15 AM IST).
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isPreMarket(now = new Date()) {
  if (!isTradingDay(now)) return false;

  const { hours, minutes } = getISTTime(now);
  const currentMin = toMinutes(hours, minutes);
  const preOpenMin = toMinutes(...Object.values(parseTime(PRE_MARKET_OPEN)));
  const openMin = toMinutes(...Object.values(parseTime(MARKET_OPEN)));

  return currentMin >= preOpenMin && currentMin < openMin;
}

/**
 * Check if it's time to square off all positions (>= 3:15 PM IST).
 * @param {Date} [now]
 * @returns {boolean}
 */
export function isSquareOffTime(now = new Date()) {
  if (!isTradingDay(now)) return false;

  const { hours, minutes } = getISTTime(now);
  const currentMin = toMinutes(hours, minutes);
  const squareOffMin = toMinutes(...Object.values(parseTime(SQUARE_OFF_TIME)));
  const closeMin = toMinutes(...Object.values(parseTime(MARKET_CLOSE)));

  return currentMin >= squareOffMin && currentMin < closeMin;
}

/**
 * Get time remaining until market opens (in minutes).
 * Returns 0 if market is already open; negative if past close.
 * @param {Date} [now]
 * @returns {number} Minutes until open
 */
export function minutesUntilOpen(now = new Date()) {
  const { hours, minutes } = getISTTime(now);
  const currentMin = toMinutes(hours, minutes);
  const openMin = toMinutes(...Object.values(parseTime(MARKET_OPEN)));

  return openMin - currentMin;
}

/**
 * Get time remaining until market closes (in minutes).
 * @param {Date} [now]
 * @returns {number} Minutes until close
 */
export function minutesUntilClose(now = new Date()) {
  const { hours, minutes } = getISTTime(now);
  const currentMin = toMinutes(hours, minutes);
  const closeMin = toMinutes(...Object.values(parseTime(MARKET_CLOSE)));

  return closeMin - currentMin;
}

/**
 * Get a summary of the current market status for logging/display.
 * @param {Date} [now]
 * @returns {{ status: string, isTradingDay: boolean, isOpen: boolean, isSquareOff: boolean, timeStr: string }}
 */
export function getMarketStatus(now = new Date()) {
  const ist = getISTTime(now);
  const tradingDay = isTradingDay(now);
  const open = isMarketOpen(now);
  const squareOff = isSquareOffTime(now);
  const preMarket = isPreMarket(now);

  let status = 'CLOSED';
  if (!tradingDay) {
    status = isWeekend(now) ? 'WEEKEND' : 'HOLIDAY';
  } else if (preMarket) {
    status = 'PRE_MARKET';
  } else if (squareOff) {
    status = 'SQUARE_OFF';
  } else if (open) {
    status = 'OPEN';
  }

  return {
    status,
    isTradingDay: tradingDay,
    isOpen: open,
    isSquareOff: squareOff,
    isPreMarket: preMarket,
    timeStr: ist.timeStr,
    dateStr: ist.dateStr,
  };
}
