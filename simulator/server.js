/**
 * server.js — Alpha8 Stock Market Simulator
 *
 * Runs a self-contained Express + WebSocket server that mimics
 * the Zerodha Kite Connect API (both REST and WebSocket tick feed)
 * so Alpha8 can be tested on weekends without a real broker connection.
 *
 * REST endpoints mirror kite-client.js expectations exactly.
 * WebSocket emits binary tick packets in the format that tick-feed.js
 * already knows how to parse (_parseBinaryTicks).
 *
 * Usage:
 *   node simulator/server.js
 *   # or via npm:
 *   npm run sim
 *
 * Then, in another terminal:
 *   $env:SIM_URL="localhost:3001"; node src/index.js
 *
 * Control the session via REST:
 *   POST /session/start  { "durationHours": 6, "symbols": ["RELIANCE","TCS"] }
 *   POST /session/stop
 *   GET  /session/status
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';
import express from 'express';
import { seedSymbols } from './data-seeder.js';
import { PriceEngine } from './price-engine.js';
import {
  getKiteInstrumentList,
  symbolToToken,
  buildSymbolMap,
  INSTRUMENTS,
} from './instruments-db.js';

// ─── IST / Market-Calendar Helpers ─────────────────────────────────────────

/** IST is UTC+5:30 */
const IST_OFFSET_MS = 5.5 * 60 * 60 * 1000;

/**
 * Returns the n most-recent weekday dates (Mon–Fri) as YYYY-MM-DD strings
 * in IST, starting from today (offset=0 = today, 1 = yesterday, …).
 */
function getPreviousWeekdays(n) {
  const result = [];
  let d = new Date(Date.now() + IST_OFFSET_MS); // current IST moment as UTC object
  while (result.length < n) {
    const dow = d.getUTCDay(); // 0=Sun, 6=Sat
    if (dow !== 0 && dow !== 6) {
      const y = d.getUTCFullYear();
      const m = String(d.getUTCMonth() + 1).padStart(2, '0');
      const day = String(d.getUTCDate()).padStart(2, '0');
      result.push(`${y}-${m}-${day}`);
    }
    d = new Date(d.getTime() - 86_400_000);
  }
  return result;
}

/**
 * Fetch 5-minute intraday candles from Yahoo Finance for a single NSE symbol
 * on the given YYYY-MM-DD source date (covering 9:15–15:30 IST).
 * Returns [] on failure.
 */
async function fetchYahooIntradayCandles(symbol, dateStr) {
  const { default: axios } = await import('axios');
  const [y, m, d] = dateStr.split('-').map(Number);
  // 9:15 IST = 03:45 UTC;  15:30 IST = 10:00 UTC
  const p1 = Math.floor(Date.UTC(y, m - 1, d,  3, 45, 0) / 1000);
  const p2 = Math.floor(Date.UTC(y, m - 1, d, 10,  0, 0) / 1000);
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}.NS` +
              `?period1=${p1}&period2=${p2}&interval=5m`;
  try {
    const res    = await axios.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, timeout: 10_000 });
    const result = res.data?.chart?.result?.[0];
    if (!result) return [];
    const timestamps = result.timestamp || [];
    const q          = result.indicators?.quote?.[0] || {};
    return timestamps
      .map((ts, i) => ({
        time:   ts * 1000,              // UTC ms (source time)
        open:   q.open?.[i]   ?? 0,
        high:   q.high?.[i]   ?? 0,
        low:    q.low?.[i]    ?? 0,
        close:  q.close?.[i]  ?? 0,
        volume: q.volume?.[i] ?? 0,
      }))
      .filter(c => c.close > 0);
  } catch {
    return [];
  }
}

/**
 * Probes Yahoo Finance (via RELIANCE) to find the most-recent trading day
 * with at least 10 five-minute candles, then returns sourceDate + timeShift.
 *
 * timeShift (ms) = sessionStartTime − sourceSessionOpenTime (9:15 IST)
 * Apply: displayTimestamp = sourceTimestamp + timeShift
 *
 * Example — Saturday 17:00 IST start, source = last Friday:
 *   sourceSessionOpenTime = Friday 09:15 IST
 *   timeShift ≈ +31h45m
 *   Friday 09:15 + 31h45m = Saturday 17:00  ✓
 */
async function getSourceDateAndShift() {
  const candidates = getPreviousWeekdays(7);
  for (const dateStr of candidates) {
    const candles = await fetchYahooIntradayCandles('RELIANCE', dateStr);
    if (candles.length >= 10) {
      const [y, m, d]        = dateStr.split('-').map(Number);
      const sourceSessionStartMs = Date.UTC(y, m - 1, d, 3, 45, 0); // 9:15 IST = 03:45 UTC
      const timeShift            = Date.now() - sourceSessionStartMs;
      console.log(`[sim] Source date: ${dateStr}  candles: ${candles.length}  shift: ${(timeShift / 3_600_000).toFixed(2)}h`);
      return { sourceDate: dateStr, sourceSessionStartMs, timeShift };
    }
  }
  // Hard fallback: today, shift from 9:15 IST
  const dateStr = candidates[0];
  const [y, m, d] = dateStr.split('-').map(Number);
  const sourceSessionStartMs = Date.UTC(y, m - 1, d, 3, 45, 0);
  console.warn('[sim] Could not detect source date from Yahoo — using today as fallback');
  return { sourceDate: dateStr, sourceSessionStartMs, timeShift: Date.now() - sourceSessionStartMs };
}

/**
 * Re-aggregate 5-minute candles into a wider interval.
 * targetIntervalMin must be a multiple of 5 (15, 30, 60, 375 for 'day').
 */
function aggregateCandles(candles5m, targetIntervalMin) {
  if (targetIntervalMin <= 5) return candles5m;
  const groupSize = Math.round(targetIntervalMin / 5);
  const result = [];
  for (let i = 0; i < candles5m.length; i += groupSize) {
    const g = candles5m.slice(i, i + groupSize);
    if (!g.length) continue;
    result.push({
      time:   g[0].time,
      open:   g[0].open,
      high:   Math.max(...g.map(c => c.high)),
      low:    Math.min(...g.map(c => c.low)),
      close:  g[g.length - 1].close,
      volume: g.reduce((s, c) => s + c.volume, 0),
    });
  }
  return result;
}

// ─── GBM History Pre-generator ─────────────────────────────────────────────
/**
 * Generate a full session's worth of 5-minute GBM candles for a symbol.
 * Called once at session start for symbols where Yahoo Finance had no data,
 * so that /historical always returns consistent candle shapes across all
 * chart opens — rather than re-running random GBM on every request.
 */
function pregenerateGBMHistory(seed, sourceSessionStartMs, sessionDurationMs) {
  const totalMinutes  = sessionDurationMs / 60_000;
  const candleWidthMin = 5;
  const numCandles    = Math.ceil(totalMinutes / candleWidthMin);

  let price      = seed.open ?? seed.lastClose ?? 1000;
  const vol      = seed.volatility ?? 0.0002;
  const drift    = seed.drift      ?? 0;
  const avgVol   = seed.avgVolume  ?? 500_000;
  const candles  = [];

  for (let i = 0; i < numCandles; i++) {
    const minOfSess = i * candleWidthMin;
    const volMult   = minOfSess < 15 ? 1.8 : minOfSess < 60 ? 1.2 : minOfSess < 300 ? 0.7 : 1.4;
    const sigmaT    = vol * volMult;
    const o = price, open = price;
    let high = o, low = o;

    // Simulate tick-by-tick within candle for realistic wick formation
    for (let j = 0; j < candleWidthMin; j++) {
      let u = 0, v = 0;
      while (u === 0) u = Math.random();
      while (v === 0) v = Math.random();
      const Z      = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);
      const logRet = (drift - 0.5 * sigmaT ** 2) + sigmaT * Z;
      price = parseFloat((price * Math.exp(logRet)).toFixed(2));
      high  = Math.max(high, price);
      low   = Math.min(low,  price);
    }

    const volume = Math.round((avgVol / numCandles) * (0.5 + Math.random()));
    candles.push({ time: sourceSessionStartMs + minOfSess * 60_000, open, high, low, close: price, volume });
  }

  return candles;
}

// ─── Config ────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.SIM_PORT || '3001', 10);
const DEFAULT_DURATION = 6 * 60 * 60 * 1000; // 6 hours
const DEFAULT_SYMBOLS = [
  'RELIANCE', 'TCS', 'INFY', 'HDFCBANK', 'ICICIBANK',
  'WIPRO', 'SBIN', 'BAJFINANCE', 'AXISBANK', 'HINDUNILVR',
];

// ─── Application State ─────────────────────────────────────────────────────
let priceEngine = null;
let seedData = new Map();
let sessionActive = false;
let sessionStartedAt = null;

// Real-data replay state (populated at session start)
let sourceDate          = null;   // YYYY-MM-DD of source trading session
let sourceSessionStartMs = 0;     // UTC ms of 09:15 IST on sourceDate
let timeShift           = 0;      // ms added to source timestamps → today's timestamps
let intradayCache       = new Map(); // symbol → [{time(UTC ms), open, high, low, close, volume}]

// Track simulated paper orders
const paperOrders = new Map(); // orderId → order
let orderCounter = 1000;

// ─── Binary Packet Encoding (Kite Wire Format) ─────────────────────────────
/**
 * Encode a list of ticks into a Kite-binary WebSocket message.
 *
 * Kite full-mode packet (44 bytes each):
 *   [4]  instrumentToken (Int32BE)
 *   [4]  lastPrice * 100 (Int32BE)
 *   [4]  high * 100
 *   [4]  low * 100
 *   [4]  open * 100      (offset 16)
 *   [4]  close * 100     (offset 20)
 *   [4]  volume (UInt32BE) (offset 24)
 *   [4]  change * 100    (offset 28)
 *  ... (12 more bytes depth data, zeroed)
 *
 * Frame header: [2] numPackets, then per-packet: [2] packetLen + packet
 */
function encodeKiteBinary(ticks) {
  const PACKET_LEN = 44;
  // Header: 2 bytes (numPackets)
  // Per packet: 2 bytes (packetLen) + 44 bytes data
  const totalSize = 2 + ticks.length * (2 + PACKET_LEN);
  const buf = Buffer.alloc(totalSize, 0);
  let offset = 0;

  buf.writeInt16BE(ticks.length, offset);
  offset += 2;

  for (const tick of ticks) {
    const token = symbolToToken(tick.symbol) || 0;

    buf.writeInt16BE(PACKET_LEN, offset); offset += 2;

    buf.writeInt32BE(token, offset); offset += 4;
    buf.writeInt32BE(Math.round(tick.ltp * 100), offset); offset += 4;
    buf.writeInt32BE(Math.round(tick.high * 100), offset); offset += 4;
    buf.writeInt32BE(Math.round(tick.low * 100), offset); offset += 4;
    buf.writeInt32BE(Math.round(tick.open * 100), offset); offset += 4;
    buf.writeInt32BE(Math.round(tick.close * 100), offset); offset += 4;
    buf.writeUInt32BE(tick.volume || 0, offset); offset += 4;
    buf.writeInt32BE(Math.round((tick.change || 0) * 100), offset); offset += 4;
    // Remaining 12 bytes already zero-filled (depth data not used by Alpha8)
    offset += 12;
  }

  return buf;
}

// ─── Express App ───────────────────────────────────────────────────────────
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });

app.use(express.json());

// CORS headers – so dashboard can call sim REST too
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  if (req.method === 'OPTIONS') { res.sendStatus(204); return; }
  next();
});

// ─── Health ────────────────────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', simulator: true, ts: new Date().toISOString() });
});

// ─── Session Control ───────────────────────────────────────────────────────
app.get('/session/status', (_req, res) => {
  if (!priceEngine) {
    return res.json({ active: false, symbols: 0, elapsedMs: 0, remainingMs: 0 });
  }
  const status = priceEngine.getStatus();
  res.json({
    active: sessionActive,
    startedAt: sessionStartedAt,
    symbols: status.symbols,
    elapsedMs: status.elapsedMs,
    remainingMs: status.remainingMs,
    sessionDurationMs: status.sessionDurationMs,
  });
});

app.post('/session/start', async (req, res) => {
  if (sessionActive) {
    return res.status(409).json({ error: 'Session already active. POST /session/stop first.' });
  }

  const durationHours = parseFloat(req.body.durationHours ?? 6);
  const symbols = (req.body.symbols && req.body.symbols.length > 0)
    ? req.body.symbols
    : DEFAULT_SYMBOLS;

  console.log(`[sim] Starting session: ${durationHours}h, ${symbols.length} symbols`);

  try {
    seedData = await seedSymbols(symbols);
  } catch (err) {
    console.error('[sim] Seeding failed:', err.message);
    return res.status(500).json({ error: `Seeding failed: ${err.message}` });
  }

  // ── Determine source date + time shift ────────────────────────────────────
  // Real intraday 5m candles are fetched from Yahoo for the last trading day.
  // All timestamps are shifted so that source 09:15 IST == session start (now).
  try {
    const ctx = await getSourceDateAndShift();
    sourceDate           = ctx.sourceDate;
    sourceSessionStartMs = ctx.sourceSessionStartMs;
    timeShift            = ctx.timeShift;
  } catch (err) {
    console.warn('[sim] Source-date detection failed:', err.message, '— using today as pseudo-source');
    // Set up a valid timeShift anchored to today 09:15 IST so pre-generated
    // GBM candles still go through the primary (cache) path in /historical.
    const istNow = new Date(Date.now() + IST_OFFSET_MS);
    const y = istNow.getUTCFullYear(), mo = istNow.getUTCMonth(), dy = istNow.getUTCDate();
    sourceDate           = null;
    sourceSessionStartMs = Date.UTC(y, mo, dy, 3, 45, 0); // 09:15 IST = 03:45 UTC
    timeShift            = Date.now() - sourceSessionStartMs;
  }

  // ── Pre-fetch intraday 5m candles for every symbol ────────────────────────
  intradayCache = new Map();
  if (sourceDate) {
    console.log(`[sim] Fetching intraday candles from ${sourceDate} for ${symbols.length} symbols…`);
    for (const sym of symbols) {
      try {
        const candles = await fetchYahooIntradayCandles(sym, sourceDate);
        if (candles.length > 0) {
          intradayCache.set(sym, candles);
          process.stdout.write(`  ✓ ${sym.padEnd(16)} ${candles.length} candles\n`);
        } else {
          process.stdout.write(`  ✗ ${sym.padEnd(16)} no data (GBM fallback)\n`);
        }
      } catch (err) {
        process.stdout.write(`  ✗ ${sym.padEnd(16)} ${err.message}\n`);
      }
      await new Promise(r => setTimeout(r, 120)); // polite delay — avoid Yahoo rate-limit
    }
  }

  // ── Pre-generate GBM history for symbols with no Yahoo data ───────────────
  // This ensures /historical returns the *same* candle shapes on every call
  // instead of re-running random GBM on each chart open.
  const sessionDurationMs = Math.round(durationHours * 60 * 60 * 1000);
  for (const sym of symbols) {
    if (!intradayCache.has(sym) && seedData.has(sym)) {
      const candles = pregenerateGBMHistory(seedData.get(sym), sourceSessionStartMs, sessionDurationMs);
      intradayCache.set(sym, candles);
      process.stdout.write(`  ~ ${sym.padEnd(16)} ${candles.length} candles (pre-gen GBM)\n`);
    }
  }

  priceEngine = new PriceEngine(seedData, {
    tickIntervalMs: 1000,
    sessionDurationMs,
    intradayCandles:     intradayCache,
    sourceSessionStartMs,
  });

  // Broadcast ticks to all connected WS clients
  priceEngine.on('tick', (ticks) => {
    if (wss.clients.size === 0) return;
    const packet = encodeKiteBinary(ticks);
    for (const client of wss.clients) {
      if (client.readyState === 1 /* OPEN */) {
        client.send(packet);
      }
    }
  });

  priceEngine.on('session_end', () => {
    sessionActive = false;
    console.log('[sim] Session ended naturally');
    // Broadcast a JSON session-end message
    const msg = JSON.stringify({ type: 'session_end', ts: new Date().toISOString() });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  });

  priceEngine.start();
  sessionActive = true;
  sessionStartedAt = new Date().toISOString();

  res.json({
    ok: true,
    symbols: [...seedData.keys()],
    durationHours,
    startedAt: sessionStartedAt,
    wsUrl: `ws://localhost:${PORT}/ws`,
    info: 'Set SIM_URL=localhost:' + PORT + ' in your Alpha8 .env and restart',
  });
});

app.post('/session/stop', (_req, res) => {
  if (priceEngine) {
    priceEngine.stop();
    priceEngine = null;
  }
  sessionActive = false;
  // Clear real-data replay state
  sourceDate = null; sourceSessionStartMs = 0; timeShift = 0; intradayCache = new Map();
  res.json({ ok: true, stoppedAt: new Date().toISOString() });
});

// ─── Kite-Compatible REST Mocks ────────────────────────────────────────────

/**
 * Helper: build Kite-compatible quote object from current price state.
 */
function buildQuote(symbol) {
  const prices = priceEngine?.getLatestPrices();
  const p = prices?.get(symbol) || { ltp: 1000, open: 1000, high: 1000, low: 1000, close: 1000, volume: 0, change: 0 };
  const token = symbolToToken(symbol) || 0;
  return {
    instrument_token: token,
    tradingsymbol: symbol,
    exchange: 'NSE',
    last_price: p.ltp,
    ohlc: {
      open: p.open,
      high: p.high,
      low: p.low,
      close: p.close,
    },
    volume: p.volume ?? 0,
    change: p.change ?? 0,
    average_price: p.ltp,
    last_quantity: 1,
    buy_quantity: 0,
    sell_quantity: 0,
    timestamp: new Date().toISOString(),
  };
}

// GET /api/instruments  — instrument dump (Kite format)
// Kite client calls: GET https://api.kite.trade/instruments
app.get(['/instruments', '/api/instruments'], (_req, res) => {
  res.json(getKiteInstrumentList());
});

// GET /quote  ?i=NSE:RELIANCE&i=NSE:TCS ...
// Kite client calls: GET /quote with instruments array
app.get(['/quote', '/api/quote'], (req, res) => {
  const instruments = [].concat(req.query.i || req.query['i[]'] || []);
  const result = {};
  for (const inst of instruments) {
    const sym = inst.includes(':') ? inst.split(':')[1] : inst;
    const key = `NSE:${sym}`;
    result[key] = buildQuote(sym);
  }
  res.json({ status: 'success', data: result });
});

// GET /ltp?i=NSE:RELIANCE
app.get(['/ltp', '/api/ltp'], (req, res) => {
  const instruments = [].concat(req.query.i || req.query['i[]'] || []);
  const result = {};
  for (const inst of instruments) {
    const sym = inst.includes(':') ? inst.split(':')[1] : inst;
    const key = `NSE:${sym}`;
    const prices = priceEngine?.getLatestPrices();
    const p = prices?.get(sym) || { ltp: 1000 };
    result[key] = {
      instrument_token: symbolToToken(sym) || 0,
      last_price: p.ltp,
    };
  }
  res.json({ status: 'success', data: result });
});

// GET /ohlc?i=NSE:RELIANCE
app.get(['/ohlc', '/api/ohlc'], (req, res) => {
  const instruments = [].concat(req.query.i || req.query['i[]'] || []);
  const result = {};
  for (const inst of instruments) {
    const sym = inst.includes(':') ? inst.split(':')[1] : inst;
    const key = `NSE:${sym}`;
    const prices = priceEngine?.getLatestPrices();
    const p = prices?.get(sym) || { open: 1000, high: 1000, low: 1000, ltp: 1000, close: 1000 };
    result[key] = {
      instrument_token: symbolToToken(sym) || 0,
      last_price: p.ltp,
      ohlc: { open: p.open, high: p.high, low: p.low, close: p.close },
    };
  }
  res.json({ status: 'success', data: result });
});

/**
 * GET /historical/:token?interval=5minute&from=YYYY-MM-DD&to=YYYY-MM-DD
 *
 * PRIMARY PATH — Real intraday candles (when intradayCache is populated):
 *   Serves real Yahoo Finance 5m data for the source trading session,
 *   with all timestamps shifted by `timeShift` so they appear as today's dates.
 *   Aggregates to the requested interval if wider than 5m.
 *
 * FALLBACK PATH — Phase-based GBM:
 *   Used when no intraday cache exists (e.g. Yahoo offline at session start).
 *   Generates plausible candles anchored to the current live price.
 */
app.get([
  '/historical/:instrumentToken',
  '/api/historical/data/:instrumentToken',
], (req, res) => {
  const token  = parseInt(req.params.instrumentToken, 10);
  const interval = req.query.interval || '5minute';
  const fromStr  = req.query.from || req.query.from_date;
  const toStr    = req.query.to   || req.query.to_date;

  const inst   = INSTRUMENTS.find(i => i.token === token);
  const symbol = inst?.symbol;

  const INTERVAL_MINUTES = {
    minute: 1, '3minute': 3, '5minute': 5, '15minute': 15,
    '30minute': 30, '60minute': 60, day: 375,
  };
  const candleWidthMin = INTERVAL_MINUTES[interval] || 5;

  // Parse date range.
  // For date-only strings always interpret `to` as end-of-day UTC so a single-day
  // request (from=to=YYYY-MM-DD) spans the full 24 h rather than collapsing to now.
  const from = fromStr ? new Date(fromStr) : new Date(Date.now() - 7 * 86_400_000);
  const isDateOnly = (s) => s && /^\d{4}-\d{2}-\d{2}$/.test(s);
  const to = toStr ? new Date(toStr) : new Date();
  if (toStr && isDateOnly(toStr)) to.setUTCHours(23, 59, 59, 999);

  // Is the requested date TODAY (IST)?  If so cap at now so we never show
  // ungenerated future candles on the live chart.  Past-date history requests
  // get the full pre-generated session without any cap.
  const istTodayStr = new Date(Date.now() + IST_OFFSET_MS).toISOString().split('T')[0];
  const requestedDateStr = (toStr || '').split('T')[0];
  const isToday = requestedDateStr === istTodayStr;

  // ── PRIMARY: real shifted candles ──────────────────────────────────────────
  const rawCache = symbol && intradayCache.get(symbol);
  if (rawCache?.length > 0 && timeShift !== 0) {
    // Convert requested window back to source time, filter, aggregate, re-timestamp.
    // Only cap at now for today's session; past sessions serve the full pre-generated data.
    const toMs = isToday ? Math.min(to.getTime(), Date.now()) : to.getTime();
    const srcFromMs = from.getTime() - timeShift;
    const srcToMs   = toMs - timeShift;

    const base = rawCache.filter(c => c.time >= srcFromMs && c.time <= srcToMs);
    const aggregated = aggregateCandles(base, candleWidthMin);

    if (aggregated.length > 0) {
      const candles = aggregated.map(c => [
        new Date(c.time + timeShift).toISOString(),
        c.open, c.high, c.low, c.close, c.volume,
      ]);
      return res.json({ status: 'success', data: { candles } });
    }
    // Fall through if filter produced nothing (e.g. request outside session window)
  }

  // ── FALLBACK: phase-based GBM ──────────────────────────────────────────────
  // Cap at now only for today; past-date requests replay the full span.
  const effectiveTo  = new Date(isToday ? Math.min(to.getTime(), Date.now()) : to.getTime());
  const spanMs       = effectiveTo - from;
  const totalMinutes = spanMs / 60_000;
  const numCandles   = Math.max(1, Math.ceil(totalMinutes / candleWidthMin));

  const prices = priceEngine?.getLatestPrices();
  const p      = prices?.get(symbol);
  let currentPrice = p?.close || p?.ltp || 1000;

  let trendDir = 0, trendDrift = 0, trendRemaining = 0;
  const rawCandles = [];
  let ts = new Date(effectiveTo);

  for (let i = 0; i < Math.min(numCandles, 2000); i++) {
    if (trendRemaining <= 0) {
      if (Math.random() < 0.40) {
        trendDir       = Math.random() > 0.5 ? 1 : -1;
        trendDrift     = 0.001 + Math.random() * 0.002;
        trendRemaining = Math.floor(5 + Math.random() * 15);
      } else {
        trendDir = 0; trendDrift = 0;
        trendRemaining = Math.floor(3 + Math.random() * 8);
      }
    }
    trendRemaining--;

    const drift = -trendDir * trendDrift;
    const noise = (Math.random() - 0.5) * 0.006;
    const o = parseFloat((currentPrice * (1 + drift + noise)).toFixed(2));
    const c = parseFloat((o * (1 + drift + (Math.random() - 0.5) * 0.010)).toFixed(2));
    const h = parseFloat((Math.max(o, c) * (1 + Math.random() * 0.004)).toFixed(2));
    const l = parseFloat((Math.min(o, c) * (1 - Math.random() * 0.004)).toFixed(2));
    const isSpike = Math.random() < 0.15 || Math.abs(c - o) / o > 0.005;
    const v = isSpike
      ? Math.round(350_000 + Math.random() * 450_000)
      : Math.round(100_000 + Math.random() * 220_000);

    rawCandles.push([ts.toISOString(), o, h, l, c, v]);
    currentPrice = c;
    ts = new Date(ts.getTime() - candleWidthMin * 60_000);
    if (ts < from) break;
  }

  res.json({ status: 'success', data: { candles: rawCandles.reverse() } });
});

// ─── Orders (Paper Trading Mock) ───────────────────────────────────────────

// POST /orders/:variety  (Kite places orders at: POST /orders/regular)
app.post(['/orders/:variety', '/api/orders/:variety'], (req, res) => {
  const orderId = `SIM${Date.now()}${++orderCounter}`;
  const order = {
    order_id: orderId,
    tradingsymbol: req.body.tradingsymbol,
    exchange: req.body.exchange || 'NSE',
    transaction_type: req.body.transaction_type,
    quantity: req.body.quantity,
    order_type: req.body.order_type || 'MARKET',
    product: req.body.product || 'MIS',
    price: req.body.price || 0,
    trigger_price: req.body.trigger_price || 0,
    status: 'COMPLETE',
    status_message: 'Simulator paper order',
    filled_quantity: req.body.quantity,
    pending_quantity: 0,
    average_price: req.body.price || (() => {
      const prices = priceEngine?.getLatestPrices();
      return prices?.get(req.body.tradingsymbol)?.ltp || 0;
    })(),
    placed_at: new Date().toISOString(),
    variety: req.params.variety || 'regular',
  };
  paperOrders.set(orderId, order);
  console.log(`[sim] Paper order placed: ${order.transaction_type} ${order.quantity} ${order.tradingsymbol} @ ${order.average_price}`);
  res.json({ status: 'success', data: { order_id: orderId } });
});

// GET /orders
app.get(['/orders', '/api/orders'], (_req, res) => {
  res.json({ status: 'success', data: [...paperOrders.values()] });
});

// GET /orders/:orderId
app.get(['/orders/:orderId', '/api/orders/:orderId'], (req, res) => {
  const order = paperOrders.get(req.params.orderId);
  if (!order) return res.status(404).json({ status: 'error', message: 'Order not found' });
  res.json({ status: 'success', data: [order] });
});

// PUT /orders/:variety/:orderId — modify (no-op in sim)
app.put(['/orders/:variety/:orderId', '/api/orders/:variety/:orderId'], (req, res) => {
  res.json({ status: 'success', data: { order_id: req.params.orderId } });
});

// DELETE /orders/:variety/:orderId — cancel
app.delete(['/orders/:variety/:orderId', '/api/orders/:variety/:orderId'], (req, res) => {
  paperOrders.delete(req.params.orderId);
  res.json({ status: 'success', data: { order_id: req.params.orderId } });
});

// ─── Portfolio ─────────────────────────────────────────────────────────────
// Positions — return empty (engine manages itself in paper mode)
app.get(['/portfolio/positions', '/api/portfolio/positions'], (_req, res) => {
  res.json({ status: 'success', data: { day: [], net: [] } });
});

// Holdings
app.get(['/portfolio/holdings', '/api/portfolio/holdings'], (_req, res) => {
  res.json({ status: 'success', data: [] });
});

// ─── Account / Auth ────────────────────────────────────────────────────────
// Profile — indicates a valid session so Alpha8 skips re-auth
app.get(['/user/profile', '/api/user/profile'], (_req, res) => {
  res.json({
    status: 'success',
    data: {
      user_id: 'SIM_USER',
      user_name: 'Alpha8 Simulator',
      email: 'sim@alpha8.local',
      broker: 'SIMULATOR',
      meta: { demat_consent: 'consent' },
      avatar_url: '',
      products: ['MIS', 'CNC'],
      order_types: ['MARKET', 'LIMIT'],
      exchanges: ['NSE', 'BSE'],
    },
  });
});

// Margins
app.get(['/user/margins', '/api/user/margins'], (_req, res) => {
  res.json({
    status: 'success',
    data: {
      equity: {
        enabled: true,
        net: 10000000,
        available: { live_balance: 10000000, adhoc_margin: 0, collateral: 0, intraday_payin: 0 },
        utilised: { debits: 0 },
      },
    },
  });
});

// ─── WebSocket Server ──────────────────────────────────────────────────────
// Handles subscription messages from tick-feed.js exactly as Kite does.
wss.on('connection', (ws, req) => {
  const clientIp = req.socket.remoteAddress;
  console.log(`[sim/ws] Client connected: ${clientIp} (total: ${wss.clients.size})`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.a === 'subscribe') {
        // Alpha8 is subscribing to token list — acknowledge silently
        console.log(`[sim/ws] Subscribe request: ${msg.v?.length ?? 0} tokens`);
      }
      if (msg.a === 'mode') {
        // Mode selection (ltp/quote/full) — we always send full mode
        console.log(`[sim/ws] Mode set to: ${msg.v?.[0]}`);
      }

      // Send current prices immediately on subscribe so Alpha8 gets an
      // initial tick right away (avoids "waiting for first tick" warm-up)
      if (msg.a === 'subscribe' && priceEngine && sessionActive) {
        const latestPrices = priceEngine.getLatestPrices();
        if (latestPrices.size > 0) {
          const allTicks = [...latestPrices.values()];
          const packet = encodeKiteBinary(allTicks);
          if (ws.readyState === 1) ws.send(packet);
        }
      }
    } catch {
      // Binary data or heartbeat — ignore
    }
  });

  ws.on('close', () => {
    console.log(`[sim/ws] Client disconnected (remaining: ${wss.clients.size})`);
  });

  ws.on('error', (err) => {
    console.error('[sim/ws] Client error:', err.message);
  });

  // Send heartbeat every 5s to keep connections alive
  const heartbeat = setInterval(() => {
    if (ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'heartbeat', ts: Date.now() }));
    } else {
      clearInterval(heartbeat);
    }
  }, 5000);
  heartbeat.unref();
});

// ─── Start Server ──────────────────────────────────────────────────────────
server.listen(PORT, () => {
  console.log('');
  console.log('╔══════════════════════════════════════════════════════╗');
  console.log('║          Alpha8 Stock Market Simulator               ║');
  console.log(`║       REST + WebSocket ready on port ${PORT}           ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log(`║  REST:  http://localhost:${PORT}                        ║`);
  console.log(`║  WS:    ws://localhost:${PORT}/ws                       ║`);
  console.log('╠══════════════════════════════════════════════════════╣');
  console.log('║  To start a 6-hour session:                          ║');
  console.log('║  POST /session/start  { "durationHours": 6 }         ║');
  console.log('║                                                      ║');
  console.log('║  Then run Alpha8 with:                               ║');
  console.log(`║  SIM_URL=localhost:${PORT}  node src/index.js           ║`);
  console.log('╚══════════════════════════════════════════════════════╝');
  console.log('');
});

process.on('SIGINT', () => { priceEngine?.stop(); process.exit(0); });
process.on('SIGTERM', () => { priceEngine?.stop(); process.exit(0); });
