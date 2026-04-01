/**
 * @fileoverview Screener Engine for Alpha8
 *
 * On-demand scanner that scores a universe of NSE stocks across 5 dimensions,
 * returning ranked results for the dashboard screener page.
 *
 * Reuses scoring functions from symbol-scout.js — no duplicate logic.
 * Results are cached in Redis (TTL: 15 min during market hours, 12 h overnight).
 */

import { createLogger } from '../lib/logger.js';
import { cacheGet, cacheSet } from '../lib/redis.js';
import { fetchHistoricalData } from '../data/historical-data.js';
import { scoreLiquidity, scoreTrend, scoreVolatility, scoreMomentum, NSE_UNIVERSE, BSE_UNIVERSE } from './symbol-scout.js';
import { query } from '../lib/db.js';

const log = createLogger('screener-engine');

const CACHE_KEY        = 'screener:results';
const CACHE_TTL_LIVE   = 15 * 60;   // 15 minutes during market hours
const CACHE_TTL_CLOSED = 12 * 60 * 60; // 12 hours overnight
const SCAN_DAYS        = 120;        // must be > 80 to yield > 55 trading days
const BATCH_SIZE       = 8;          // symbols per batch
const BATCH_DELAY_MS   = 600;        // ms between batches

function isMarketHours() {
  const ist = new Date().toLocaleTimeString('en-GB', { timeZone: 'Asia/Kolkata', hour12: false });
  return ist >= '09:15:00' && ist <= '15:35:00';
}

function cacheTTL() {
  return isMarketHours() ? CACHE_TTL_LIVE : CACHE_TTL_CLOSED;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Fetch per-symbol win rates from signal_outcomes table.
 * Returns a Map<symbol, { wins, total }>
 */
async function loadSignalStats(symbols) {
  const stats = new Map();
  try {
    const result = await query(`
      SELECT symbol,
             COUNT(*) FILTER (WHERE outcome = 'WIN')  AS wins,
             COUNT(*) AS total
      FROM   signal_outcomes
      WHERE  symbol = ANY($1)
      GROUP  BY symbol
    `, [symbols]);
    for (const row of result.rows) {
      stats.set(row.symbol, { wins: parseInt(row.wins), total: parseInt(row.total) });
    }
  } catch { /* table may not exist yet */ }
  return stats;
}

/**
 * Score a single symbol given its daily candles and optional signal stats/live data.
 */
function scoreSymbol(symbol, candles, signalStats, livePrice = null, prevClose = null) {
  const liquidity  = scoreLiquidity(candles);
  const trend      = scoreTrend(candles);
  const volatility = scoreVolatility(candles);
  const momentum   = scoreMomentum(candles);

  let trackRecord = { score: 5, winRate: null, tradeCount: 0 };
  const sig = signalStats?.get(symbol);
  if (sig && sig.total >= 5) {
    const wr = sig.wins / sig.total;
    trackRecord = { score: Math.round(wr * 10), winRate: Math.round(wr * 100), tradeCount: sig.total };
  }

  const total = liquidity.score + trend.score + volatility.score + momentum.score + trackRecord.score;

  const lastCandle = candles[candles.length - 1];
  const prevCandle = candles[candles.length - 2];
  
  // Use live data if provided (more accurate at night/market close)
  let currentPrice = livePrice ?? lastCandle?.close;
  let yesterdayClose = prevClose ?? prevCandle?.close;

  // Fallback: If move is 0 (likely holiday or off-hours stale data), 
  // look back for the last meaningful daily move to keep movers list populated.
  if (currentPrice && yesterdayClose && Math.abs(currentPrice - yesterdayClose) < 0.0001) {
    for (let j = candles.length - 1; j >= Math.max(1, candles.length - 6); j--) {
      const c = candles[j];
      const p = candles[j-1];
      if (c && p && Math.abs(c.close - p.close) > 0.0001) {
        currentPrice = c.close;
        yesterdayClose = p.close;
        break;
      }
    }
  }

  const changePct = (currentPrice && yesterdayClose) 
    ? ((currentPrice - yesterdayClose) / yesterdayClose * 100)
    : 0;

  return {
    symbol,
    score:    total,
    changePct: +changePct.toFixed(2),
    hardFail: liquidity.hardFail || trend.hardFail || false,
    price:    currentPrice ?? null,
    sma20:    trend.sma20 ?? null,
    sma50:    trend.sma50 ?? null,
    regime:   trend.regime ?? 'UNKNOWN',
    breakdown: {
      liquidity:   { score: liquidity.score,   turnoverCr: liquidity.avgTurnoverCr },
      trend:       { score: trend.score,        regime: trend.regime },
      volatility:  { score: volatility.score,   atrPct: volatility.atrPct },
      momentum:    { score: momentum.score,     ret10d: momentum.ret10d, ret20d: momentum.ret20d },
      trackRecord,
    },
  };
}

/**
 * Run a full screener scan.
 * @param {{ broker, instrumentManager, progressCb }} opts
 * @returns {Promise<Array>} sorted results
 */
export async function runScreener({ broker = null, instrumentManager = null, progressCb = null, exchange = 'NSE', forOverview = false } = {}) {
  const fmt = (d) => d.toISOString().split('T')[0];
  const toDate   = new Date();
  const fromDate = new Date(); fromDate.setDate(toDate.getDate() - SCAN_DAYS);

  const universe = exchange === 'BSE' ? [...new Set(BSE_UNIVERSE)] : [...new Set(NSE_UNIVERSE)];
  const signalStats = await loadSignalStats(universe);

  let liveQuotes = {};
  if (broker) {
    try {
      const fullSymbols = universe.map(s => `${exchange}:${s}`);
      liveQuotes = await broker.getQuote(fullSymbols);
      log.debug({ exchange, count: Object.keys(liveQuotes).length }, 'Screener: fetched live quotes for universe');
    } catch (err) {
      log.warn({ err: err.message }, 'Screener: failed to fetch live quotes');
    }
  }

  const results = [];
  let processed = 0;

  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (symbol) => {
      try {
        const fullSymbol = `${exchange}:${symbol}`;
        const instrumentToken = instrumentManager ? instrumentManager.getToken(fullSymbol) : null;

        const candles = await fetchHistoricalData({
          broker,
          symbol: fullSymbol,
          instrumentToken,
          interval: 'day',
          from: fmt(fromDate),
          to:   fmt(toDate),
          cacheTTL: CACHE_TTL_LIVE,
        });

        // Minimum 15 candles to allow for some market data gaps while still having 
        // enough for short-term indicators (SMA10/ATR).
        if (!candles || candles.length < 15) return;

        const quote = liveQuotes[fullSymbol];
        // Only use live quote for current price — NOT for prevClose.
        // After market hours, ohlc.close = ltp (same value), making changePct = 0 for all symbols.
        // prevClose must come from the second-to-last historical candle (the actual previous day's close).
        const scored = scoreSymbol(symbol, candles, signalStats, quote?.last_price, null);
        
        // For the dashboard overview, we show symbols even if they fail liquidity/trend thresholds 
        // that would normally disqualify them from active trading strategies.
        if (forOverview || !scored.hardFail) {
          results.push(scored);
        }
      } catch (err) {
        log.warn({ symbol, err: err.message }, 'Screener: failed to score symbol');
      }
    }));

    processed += batch.length;
    if (progressCb) progressCb(processed, universe.length);

    if (i + BATCH_SIZE < universe.length) await sleep(BATCH_DELAY_MS);
  }

  // Sort by score descending
  results.sort((a, b) => b.score - a.score);

  log.info({ scanned: universe.length, results: results.length }, 'Screener scan complete');
  return results;
}

/**
 * Get screener results — serves from cache if fresh, otherwise re-scans.
 * @param {{ broker, instrumentManager, forceRefresh }} opts
 */
export async function getScreenerResults({ broker = null, instrumentManager = null, forceRefresh = false, exchange = 'NSE', forOverview = false } = {}) {
  const cacheKey = `${CACHE_KEY}:${exchange}`;
  if (!forceRefresh) {
    try {
      const cached = await cacheGet(cacheKey);
      if (cached) {
        log.info({ count: cached.length }, 'Screener: serving from cache');
        return { results: cached, fromCache: true, cachedAt: null };
      }
    } catch { /* ignore cache errors */ }
  }

  log.info({ exchange }, 'Screener: cache miss — running live scan');
  const results  = await runScreener({ broker, instrumentManager, exchange, forOverview });
  const scannedAt = new Date().toISOString();

  try {
    await cacheSet(cacheKey, results, cacheTTL());
  } catch { /* ignore */ }

  return { results, fromCache: false, scannedAt };
}
