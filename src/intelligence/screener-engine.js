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
import { scoreLiquidity, scoreTrend, scoreVolatility, scoreMomentum, NSE_UNIVERSE } from './symbol-scout.js';
import { query } from '../lib/db.js';

const log = createLogger('screener-engine');

const CACHE_KEY        = 'screener:results';
const CACHE_TTL_LIVE   = 15 * 60;   // 15 minutes during market hours
const CACHE_TTL_CLOSED = 12 * 60 * 60; // 12 hours overnight
const SCAN_DAYS        = 70;         // daily candles to fetch per symbol
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
 * Score a single symbol given its daily candles and optional signal stats.
 */
function scoreSymbol(symbol, candles, signalStats) {
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

  return {
    symbol,
    score:    total,
    hardFail: liquidity.hardFail || trend.hardFail || false,
    price:    trend.price ?? candles[candles.length - 1]?.close ?? null,
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
 * @param {{ broker, progressCb }} opts
 * @returns {Promise<Array>} sorted results
 */
export async function runScreener({ broker = null, progressCb = null } = {}) {
  const fmt = (d) => d.toISOString().split('T')[0];
  const toDate   = new Date();
  const fromDate = new Date(); fromDate.setDate(toDate.getDate() - SCAN_DAYS);

  const universe = [...new Set(NSE_UNIVERSE)]; // deduped
  const signalStats = await loadSignalStats(universe);

  const results = [];
  let processed = 0;

  for (let i = 0; i < universe.length; i += BATCH_SIZE) {
    const batch = universe.slice(i, i + BATCH_SIZE);

    await Promise.all(batch.map(async (symbol) => {
      try {
        const candles = await fetchHistoricalData({
          broker,
          symbol,
          instrumentToken: null,
          interval: 'day',
          from: fmt(fromDate),
          to:   fmt(toDate),
          cacheTTL: CACHE_TTL_LIVE,
        });

        if (!candles || candles.length < 20) return; // not enough data

        const scored = scoreSymbol(symbol, candles, signalStats);
        if (!scored.hardFail) results.push(scored);
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
 * @param {{ broker, forceRefresh }} opts
 */
export async function getScreenerResults({ broker = null, forceRefresh = false } = {}) {
  if (!forceRefresh) {
    try {
      const cached = await cacheGet(CACHE_KEY);
      if (cached) {
        log.info({ count: cached.length }, 'Screener: serving from cache');
        return { results: cached, fromCache: true, cachedAt: null };
      }
    } catch { /* ignore cache errors */ }
  }

  log.info('Screener: cache miss — running live scan');
  const results  = await runScreener({ broker });
  const scannedAt = new Date().toISOString();

  try {
    await cacheSet(CACHE_KEY, results, cacheTTL());
  } catch { /* ignore */ }

  return { results, fromCache: false, scannedAt };
}
