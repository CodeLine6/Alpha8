import { createLogger } from '../lib/logger.js';
import { cacheSet, cacheGet } from '../lib/redis.js';

const log = createLogger('historical-data');

/**
 * Historical OHLCV data fetcher with Redis caching.
 *
 * Fetches candle data from the broker (Kite/Angel) or Yahoo Finance fallback,
 * and caches it in Redis to avoid redundant API calls.
 *
 * @module historical-data
 */

/**
 * @typedef {Object} Candle
 * @property {string} timestamp - ISO date string
 * @property {number} open
 * @property {number} high
 * @property {number} low
 * @property {number} close
 * @property {number} volume
 */

/**
 * Fetch historical OHLCV data with Redis caching.
 *
 * @param {Object} params
 * @param {Object} params.broker - BrokerManager or KiteClient instance
 * @param {string|number} params.instrumentToken - Kite instrument token
 * @param {string} params.symbol - Symbol name (for cache key / fallback)
 * @param {string} params.interval - Candle interval (minute, 5minute, 15minute, day, etc.)
 * @param {string|Date} params.from - Start date
 * @param {string|Date} params.to - End date
 * @param {number} [params.cacheTTL=300] - Redis cache TTL in seconds (default 5 min)
 * @param {boolean} [params.forceRefresh=false] - Skip cache, fetch fresh
 * @returns {Promise<Candle[]>} Array of OHLCV candle objects
 */
/**
 * Returns true if the current IST time is within the Kite API availability window.
 * Kite historical data API is only reliably available 08:30–15:45 IST.
 * Calling it outside this window causes circuit breaker trips — skip to Yahoo fallback instead.
 */
function isMarketHoursIST() {
  const now = new Date();
  const istTime = now.toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  return istTime >= '08:30:00' && istTime <= '15:45:00';
}

export async function fetchHistoricalData({
  broker,
  instrumentToken,
  symbol,
  interval,
  from,
  to,
  cacheTTL = 300,
  forceRefresh = false,
}) {
  const cacheKey = `hist:${symbol}:${interval}:${from}:${to}`;

  // Check cache first
  if (!forceRefresh) {
    try {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        log.debug({ symbol, interval, candles: cached.length }, 'Historical data from cache');
        return cached;
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Redis cache read failed, fetching from API');
    }
  }

  // Fetch strategy depends on interval:
  //   • 'day' interval  → try broker anytime (daily OHLCV is static historical data, no circuit breaker risk)
  //                        then fall back to Yahoo Finance
  //   • intraday        → broker only during market hours (outside triggers circuit breaker trips)
  //                        then fall back to Yahoo Finance
  // In all cases: if Yahoo returns empty AND broker is available, try broker as a final fallback.
  const isDaily = interval === 'day';
  let candles;

  // Prioritize broker if token is provided. 
  //   • 'day' interval: Always try broker first (Static historical data)
  //   • intraday: Broker only during market hours (to avoid circuit breaker trips)
  const canTryBroker = broker && instrumentToken && (isDaily || isMarketHoursIST());

  if (canTryBroker) {
    try {
      log.info({ symbol, interval, from, to }, 'Fetching historical data from broker');
      const rawData = await broker.getHistoricalData(instrumentToken, interval, from, to);
      candles = normalizeKiteCandles(rawData);
    } catch (brokerErr) {
      log.warn({ err: brokerErr.message }, 'Broker historical data failed, trying Yahoo Finance');
      candles = await fetchYahooFinanceFallback(symbol, from, to, interval);
    }
  } else {
    // If no token or outside market hours (intraday), use Yahoo Finance
    if (broker && !isMarketHoursIST() && !isDaily) {
      log.debug({ symbol, interval }, 'Outside market hours (intraday) — using Yahoo Finance to avoid circuit breaker');
    }
    candles = await fetchYahooFinanceFallback(symbol, from, to, interval);

    // Final retry with broker if Yahoo failed and we have a broker (even if no token, 
    // it will try its best or fail gracefully)
    if ((!candles || candles.length === 0) && broker && instrumentToken) {
      log.info({ symbol, interval }, 'Yahoo Finance returned no data — retrying with broker');
      try {
        const rawData = await broker.getHistoricalData(instrumentToken, interval, from, to);
        candles = normalizeKiteCandles(rawData);
      } catch (brokerErr) {
        log.warn({ symbol, err: brokerErr.message }, 'Broker fallback also failed');
      }
    }
  }

  // Cache the result (guard: candles may be undefined if all sources failed)
  if (candles && candles.length > 0) {
    try {
      await cacheSet(cacheKey, candles, cacheTTL);
      log.debug({ symbol, candles: candles.length }, 'Historical data cached');
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to cache historical data');
    }
  } else {
    candles = candles || [];
  }

  return candles;
}


/**
 * Normalize Kite Connect historical data response to standard Candle format.
 * Kite returns: { candles: [[date, o, h, l, c, v], ...] }
 * @param {Object} rawData - Kite historical data response
 * @returns {Candle[]}
 */
export function normalizeKiteCandles(rawData) {
  const candleArray = rawData?.candles || rawData?.data?.candles || rawData;

  if (!Array.isArray(candleArray)) {
    log.warn('Unexpected historical data format, returning empty');
    return [];
  }

  return candleArray.map((c) => {
    // Kite format: [timestamp, open, high, low, close, volume]
    if (Array.isArray(c)) {
      return {
        timestamp: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5] || 0,
      };
    }
    // Already object format
    return {
      timestamp: c.date || c.timestamp,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume || 0,
    };
  });
}

/**
 * Fallback: Fetch historical data from Yahoo Finance via public chart API.
 * @param {string} symbol - NSE symbol (e.g. 'RELIANCE')
 * @param {string|Date} from - Start date
 * @param {string|Date} to - End date
 * @param {string} interval - 1m, 5m, 15m, 1d, etc.
 * @returns {Promise<Candle[]>}
 */
export async function fetchYahooFinanceFallback(symbol, from, to, interval) {
  const axios = (await import('axios')).default;

  // Map intervals: Kite → Yahoo
  const intervalMap = {
    minute: '1m',
    '3minute': '5m',
    '5minute': '5m',
    '15minute': '15m',
    '30minute': '30m',
    '60minute': '1h',
    day: '1d',
  };

  const yahooInterval = intervalMap[interval] || '1d';
  
  let yahooSymbol = symbol;
  if (symbol.includes(':')) {
    const [exch, sym] = symbol.split(':');
    yahooSymbol = exch.toUpperCase() === 'BSE' ? `${sym}.BO` : `${sym}.NS`;
  } else {
    yahooSymbol = `${symbol}.NS`;
  }

  const fromEpoch = Math.floor(new Date(from).getTime() / 1000);
  const toEpoch = Math.floor(new Date(to).getTime() / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}` +
    `?period1=${fromEpoch}&period2=${toEpoch}&interval=${yahooInterval}`;

  try {
    log.info({ symbol: yahooSymbol, interval: yahooInterval }, 'Fetching from Yahoo Finance');
    const res = await axios.get(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      timeout: 10000,
    });

    const result = res.data?.chart?.result?.[0];
    if (!result) {
      log.warn('Yahoo Finance returned no result');
      return [];
    }

    const timestamps = result.timestamp || [];
    const quote = result.indicators?.quote?.[0] || {};

    return timestamps.map((ts, i) => ({
      timestamp: new Date(ts * 1000).toISOString(),
      open: quote.open?.[i] ?? 0,
      high: quote.high?.[i] ?? 0,
      low: quote.low?.[i] ?? 0,
      close: quote.close?.[i] ?? 0,
      volume: quote.volume?.[i] ?? 0,
    }));
  } catch (err) {
    // Use warn not error — 404s for obscure/unlisted symbols are expected (especially during scout scans)
    log.warn({ symbol: yahooSymbol, err: err.message }, 'Yahoo Finance fallback also failed');
    return [];
  }
}

/**
 * Fetch latest N candles for a symbol (most recent data).
 * Useful for strategy calculations that need recent history.
 *
 * @param {Object} params
 * @param {Object} params.broker - Broker instance
 * @param {string|number} params.instrumentToken
 * @param {string} params.symbol
 * @param {string} [params.interval='5minute']
 * @param {number} [params.count=50] - Number of candles to fetch
 * @returns {Promise<Candle[]>}
 */
export async function fetchRecentCandles({
  broker,
  instrumentToken,
  symbol,
  interval = '5minute',
  count = 50,
}) {
  // Calculate time range: estimate candles needed based on interval
  const intervalMinutes = {
    minute: 1,
    '3minute': 3,
    '5minute': 5,
    '15minute': 15,
    '30minute': 30,
    '60minute': 60,
    day: 1440,
  };

  const minutesPerCandle = intervalMinutes[interval] || 5;
  const totalMinutes = count * minutesPerCandle * 1.5; // 50% buffer for non-trading hours

  const to = new Date();
  const from = new Date(to.getTime() - totalMinutes * 60 * 1000);

  const candles = await fetchHistoricalData({
    broker,
    instrumentToken,
    symbol,
    interval,
    from: from.toISOString().split('T')[0],
    to: to.toISOString().split('T')[0],
    cacheTTL: 60, // short cache for recent data
  });

  // Return only the last N candles
  return candles.slice(-count);
}
