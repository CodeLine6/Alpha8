/**
 * @fileoverview Historical OHLCV data fetcher for backtesting.
 *
 * Priority order:
 *   1. Local disk cache  (avoids repeated API calls)
 *   2. Kite Connect      (best quality, requires credentials + paid plan)
 *   3. Yahoo Finance     (free, 5-min up to 60 days, daily up to 5 years)
 *   4. CSV import        (manual data from any source)
 */

import { createRequire } from 'module';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';


const require = createRequire(import.meta.url);

const __dirname = dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = join(__dirname, '../../backtest-cache');

// Kite interval → Yahoo Finance interval mapping
const INTERVAL_MAP = {
  'minute':    '1m',
  '3minute':   '2m',   // Yahoo doesn't have 3m, use 2m
  '5minute':   '5m',
  '15minute':  '15m',
  '30minute':  '30m',
  '60minute':  '60m',
  'day':       '1d',
};

// NSE symbol → Yahoo Finance ticker (append .NS for NSE)
const toYahooTicker = (symbol) => {
  // Handle index symbols
  if (symbol === 'NIFTY 50' || symbol === 'NIFTY50') return '^NSEI';
  if (symbol === 'BANKNIFTY' || symbol === 'NIFTY BANK') return '^NSEBANK';
  return `${symbol}.NS`;
};

/**
 * Normalise a raw candle object to a consistent shape.
 * @param {object} raw
 * @returns {{ date: Date, open: number, high: number, low: number, close: number, volume: number }}
 */
function normaliseCandle(raw) {
  return {
    date:   raw.date instanceof Date ? raw.date : new Date(raw.date),
    open:   Number(raw.open),
    high:   Number(raw.high),
    low:    Number(raw.low),
    close:  Number(raw.close),
    volume: Number(raw.volume ?? raw.vol ?? 0),
  };
}

/**
 * Ensure cache directory exists.
 */
function ensureCacheDir() {
  if (!existsSync(CACHE_DIR)) mkdirSync(CACHE_DIR, { recursive: true });
}

/**
 * Build a deterministic cache key.
 */
function cacheKey(symbol, from, to, interval) {
  const f = from instanceof Date ? from.toISOString().slice(0, 10) : from;
  const t = to   instanceof Date ? to.toISOString().slice(0, 10)   : to;
  return `${symbol}_${f}_${t}_${interval}.json`;
}

/**
 * Read candles from local cache.
 * @returns {Array|null}
 */
function readCache(symbol, from, to, interval) {
  ensureCacheDir();
  const path = join(CACHE_DIR, cacheKey(symbol, from, to, interval));
  if (!existsSync(path)) return null;
  try {
    const data = JSON.parse(readFileSync(path, 'utf8'));
    return data.map(c => ({ ...c, date: new Date(c.date) }));
  } catch {
    return null;
  }
}

/**
 * Write candles to local cache.
 */
function writeCache(symbol, from, to, interval, candles) {
  ensureCacheDir();
  const path = join(CACHE_DIR, cacheKey(symbol, from, to, interval));
  writeFileSync(path, JSON.stringify(candles, null, 2));
}

/**
 * Fetch historical candles from Kite Connect.
 * Requires: KITE_API_KEY, and a valid access_token stored in Redis by auto-login.
 *
 * @param {object} kite  - KiteConnect instance (already authenticated)
 * @param {string} symbol
 * @param {Date}   from
 * @param {Date}   to
 * @param {string} interval  - 'minute'|'5minute'|'day' etc.
 * @returns {Promise<Array>}
 */
async function fetchFromKite(kite, symbol, from, to, interval) {
  // Look up the instrument token for this symbol
  const instruments = await kite.getInstruments(['NSE']);
  const instrument  = instruments.find(i => i.tradingsymbol === symbol.toUpperCase());

  if (!instrument) {
    throw new Error(`Symbol "${symbol}" not found in NSE instruments list`);
  }

  const raw = await kite.getHistoricalData(
    instrument.instrument_token,
    from,
    to,
    interval,
    false, // continuous (for futures)
    false  // oi (open interest)
  );

  // Kite returns [{ date, open, high, low, close, volume }]
  return raw.map(normaliseCandle);
}

/**
 * Fetch historical candles from Yahoo Finance (free, no auth).
 * Intraday data available for up to 60 days.
 * Daily data available for up to 5+ years.
 *
 * @param {string} symbol  - NSE symbol e.g. 'RELIANCE'
 * @param {Date}   from
 * @param {Date}   to
 * @param {string} interval  - Kite-style interval e.g. '5minute', 'day'
 * @returns {Promise<Array>}
 */
async function fetchFromYahoo(symbol, from, to, interval) {
  const ticker       = toYahooTicker(symbol);
  const yahooInterval = INTERVAL_MAP[interval] ?? '5m';
  const period1      = Math.floor(from.getTime() / 1000);
  const period2      = Math.floor(to.getTime()   / 1000);

  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${ticker}` +
    `?interval=${yahooInterval}&period1=${period1}&period2=${period2}`;

  // Use dynamic import for node-fetch compatibility
  let fetchFn;
  try {
    const mod = await import('node-fetch');
    fetchFn = mod.default ?? mod;
  } catch {
    // Node 18+ has native fetch
    fetchFn = globalThis.fetch;
  }

  const resp = await fetchFn(url, {
    headers: { 'User-Agent': 'Mozilla/5.0 (Quant8/1.0 backtesting)' },
  });

  if (!resp.ok) {
    throw new Error(`Yahoo Finance HTTP ${resp.status} for ${ticker}`);
  }

  const json = await resp.json();

  const chart   = json?.chart?.result?.[0];
  if (!chart) {
    const errMsg = json?.chart?.error?.description ?? 'Unknown error';
    throw new Error(`Yahoo Finance error for ${ticker}: ${errMsg}`);
  }

  const timestamps = chart.timestamp ?? [];
  const quotes     = chart.indicators?.quote?.[0] ?? {};

  const candles = [];
  for (let i = 0; i < timestamps.length; i++) {
    // Skip candles with null OHLCV (market closed / pre-market)
    if (
      quotes.open?.[i]  == null ||
      quotes.close?.[i] == null
    ) continue;

    candles.push(normaliseCandle({
      date:   new Date(timestamps[i] * 1000),
      open:   quotes.open[i],
      high:   quotes.high[i],
      low:    quotes.low[i],
      close:  quotes.close[i],
      volume: quotes.volume?.[i] ?? 0,
    }));
  }

  return candles;
}

/**
 * Load candles from a local CSV file.
 * Expected columns (case-insensitive): date/datetime/timestamp, open, high, low, close, volume
 *
 * @param {string} filePath  - absolute or relative path to CSV
 * @returns {Array}
 */
function loadFromCsv(filePath) {
  const content = readFileSync(filePath, 'utf8');
  const lines   = content.split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];

  // Parse header row — handle quoted column names
  const parseRow = (line) => {
    const result = [];
    let current  = '';
    let inQuotes = false;
    for (const ch of line) {
      if (ch === '"') { inQuotes = !inQuotes; continue; }
      if (ch === ',' && !inQuotes) { result.push(current.trim()); current = ''; continue; }
      current += ch;
    }
    result.push(current.trim());
    return result;
  };

  const headers = parseRow(lines[0]).map(h => h.toLowerCase().trim());

  return lines.slice(1).map(line => {
    const vals = parseRow(line);
    const row  = {};
    headers.forEach((h, i) => { row[h] = vals[i] ?? ''; });

    const dateStr = row.date ?? row.datetime ?? row.timestamp ?? row.time;
    return normaliseCandle({
      date:   new Date(dateStr),
      open:   row.open,
      high:   row.high,
      low:    row.low,
      close:  row.close,
      volume: row.volume ?? row.vol ?? 0,
    });
  }).filter(c => !isNaN(c.date.getTime()));
}

/**
 * Main public API — fetches historical OHLCV candles with automatic fallback.
 *
 * @param {object}  options
 * @param {string}  options.symbol        - NSE trading symbol e.g. 'RELIANCE'
 * @param {Date}    options.from          - start date (inclusive)
 * @param {Date}    options.to            - end date   (inclusive)
 * @param {string}  [options.interval]    - 'minute'|'5minute'|'15minute'|'day' (default: '5minute')
 * @param {object}  [options.kite]        - authenticated KiteConnect instance (optional)
 * @param {string}  [options.csvPath]     - path to CSV file to import (optional)
 * @param {boolean} [options.noCache]     - skip cache (default: false)
 * @param {Function} [options.logger]     - log function (default: console.log)
 * @returns {Promise<Array>}
 */
export async function fetchHistoricalData({
  symbol,
  from,
  to,
  interval   = '5minute',
  kite       = null,
  csvPath    = null,
  noCache    = false,
  logger     = console.log,
}) {
  if (typeof from === 'string') from = new Date(from);
  if (typeof to   === 'string') to   = new Date(to);

  // 1. CSV import (highest priority if provided)
  if (csvPath) {
    logger(`[DataFetcher] Loading from CSV: ${csvPath}`);
    const candles = loadFromCsv(csvPath);
    // Filter to requested date range
    return candles.filter(c => c.date >= from && c.date <= to);
  }

  // 2. Disk cache
  if (!noCache) {
    const cached = readCache(symbol, from, to, interval);
    if (cached && cached.length > 0) {
      logger(`[DataFetcher] Cache hit for ${symbol} (${cached.length} candles)`);
      return cached;
    }
  }

  let candles = null;
  let source  = 'unknown';

  // 3. Kite Connect (preferred when authenticated)
  if (kite) {
    try {
      logger(`[DataFetcher] Fetching from Kite Connect: ${symbol} ${interval}`);
      candles = await fetchFromKite(kite, symbol, from, to, interval);
      source  = 'kite';
    } catch (err) {
      logger(`[DataFetcher] Kite failed (${err.message}), falling back to Yahoo Finance`);
    }
  }

  // 4. Yahoo Finance fallback
  if (!candles) {
    logger(`[DataFetcher] Fetching from Yahoo Finance: ${symbol} ${interval}`);
    candles = await fetchFromYahoo(symbol, from, to, interval);
    source  = 'yahoo';
  }

  if (!candles || candles.length === 0) {
    throw new Error(
      `No historical data found for ${symbol} between ${from.toISOString().slice(0,10)} ` +
      `and ${to.toISOString().slice(0,10)}`
    );
  }

  logger(`[DataFetcher] Fetched ${candles.length} candles from ${source}`);

  // Sort chronologically
  candles.sort((a, b) => a.date - b.date);

  // Save to cache
  if (!noCache) {
    writeCache(symbol, from, to, interval, candles);
  }

  return candles;
}

/**
 * Group flat candle array into per-day arrays in IST.
 * Each day's candles cover 09:15 – 15:30 IST.
 *
 * @param {Array}  candles
 * @returns {Map<string, Array>}  key = 'YYYY-MM-DD' in IST
 */
export function groupByDay(candles) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const days = new Map();

  for (const candle of candles) {
    const istDate = new Date(candle.date.getTime() + IST_OFFSET_MS);
    const key = istDate.toISOString().slice(0, 10);
    if (!days.has(key)) days.set(key, []);
    days.get(key).push(candle);
  }

  return days;
}

/**
 * Get the IST time-of-day as "HH:MM" from a UTC Date.
 * @param {Date} date
 * @returns {string}
 */
export function toISTTimeString(date) {
  const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;
  const ist = new Date(date.getTime() + IST_OFFSET_MS);
  return ist.toISOString().slice(11, 16); // "HH:MM"
}

export { normaliseCandle, loadFromCsv };
