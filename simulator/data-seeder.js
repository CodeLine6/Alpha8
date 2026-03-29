/**
 * data-seeder.js
 *
 * Fetches recent OHLCV candles from Yahoo Finance for each symbol at simulator startup.
 * Computes per-symbol GBM parameters (drift, volatility) and caches to disk
 * so the simulator works on weekends without a live internet connection.
 *
 * Exports:
 *   seedSymbols(symbols) → Promise<Map<symbol, SeedData>>
 *
 * SeedData: { lastClose, open, high, low, drift, volatility, avgVolume }
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR  = path.join(__dirname, 'cache');
const CACHE_FILE = path.join(CACHE_DIR, 'seed-data.json');
const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // Refresh daily

// ─── Fallback prices if Yahoo fails entirely ────────────────────────────────
const FALLBACK_PRICES = {
  RELIANCE: 1280, TCS: 3450, INFY: 1580, HDFCBANK: 1720, ICICIBANK: 1230,
  WIPRO: 460,  SBIN: 810,  BAJFINANCE: 7100, AXISBANK: 1080, HINDUNILVR: 2380,
  MARUTI: 11500, KOTAKBANK: 1920, LT: 3500, ASIANPAINT: 2400, SUNPHARMA: 1750,
  TITAN: 3350, ULTRACEMCO: 10200, NESTLEIND: 2250, POWERGRID: 320, NTPC: 350,
  ONGC: 270, JSWSTEEL: 830, TATAMOTORS: 670, TATASTEEL: 155, HCLTECH: 1500,
  TECHM: 1350, CIPLA: 1450, DRREDDY: 5400, DIVISLAB: 3800, BRITANNIA: 4900,
  GRASIM: 2700, HINDALCO: 650, ADANIENT: 2100, ADANIPORTS: 1200, BAJAJFINSV: 1800,
  'BAJAJ-AUTO': 8700, EICHERMOT: 4800, HEROMOTOCO: 4300, INDUSINDBK: 1050,
  'M&M': 2900, BHARTIARTL: 1700, COALINDIA: 400, BPCL: 290, IOC: 165,
  HDFCLIFE: 640, SBILIFE: 1500, TATACONSUM: 980, APOLLOHOSP: 6700, UPL: 470,
};

// Yahoo Finance interval map
const INTERVAL_MAP = { day: '1d', '1d': '1d', '5minute': '5m', minute: '1m' };

/**
 * Fetch daily OHLCV from Yahoo Finance for a single NSE symbol.
 * @param {string} symbol  – NSE symbol e.g. 'RELIANCE'
 * @param {number} days    – number of calendar days to look back
 */
async function fetchYahoo(symbol, days = 30) {
  const { default: axios } = await import('axios');
  const yahooSym = `${symbol}.NS`;
  const to   = Math.floor(Date.now() / 1000);
  const from = to - days * 86400;
  const url  = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}` +
               `?period1=${from}&period2=${to}&interval=1d`;

  const res = await axios.get(url, {
    headers: { 'User-Agent': 'Mozilla/5.0' },
    timeout: 8000,
  });

  const result = res.data?.chart?.result?.[0];
  if (!result) return null;

  const timestamps = result.timestamp || [];
  const q = result.indicators?.quote?.[0] || {};

  return timestamps.map((ts, i) => ({
    timestamp: new Date(ts * 1000).toISOString(),
    open:   q.open?.[i]   ?? 0,
    high:   q.high?.[i]   ?? 0,
    low:    q.low?.[i]    ?? 0,
    close:  q.close?.[i]  ?? 0,
    volume: q.volume?.[i] ?? 0,
  })).filter(c => c.close > 0);
}

/**
 * Compute GBM parameters from a series of daily closes.
 * Returns { drift, volatility } where:
 *   drift      = mean log-return per minute (annualised → per-minute)
 *   volatility = std-dev of log-returns per minute
 */
function computeGBMParams(candles) {
  if (candles.length < 2) return { drift: 0, volatility: 0.0002 };

  const closes = candles.map(c => c.close);
  const logReturns = [];
  for (let i = 1; i < closes.length; i++) {
    if (closes[i - 1] > 0) {
      logReturns.push(Math.log(closes[i] / closes[i - 1]));
    }
  }

  const n    = logReturns.length;
  const mean = logReturns.reduce((a, b) => a + b, 0) / n;
  const variance = logReturns.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  const annualVol = Math.sqrt(variance * 252);

  // Convert daily → per-minute (market day = 375 minutes)
  const minuteVol   = annualVol / Math.sqrt(252 * 375);
  const minuteDrift = mean / 375;

  return {
    drift:      minuteDrift,
    volatility: Math.max(minuteVol, 0.00005), // floor at 0.005% per minute
  };
}

/**
 * Derive an intraday open from the last daily candle with a small gap (±0.5%).
 */
function computeIntradayOpen(lastClose) {
  const gapPct = (Math.random() - 0.5) * 0.005; // ±0.25%
  return parseFloat((lastClose * (1 + gapPct)).toFixed(2));
}

/**
 * Seed a single symbol. Returns SeedData.
 * @param {string} symbol
 */
async function seedOne(symbol) {
  let candles = [];
  try {
    candles = await fetchYahoo(symbol, 30);
  } catch (_) {
    // Silent – fallback below
  }

  const fallback = FALLBACK_PRICES[symbol] ?? 1000;

  if (!candles || candles.length === 0) {
    const vol = fallback * 0.015; // 1.5% daily vol assumed
    return {
      symbol,
      lastClose:  fallback,
      open:       computeIntradayOpen(fallback),
      high:       fallback,
      low:        fallback,
      drift:      0,
      volatility: 0.0002,
      avgVolume:  500000,
      seededAt:   new Date().toISOString(),
      source:     'fallback',
    };
  }

  const last = candles[candles.length - 1];
  const { drift, volatility } = computeGBMParams(candles);
  const avgVolume = Math.round(candles.reduce((a, c) => a + c.volume, 0) / candles.length);

  return {
    symbol,
    lastClose:  last.close,
    open:       computeIntradayOpen(last.close),
    high:       last.high,
    low:        last.low,
    drift,
    volatility,
    avgVolume,
    seededAt:   new Date().toISOString(),
    source:     'yahoo',
  };
}

/**
 * Load seed data from disk cache.
 * Returns null if cache is missing or stale.
 */
function loadCache() {
  try {
    if (!fs.existsSync(CACHE_FILE)) return null;
    const stat = fs.statSync(CACHE_FILE);
    if (Date.now() - stat.mtimeMs > CACHE_TTL_MS) return null;
    const raw = fs.readFileSync(CACHE_FILE, 'utf8');
    return JSON.parse(raw); // { [symbol]: SeedData }
  } catch {
    return null;
  }
}

/**
 * Persist seed data to disk.
 */
function saveCache(data) {
  try {
    if (!fs.existsSync(CACHE_DIR)) fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(CACHE_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch {
    // Non-fatal
  }
}

/**
 * Main export: seed a list of symbols.
 *
 * @param {string[]} symbols
 * @returns {Promise<Map<string, SeedData>>}
 */
export async function seedSymbols(symbols) {
  const cached = loadCache();
  const result  = new Map();
  const toFetch = [];

  for (const sym of symbols) {
    if (cached?.[sym]) {
      result.set(sym, cached[sym]);
    } else {
      toFetch.push(sym);
    }
  }

  if (toFetch.length > 0) {
    console.log(`[seeder] Fetching Yahoo data for ${toFetch.length} symbols...`);

    // Sequential fetches with small delay to avoid rate-limiting
    for (const sym of toFetch) {
      try {
        const data = await seedOne(sym);
        result.set(sym, data);
        process.stdout.write(`  ✓ ${sym.padEnd(16)} close=${data.lastClose}  vol=${data.volatility.toExponential(2)}\n`);
      } catch (err) {
        console.warn(`  ✗ ${sym}: ${err.message} — using fallback`);
        const data = await seedOne(sym); // seedOne has its own fallback
        result.set(sym, data);
      }
      // Small delay to be polite to Yahoo
      await new Promise(r => setTimeout(r, 120));
    }

    // Merge with existing cache and save
    const merged = { ...(cached || {}) };
    for (const [sym, data] of result) {
      merged[sym] = data;
    }
    saveCache(merged);
    console.log(`[seeder] Seed data saved to ${CACHE_FILE}`);
  } else {
    console.log(`[seeder] All ${symbols.length} symbols loaded from disk cache`);
  }

  return result;
}

/**
 * Clear the disk cache (e.g., to force a fresh fetch).
 */
export function clearCache() {
  try {
    if (fs.existsSync(CACHE_FILE)) fs.unlinkSync(CACHE_FILE);
  } catch {
    // Non-fatal
  }
}
