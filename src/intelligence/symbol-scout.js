/**
 * @fileoverview Symbol Scout for Alpha8
 *
 * Runs every night at 8:00 PM IST. Scans a universe of ~85 liquid NSE stocks,
 * scores each one across 5 dimensions, and automatically updates the dynamic
 * watchlist — adding promising symbols and removing deteriorating ones.
 *
 * ┌─────────────────────────────────────────────────────────┐
 * │  TWO-TIER WATCHLIST SYSTEM                              │
 * │                                                         │
 * │  Pinned  = WATCHLIST in .env  (you control, never auto- │
 * │            removed, always traded regardless of score)  │
 * │                                                         │
 * │  Dynamic = managed by this Scout (added when score≥55,  │
 * │            removed when score<35 or hard fail)          │
 * │                                                         │
 * │  Active watchlist = deduped(pinned + dynamic)           │
 * └─────────────────────────────────────────────────────────┘
 *
 * SCORING (100 points):
 *   Liquidity   (0-25) — avg daily turnover must be substantial
 *   Trend       (0-25) — SMA stack bullishness (reuses trend-filter logic)
 *   Vol. fit    (0-20) — ATR% in sweet spot: enough range to profit, not chaotic
 *   Momentum    (0-20) — price up vs 10d and 20d ago
 *   Track record(0-10) — per-symbol win rate from signal_outcomes table
 *
 * HARD REMOVE TRIGGERS (bypass score threshold):
 *   • Bearish stack (price < SMA20 < SMA50)
 *   • 3+ consecutive losses in signal_outcomes
 *   • Illiquid (turnover < 1 crore/day avg)
 *
 * DATA: Yahoo Finance daily candles (free, no API key, no rate limit issues)
 *       Falls back to Kite if Yahoo fails.
 */

import { createLogger } from '../lib/logger.js';
import { query } from '../lib/db.js';
import { fetchHistoricalData } from '../data/historical-data.js';
import { calculateSMA } from '../filters/trend-filter.js';
import { calculateATR } from '../filters/regime-detector.js';

const log = createLogger('symbol-scout');

// ── Universe ─────────────────────────────────────────────────────────────────
// Curated list of liquid NSE stocks. The scout picks from these.
// You can extend this list — just keep it to known-liquid symbols.
export const NSE_UNIVERSE = [
    // ── Nifty 50 ──
    'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'BHARTIARTL',
    'ITC', 'KOTAKBANK', 'LT', 'SBIN', 'AXISBANK', 'BAJFINANCE', 'ASIANPAINT', 'MARUTI',
    'TITAN', 'SUNPHARMA', 'NESTLEIND', 'WIPRO', 'ULTRACEMCO', 'HCLTECH', 'ONGC',
    'NTPC', 'POWERGRID', 'TECHM', 'JSWSTEEL', 'TATAMOTORS', 'TATASTEEL', 'INDUSINDBK',
    'BAJAJFINSV', 'M&M', 'DRREDDY', 'ADANIENT', 'ADANIPORTS', 'DIVISLAB', 'COALINDIA',
    'BPCL', 'CIPLA', 'EICHERMOT', 'BRITANNIA', 'APOLLOHOSP', 'GRASIM', 'HINDALCO',
    'TATACONSUM', 'BAJAJ-AUTO', 'HEROMOTOCO', 'SHREECEM', 'VEDL', 'UPL', 'LTIM',
    // ── Nifty Next 50 / large midcap ──
    'HAVELLS', 'PIDILITIND', 'DABUR', 'GODREJCP', 'BERGEPAINT', 'COLPAL',
    'LUPIN', 'AUROPHARMA', 'TORNTPHARM', 'ALKEM', 'MUTHOOTFIN', 'CHOLAFIN',
    'SBILIFE', 'HDFCLIFE', 'ICICIGI', 'DMART', 'NAUKRI', 'IRCTC',
    'TRENT', 'DIXON', 'VOLTAS', 'ABB', 'SIEMENS', 'BOSCHLTD',
    'BANKBARODA', 'PNB', 'FEDERALBNK', 'IDFCFIRSTB',
    'SAIL', 'NMDC', 'HINDZINC',
    'MARICO', 'EMAMILTD',
    'EXIDEIND', 'AMARARAJA', 'APOLLOTYRE',
    'PAGEIND', 'MPHASIS', 'LTTS', 'COFORGE', 'PERSISTENT', 'KPITTECH',
    'PIIND', 'CUMMINSIND', 'THERMAX',
    'ASTRAL', 'SUPREMEIND', 'BALKRISIND',
    'JUBLFOOD', 'ZOMATO',
];

// ── Scoring config ────────────────────────────────────────────────────────────
const ADD_THRESHOLD = 55;   // min score to add to dynamic watchlist
const REMOVE_THRESHOLD = 35;   // below this → remove
const MAX_DYNAMIC = 10;   // max symbols the scout can add
const SCAN_HISTORY_DAYS = 70;   // days of daily candles to fetch
const MIN_TURNOVER_CR = 5;    // minimum avg daily turnover in crore (₹5 crore)
const ILLIQUID_CR = 1;    // hard-fail if below this (₹1 crore)
const CONSEC_LOSS_LIMIT = 3;    // hard-remove if last N trades all losses
const BATCH_SIZE = 10;   // symbols per batch (avoid rate limiting)
const BATCH_DELAY_MS = 3000; // pause between batches

const DB_KEY_DYNAMIC = 'dynamic_watchlist';
const DB_KEY_SCORES = 'symbol_scores_cache';

// ── Pure scoring functions ────────────────────────────────────────────────────

/**
 * Score a symbol's liquidity.
 * Uses average daily turnover (volume × close price).
 * @param {Array} candles - daily candles
 * @returns {{ score: number, avgTurnoverCr: number }}
 */
export function scoreLiquidity(candles) {
    const last20 = candles.slice(-20);
    if (last20.length === 0) return { score: 0, avgTurnoverCr: 0 };

    const avgTurnover = last20.reduce((s, c) => s + (c.volume * c.close), 0) / last20.length;
    const avgTurnoverCr = avgTurnover / 1_00_00_000; // convert to crore

    if (avgTurnoverCr < ILLIQUID_CR) return { score: 0, avgTurnoverCr, hardFail: true };
    if (avgTurnoverCr < MIN_TURNOVER_CR) return { score: 5, avgTurnoverCr };
    if (avgTurnoverCr < 25) return { score: 12, avgTurnoverCr };
    if (avgTurnoverCr < 100) return { score: 18, avgTurnoverCr };
    if (avgTurnoverCr < 500) return { score: 22, avgTurnoverCr };
    return { score: 25, avgTurnoverCr };
}

/**
 * Score trend alignment using SMA20/SMA50 stack.
 * Full bullish stack = 25 points.
 * @param {Array} candles
 * @returns {{ score: number, regime: string, price, sma20, sma50, hardFail }}
 */
export function scoreTrend(candles) {
    if (candles.length < 55) return { score: 0, regime: 'INSUFFICIENT_DATA' };

    const sma20 = calculateSMA(candles, 20);
    const sma50 = calculateSMA(candles, 50);
    const price = candles[candles.length - 1].close;

    if (!sma20 || !sma50) return { score: 0, regime: 'NO_DATA' };

    const bullish = price > sma20 && sma20 > sma50;
    const bearish = price < sma20 && sma20 < sma50;

    let score = 0;
    if (price > sma20) score += 10;
    if (sma20 > sma50) score += 10;
    if (price > sma50) score += 5;

    return {
        score,
        regime: bullish ? 'BULLISH' : bearish ? 'BEARISH' : 'NEUTRAL',
        hardFail: bearish,
        price: Math.round(price * 100) / 100,
        sma20: Math.round(sma20 * 100) / 100,
        sma50: Math.round(sma50 * 100) / 100,
    };
}

/**
 * Score volatility fitness.
 * Sweet spot: ATR% between 0.5% and 3% — enough range to profit, not chaotic.
 * @param {Array} candles
 * @returns {{ score: number, atrPct: number }}
 */
export function scoreVolatility(candles) {
    if (candles.length < 16) return { score: 10, atrPct: null }; // neutral default

    const atr = calculateATR(candles, 14);
    const price = candles[candles.length - 1].close;
    if (!atr || price === 0) return { score: 10, atrPct: null };

    const atrPct = (atr / price) * 100;

    // Perfect range: 0.8% - 2.5%
    if (atrPct >= 0.8 && atrPct <= 2.5) return { score: 20, atrPct };
    // Good range: 0.5% - 3%
    if (atrPct >= 0.5 && atrPct <= 3.0) return { score: 15, atrPct };
    // Acceptable: 0.3% - 4%
    if (atrPct >= 0.3 && atrPct <= 4.0) return { score: 8, atrPct };
    // Too flat or too wild
    return { score: 2, atrPct };
}

/**
 * Score momentum — is the stock actually going up recently?
 * @param {Array} candles
 * @returns {{ score: number, ret10d: number, ret20d: number }}
 */
export function scoreMomentum(candles) {
    if (candles.length < 21) return { score: 5, ret10d: null, ret20d: null };

    const price = candles[candles.length - 1].close;
    const price10d = candles[candles.length - 11]?.close;
    const price20d = candles[candles.length - 21]?.close;

    let score = 0;
    const ret10d = price10d ? ((price - price10d) / price10d * 100) : null;
    const ret20d = price20d ? ((price - price20d) / price20d * 100) : null;

    if (ret10d !== null && ret10d > 0) score += 10;
    if (ret10d !== null && ret10d > 3) score += 3;  // bonus for strong momentum
    if (ret20d !== null && ret20d > 0) score += 7;
    if (ret20d !== null && ret20d > 5) score += 2;  // bonus

    return {
        score: Math.min(20, score),
        ret10d: ret10d !== null ? Math.round(ret10d * 100) / 100 : null,
        ret20d: ret20d !== null ? Math.round(ret20d * 100) / 100 : null,
    };
}

/**
 * Combine all dimension scores into a final score.
 */
export function scoreSymbol(candles, signalStats = null) {
    const liquidity = scoreLiquidity(candles);
    const trend = scoreTrend(candles);
    const volatility = scoreVolatility(candles);
    const momentum = scoreMomentum(candles);

    // Track record from DB (0-10 pts)
    let trackRecord = { score: 5, winRate: null, tradeCount: 0 }; // neutral default
    if (signalStats && signalStats.total >= 5) {
        const wr = signalStats.wins / signalStats.total;
        trackRecord = {
            score: Math.round(wr * 10),
            winRate: Math.round(wr * 100),
            tradeCount: signalStats.total,
        };
    }

    const total = liquidity.score + trend.score + volatility.score + momentum.score + trackRecord.score;

    const hardFail = liquidity.hardFail || trend.hardFail || false;

    return {
        score: total,
        hardFail,
        breakdown: { liquidity, trend, volatility, momentum, trackRecord },
    };
}

// ── SymbolScout class ─────────────────────────────────────────────────────────

export class SymbolScout {
    /**
     * @param {object} opts
     * @param {object}   opts.broker            - BrokerManager (null → Yahoo Finance only)
     * @param {object}   [opts.telegram]        - TelegramBot instance
     * @param {string[]} opts.pinnedSymbols      - From config.WATCHLIST (never auto-removed)
     * @param {number}   [opts.maxDynamic]       - Max dynamic symbols (default 10)
     * @param {string[]} [opts.excludeSymbols]   - Permanent exclusion list
     * @param {Function} [opts.logger]
     */
    constructor({ broker, telegram, pinnedSymbols, maxDynamic, excludeSymbols, logger }) {
        this.broker = broker;
        this.telegram = telegram;
        this.pinnedSymbols = (pinnedSymbols || []).map(s => s.toUpperCase());
        this.maxDynamic = maxDynamic ?? MAX_DYNAMIC;
        this.excludeSymbols = (excludeSymbols || []).map(s => s.toUpperCase());
        this._log = logger || ((msg, meta) => log.info(meta || {}, msg));
    }

    /**
     * Main entry point — called nightly.
     * Scans universe, scores symbols, updates dynamic watchlist.
     * @returns {Promise<ScoutResult>}
     */
    async runNightly() {
        this._log('[Scout] ═══ NIGHTLY SYMBOL SCOUT STARTING ═══');
        const startAt = Date.now();

        // 1. Get current dynamic watchlist
        const currentDynamic = await this._loadDynamic();
        this._log(`[Scout] Current dynamic watchlist: [${currentDynamic.join(', ')}]`);

        // 2. Build scan universe (avoid already-pinned + excluded)
        const toScan = NSE_UNIVERSE.filter(s =>
            !this.excludeSymbols.includes(s)
        );
        this._log(`[Scout] Scanning ${toScan.length} symbols...`);

        // 3. Fetch signal track records from DB (one query for all)
        const trackRecords = await this._fetchTrackRecords(toScan);
        const consecutiveLosses = await this._fetchConsecutiveLosses(toScan);

        // 4. Score all symbols in batches
        const scored = [];
        const batches = [];
        for (let i = 0; i < toScan.length; i += BATCH_SIZE) {
            batches.push(toScan.slice(i, i + BATCH_SIZE));
        }

        for (let b = 0; b < batches.length; b++) {
            const batch = batches[b];
            this._log(`[Scout] Batch ${b + 1}/${batches.length}: ${batch.join(', ')}`);

            const results = await Promise.allSettled(
                batch.map(sym => this._scoreOne(sym, trackRecords[sym], consecutiveLosses[sym]))
            );

            for (let i = 0; i < batch.length; i++) {
                const r = results[i];
                if (r.status === 'fulfilled' && r.value) {
                    scored.push(r.value);
                }
            }

            if (b < batches.length - 1) {
                await this._delay(BATCH_DELAY_MS);
            }
        }

        // 5. Decide additions and removals
        const changes = this._computeChanges(scored, currentDynamic);

        // 6. Apply changes to DB
        await this._applyChanges(changes, currentDynamic);

        // 7. Notify via Telegram
        await this._notify(changes, scored, Date.now() - startAt);

        this._log(`[Scout] ═══ SCOUT COMPLETE — ${changes.added.length} added, ${changes.removed.length} removed ═══`);
        return { ...changes, scored, durationMs: Date.now() - startAt };
    }

    /**
     * Get the current active watchlist (pinned + dynamic, deduped).
     * This is what getWatchlist() in index.js should call.
     * @returns {Promise<string[]>}
     */
    async getActiveWatchlist() {
        const dynamic = await this._loadDynamic();
        const combined = [...new Set([...this.pinnedSymbols, ...dynamic])];
        return combined;
    }

    /**
     * Get scores for all scanned symbols (for dashboard display).
     * @returns {Promise<Array>}
     */
    async getLatestScores() {
        try {
            const result = await query(
                `SELECT symbol, score, breakdown, action, scanned_at
         FROM symbol_scores
         WHERE scanned_at = (SELECT MAX(scanned_at) FROM symbol_scores)
         ORDER BY score DESC`
            );
            return result.rows;
        } catch { return []; }
    }

    // ── Private ────────────────────────────────────────────────────────────────

    async _scoreOne(symbol, signalStats, consecutiveLossCount) {
        try {
            const candles = await this._fetchDailyCandles(symbol);
            if (!candles || candles.length < 30) {
                this._log(`[Scout] ${symbol}: insufficient candles (${candles?.length || 0}) — skipping`);
                return null;
            }

            const result = scoreSymbol(candles, signalStats);
            const consLoss = consecutiveLossCount || 0;

            // Hard remove: 3+ consecutive losses overrides score
            const consecutiveLossHardFail = consLoss >= CONSEC_LOSS_LIMIT;

            const finalScore = result.hardFail || consecutiveLossHardFail
                ? Math.min(result.score, REMOVE_THRESHOLD - 1)
                : result.score;

            this._log(`[Scout] ${symbol}: ${finalScore}/100 | ` +
                `liq=${result.breakdown.liquidity.score} ` +
                `trend=${result.breakdown.trend.score} ` +
                `vol=${result.breakdown.volatility.score} ` +
                `mom=${result.breakdown.momentum.score} ` +
                `track=${result.breakdown.trackRecord.score}` +
                (result.hardFail ? ' [HARD_FAIL]' : '') +
                (consecutiveLossHardFail ? ' [CONSEC_LOSS]' : '')
            );

            return {
                symbol,
                score: finalScore,
                hardFail: result.hardFail || consecutiveLossHardFail,
                breakdown: {
                    ...result.breakdown,
                    consecutiveLosses: consLoss,
                },
            };
        } catch (err) {
            this._log(`[Scout] Failed to score ${symbol}: ${err.message}`);
            return null;
        }
    }

    _computeChanges(scored, currentDynamic) {
        // Sort by score descending
        const sortedScored = scored.filter(Boolean).sort((a, b) => b.score - a.score);

        // Symbols that should be in dynamic watchlist
        const shouldAdd = sortedScored
            .filter(s => s.score >= ADD_THRESHOLD && !this.pinnedSymbols.includes(s.symbol))
            .slice(0, this.maxDynamic)
            .map(s => s.symbol);

        // What's being added (new entries)
        const added = shouldAdd
            .filter(s => !currentDynamic.map(d => d.toUpperCase()).includes(s.toUpperCase()))
            .map(sym => {
                const s = sortedScored.find(x => x.symbol === sym);
                return { symbol: sym, score: s.score, reason: this._addReason(s) };
            });

        // What's being removed
        const removed = currentDynamic
            .filter(sym => {
                const upperSym = sym.toUpperCase();
                const s = sortedScored.find(x => x.symbol === upperSym);
                if (!s) return true; // wasn't even scanned / no data → remove
                if (s.hardFail) return true;
                if (s.score < REMOVE_THRESHOLD) return true;
                if (!shouldAdd.map(a => a.toUpperCase()).includes(upperSym) && currentDynamic.length > this.maxDynamic) return true;
                return false;
            })
            .map(sym => {
                const s = sortedScored.find(x => x.symbol === sym);
                return { symbol: sym, score: s?.score ?? 0, reason: this._removeReason(s) };
            });

        return { added, removed, shouldBe: shouldAdd };
    }

    async _applyChanges(changes, currentDynamic) {
        const newDynamic = [
            ...currentDynamic.filter(s => !changes.removed.map(r => r.symbol.toUpperCase()).includes(s.toUpperCase())),
            ...changes.added.map(a => a.symbol),
        ].slice(0, this.maxDynamic);

        // Write to settings table
        await this._saveDynamic(newDynamic);

        // Log each change to watchlist_log
        const ts = new Date().toISOString();
        for (const a of changes.added) {
            await this._logChange(a.symbol, 'ADDED', a.reason, a.score);
        }
        for (const r of changes.removed) {
            await this._logChange(r.symbol, 'REMOVED', r.reason, r.score);
        }

        // Write score snapshot to symbol_scores
        this._persistScores(changes).catch(() => { });
    }

    async _notify(changes, scored, durationMs) {
        if (!this.telegram?.enabled) return;

        const active = await this.getActiveWatchlist();
        const top5 = scored.filter(Boolean).sort((a, b) => b.score - a.score).slice(0, 5);

        let msg = `🔍 <b>Nightly Symbol Scout</b>\n`;
        msg += `📅 ${new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata', weekday: 'short', day: 'numeric', month: 'short' })}\n\n`;

        if (changes.added.length > 0) {
            msg += `<b>✅ Added to watchlist:</b>\n`;
            for (const a of changes.added) {
                msg += `  • <b>${a.symbol}</b> (score: ${a.score}/100) — ${a.reason}\n`;
            }
            msg += '\n';
        }

        if (changes.removed.length > 0) {
            msg += `<b>❌ Removed from watchlist:</b>\n`;
            for (const r of changes.removed) {
                msg += `  • <b>${r.symbol}</b> (score: ${r.score}/100) — ${r.reason}\n`;
            }
            msg += '\n';
        }

        if (changes.added.length === 0 && changes.removed.length === 0) {
            msg += `<i>No changes — watchlist is stable</i>\n\n`;
        }

        msg += `<b>📋 Active watchlist (${active.length}):</b> ${active.join(', ')}\n\n`;
        msg += `<b>🏆 Top 5 scores:</b>\n`;
        for (const s of top5) {
            const pinned = this.pinnedSymbols.includes(s.symbol) ? ' 📌' : '';
            msg += `  ${s.symbol}${pinned}: ${s.score}/100\n`;
        }

        msg += `\n<i>Scanned ${scored.length} symbols in ${(durationMs / 1000).toFixed(1)}s</i>`;

        try {
            await this.telegram.sendRaw(msg);
        } catch (err) {
            this._log(`[Scout] Telegram notification failed: ${err.message}`);
        }
    }

    _addReason(s) {
        if (!s) return 'passed scoring';
        const b = s.breakdown;
        const reasons = [];
        if (b.trend?.regime === 'BULLISH') reasons.push('bullish trend');
        if (b.momentum?.ret10d > 2) reasons.push(`+${b.momentum.ret10d}% 10d`);
        if (b.liquidity?.avgTurnoverCr > 50) reasons.push('high liquidity');
        if (b.trackRecord?.winRate > 60) reasons.push(`${b.trackRecord.winRate}% win rate`);
        return reasons.length > 0 ? reasons.join(', ') : `score ${s.score}`;
    }

    _removeReason(s) {
        if (!s) return 'no recent data';
        const b = s.breakdown;
        if (b.liquidity?.hardFail) return 'illiquid (turnover too low)';
        if (b.trend?.hardFail) return 'bearish trend';
        if ((b.consecutiveLosses || 0) >= CONSEC_LOSS_LIMIT) return `${b.consecutiveLosses} consecutive losses`;
        if (s.score < REMOVE_THRESHOLD) return `score dropped to ${s.score}/100`;
        return `score ${s.score} — better candidates available`;
    }

    async _fetchDailyCandles(symbol) {
        const to = new Date();
        const from = new Date();
        from.setDate(from.getDate() - SCAN_HISTORY_DAYS);
        const fmt = d => d.toISOString().split('T')[0];

        return fetchHistoricalData({
            broker: this.broker,    // null → Yahoo Finance fallback
            symbol,
            instrumentToken: null,    // Yahoo Finance doesn't need a token
            interval: 'day',
            from: fmt(from),
            to: fmt(to),
            cacheTTL: 8 * 3600,       // 8h cache — nightly scan only
        });
    }

    async _fetchTrackRecords(symbols) {
        try {
            const result = await query(
                `SELECT symbol,
                COUNT(*) FILTER (WHERE outcome='WIN')  AS wins,
                COUNT(*)                               AS total
         FROM   signal_outcomes
         WHERE  symbol = ANY($1)
           AND  recorded_at > NOW() - INTERVAL '30 days'
         GROUP  BY symbol`,
                [symbols]
            );
            const map = {};
            for (const r of result.rows) {
                map[r.symbol] = { wins: parseInt(r.wins), total: parseInt(r.total) };
            }
            return map;
        } catch { return {}; }
    }

    /**
 * FIXED METHOD: _fetchConsecutiveLosses()
 *
 * Replace the existing _fetchConsecutiveLosses method in src/intelligence/symbol-scout.js
 * with this version.
 *
 * BUG: The original query used SELECT DISTINCT ON (symbol) on the outer query
 * without a matching ORDER BY clause in the outer query. DISTINCT ON requires
 * ORDER BY to start with the same column for deterministic results. Without it,
 * PostgreSQL selects an arbitrary row per symbol, making consecutive loss counts
 * non-deterministic.
 *
 * FIX: Removed the outer DISTINCT ON wrapper entirely. The inner query already
 * groups by symbol via ARRAY_AGG, so each symbol produces exactly one row —
 * DISTINCT ON was redundant and harmful.
 */

    async _fetchConsecutiveLosses(symbols) {
        try {
            // FIX: Removed the erroneous outer SELECT DISTINCT ON (symbol) wrapper.
            // The inner query already produces one row per symbol via GROUP BY symbol.
            // DISTINCT ON without a matching ORDER BY was selecting an arbitrary row.
            const result = await query(
                `SELECT
         symbol,
         ARRAY_AGG(outcome ORDER BY recorded_at DESC) AS outcomes
       FROM signal_outcomes
       WHERE symbol = ANY($1)
         AND recorded_at > NOW() - INTERVAL '14 days'
       GROUP BY symbol`,
                [symbols]
            );

            const map = {};
            for (const r of result.rows) {
                let count = 0;
                for (const o of (r.outcomes || [])) {
                    if (o === 'LOSS') count++;
                    else break; // stop at first non-loss
                }
                map[r.symbol] = count;
            }
            return map;
        } catch {
            return {};
        }
    }

    async _loadDynamic() {
        try {
            const result = await query(
                `SELECT value FROM settings WHERE key = $1`,
                [DB_KEY_DYNAMIC]
            );
            return result.rows[0] ? JSON.parse(result.rows[0].value) : [];
        } catch { return []; }
    }

    async _saveDynamic(symbols) {
        try {
            await query(
                `INSERT INTO settings (key, value, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (key) DO UPDATE SET value=$2, updated_at=NOW()`,
                [DB_KEY_DYNAMIC, JSON.stringify(symbols)]
            );
        } catch (err) {
            this._log(`[Scout] Failed to save dynamic watchlist: ${err.message}`);
        }
    }

    async _logChange(symbol, action, reason, score) {
        try {
            await query(
                `INSERT INTO watchlist_log (symbol, action, reason, score, logged_at)
                 SELECT $1, $2, $3, $4, NOW()
                 WHERE NOT EXISTS (
                     SELECT 1 FROM watchlist_log 
                     WHERE symbol = $1 
                       AND action = $2 
                       AND logged_at >= CURRENT_DATE
                 )`,
                [symbol, action, reason, score]
            );
        } catch { /* non-critical */ }
    }

    async _persistScores(changes) {
        try {
            // Bulk insert scored results
            for (const s of (changes.scored || [])) {
                if (!s) continue;
                await query(
                    `INSERT INTO symbol_scores (symbol, score, breakdown, scanned_at)
           VALUES ($1, $2, $3, NOW())`,
                    [s.symbol, s.score, JSON.stringify(s.breakdown)]
                );
            }
        } catch { /* non-critical */ }
    }

    _delay(ms) { return new Promise(r => setTimeout(r, ms)); }
}