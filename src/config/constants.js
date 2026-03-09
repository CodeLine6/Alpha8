/**
 * Application-wide constants for Alpha8.
 * All market times are in Asia/Kolkata (IST) timezone.
 * @module constants
 */

// ─── Timezone ───────────────────────────────────────────
/** @type {string} IANA timezone for Indian markets */
export const TIMEZONE = 'Asia/Kolkata';

// ─── Market Hours ───────────────────────────────────────
/** Market open time (HH:MM in IST) */
export const MARKET_OPEN = '09:15';

/** Market close time (HH:MM in IST) */
export const MARKET_CLOSE = '15:30';

/** Auto square-off time — all positions closed (HH:MM in IST) */
export const SQUARE_OFF_TIME = '15:15';

/** Pre-market session start (HH:MM in IST) */
export const PRE_MARKET_OPEN = '09:00';

// ─── Order States ───────────────────────────────────────
/** @enum {string} */
export const ORDER_STATE = Object.freeze({
  PENDING: 'PENDING',
  PLACED: 'PLACED',
  FILLED: 'FILLED',
  REJECTED: 'REJECTED',
  CANCELLED: 'CANCELLED',
});

// ─── Signal Types ───────────────────────────────────────
/** @enum {string} */
export const SIGNAL = Object.freeze({
  BUY: 'BUY',
  SELL: 'SELL',
  HOLD: 'HOLD',
});

// ─── Order Types ────────────────────────────────────────
/** @enum {string} */
export const ORDER_TYPE = Object.freeze({
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  SL_M: 'SL-M',
});

// ─── Strategy Names ─────────────────────────────────────
/** @enum {string} */
export const STRATEGY = Object.freeze({
  EMA_CROSSOVER: 'EMA_CROSSOVER',
  RSI_MEAN_REVERSION: 'RSI_MEAN_REVERSION',
  VWAP_MOMENTUM: 'VWAP_MOMENTUM',
  BREAKOUT_VOLUME: 'BREAKOUT_VOLUME',
});

// ─── Risk Limits (defaults, overridden by env) ──────────
export const RISK_DEFAULTS = Object.freeze({
  MAX_DAILY_LOSS_PCT: 2,
  PER_TRADE_STOP_LOSS_PCT: 1,
  MAX_POSITION_COUNT: 5,
  KILL_SWITCH_DRAWDOWN_PCT: 5,
});

// ─── Exchange Identifiers ───────────────────────────────
/** @enum {string} */
export const EXCHANGE = Object.freeze({
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO',
});

// ─── Retry Configuration ────────────────────────────────
export const MAX_ORDER_RETRIES = 3;
export const RETRY_DELAY_MS = 1000;

// ─── NSE Holidays (update annually — verify at https://www.nseindia.com/) ─
/** @type {string} Year these holidays apply to */
export const MARKET_HOLIDAYS_YEAR = 2026;
export const MARKET_HOLIDAYS_2026 = Object.freeze([
  '2026-01-26', // Republic Day
  '2026-03-10', // Holi
  '2026-03-30', // Id-Ul-Fitr
  '2026-04-02', // Ram Navami
  '2026-04-03', // Good Friday
  '2026-04-14', // Dr. Ambedkar Jayanti
  '2026-05-01', // Maharashtra Day
  '2026-06-05', // Eid-Ul-Adha (Bakri Id)
  '2026-07-06', // Muharram
  '2026-08-15', // Independence Day
  '2026-08-26', // Janmashtami
  '2026-10-02', // Mahatma Gandhi Jayanti
  '2026-10-20', // Dussehra
  '2026-11-09', // Diwali (Laxmi Pujan)
  '2026-11-10', // Diwali Balipratipada
  '2026-11-27', // Gurunanak Jayanti
  '2026-12-25', // Christmas
]);
