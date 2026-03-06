/**
 * Market Data Engine barrel export.
 * @module data
 */

export {
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
} from './market-hours.js';

export {
  fetchHistoricalData,
  fetchRecentCandles,
  normalizeKiteCandles,
  fetchYahooFinanceFallback,
} from './historical-data.js';

export { TickFeed } from './tick-feed.js';
export { InstrumentManager } from './instruments.js';
