/**
 * @fileoverview News Sentiment Filter for Alpha8
 *
 * Before acting on a BUY signal, fetches the latest headlines for that
 * stock from Google News RSS and asks Claude API to classify sentiment.
 *
 *   NEGATIVE news → BUY blocked for 4 hours
 *   POSITIVE news → BUY confidence boosted slightly
 *   NEUTRAL  news → no change
 *
 * This closes the "blind to the outside world" gap. The algorithms only
 * see charts — they can't know about fraud announcements, earnings misses,
 * or regulatory actions that will tank a stock regardless of what the
 * technical indicators say.
 *
 * DATA SOURCE: Google News RSS (free, no API key)
 * AI:          Google Gemini API (gemini-2.5-flash)
 *
 * FAIL-OPEN: Any failure (network, API) allows the signal through.
 *            A missing news filter is better than blocking valid trades.
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('news-sentiment');

// NOTE: Redis keyPrefix 'alpha8:' is applied automatically — don't add it here
const NEWS_CACHE_PREFIX = 'news:sentiment:';
const BLOCK_CACHE_PREFIX = 'news:blocked:';
const NEWS_CACHE_TTL_SEC = 30 * 60;     // 30 min — refresh headlines
const BLOCK_TTL_SEC = 4 * 60 * 60; // 4 hours — hold negative block
const MAX_HEADLINES = 5;
const GEMINI_MODEL = 'gemini-3.1-flash-lite-preview';

/**
 * Fetch news headlines from Google News RSS.
 * No API key required.
 * @param {string} symbol - NSE symbol e.g. 'RELIANCE'
 * @param {number} max
 * @returns {Promise<string[]>}
 */
export async function fetchNewsHeadlines(symbol, max = MAX_HEADLINES) {
    const query = encodeURIComponent(`${symbol} NSE stock India`);
    const url = `https://news.google.com/rss/search?q=${query}&hl=en-IN&gl=IN&ceid=IN:en`;

    const resp = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Alpha8/1.0)' },
        signal: AbortSignal.timeout(5000),
    });

    if (!resp.ok) throw new Error(`Google News RSS HTTP ${resp.status}`);

    const xml = await resp.text();
    const cdata = [...xml.matchAll(/<item>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>/g)].map(m => m[1].trim());
    if (cdata.length > 0) return cdata.slice(0, max);

    const plain = [...xml.matchAll(/<item>[\s\S]*?<title>(.*?)<\/title>/g)]
        .map(m => m[1].replace(/<[^>]+>/g, '').trim());
    return plain.slice(0, max).filter(Boolean);
}

/**
 * Classify headlines using Gemini API.
 * Returns sentiment, score (-100 to +100), and a brief summary.
 * @param {string}   symbol
 * @param {string[]} headlines
 * @param {string}   apiKey - GEMINI_API_KEY
 */
export async function classifySentiment(symbol, headlines, apiKey) {
    if (!headlines || headlines.length === 0) {
        return { sentiment: 'NEUTRAL', score: 0, summary: 'No headlines available' };
    }

    const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

    const prompt = `Headlines:\n${headlineText}`;

    const today = new Date().toLocaleDateString('en-IN', { timeZone: 'Asia/Kolkata' });
    const systemInstruction =
        `You are a senior equity analyst specializing in Indian stock markets (NSE/BSE).
Today's date: ${today}

Your job: Given news headlines about ${symbol}, output a JSON sentiment score that predicts SHORT-TERM price impact within the SAME trading session.

SCORING RULES:
- Score range: -100 to +100
- NEGATIVE (score -100 to -20): fraud allegations, SEBI action, earnings miss, promoter selling, CEO resignation, major lawsuit, credit downgrade, plant shutdown
- NEUTRAL (score -19 to +19): routine filings, analyst initiations, general sector news, unrelated market commentary
- POSITIVE (score +20 to +100): record quarterly profit, large order win, RBI approval, FII buying, buyback announcement, rating upgrade, major contract

INDIAN MARKET CONTEXT — weight these heavily:
- SEBI/RBI regulatory action = -80 to -100
- Promoter pledge/sell = -40 to -70  
- Results beat with guidance raise = +60 to +90
- Block deal (buyer known) = +20 to +40

CALIBRATION EXAMPLES:
Headlines: ["Adani Group faces SEBI probe into related party transactions"]
Output: {"sentiment":"NEGATIVE","score":-85,"summary":"SEBI probe creates regulatory risk"}

Headlines: ["Reliance Industries Q3 profit up 18% YoY, beats estimates"]  
Output: {"sentiment":"POSITIVE","score":72,"summary":"Strong earnings beat drives optimism"}

Headlines: ["TCS to attend Goldman Sachs tech conference next week"]
Output: {"sentiment":"NEUTRAL","score":5,"summary":"Routine investor relations activity"}

OUTPUT FORMAT — respond ONLY with valid JSON, no markdown:
{"sentiment":"POSITIVE|NEGATIVE|NEUTRAL","score":-100_to_100,"summary":"max 15 words"}`;
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${apiKey}`;
    const resp = await fetch(url, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
        },
        body: JSON.stringify({
            systemInstruction: { parts: [{ text: systemInstruction }] },
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: 100
            }
        }),
        signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) throw new Error(`Gemini API ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);

    const data = await resp.json();
    const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? '{}';

    try {
        const jsonMatch = text.match(/\{[\s\S]*?\}/);
        if (!jsonMatch) throw new Error('No JSON object found in response');

        const parsed = JSON.parse(jsonMatch[0].trim());
        return {
            sentiment: parsed.sentiment ?? 'NEUTRAL',
            score: Number(parsed.score ?? 0),
            summary: parsed.summary ?? 'No summary',
        };
    } catch (err) {
        throw new Error(`Unparseable Gemini response: ${text.slice(0, 80)}`, { cause: text });
    }
}

export class NewsSentimentFilter {
    /**
     * @param {object} opts
     * @param {object}   opts.redis
     * @param {string}   [opts.geminiApiKey]  - from GEMINI_API_KEY env var
     * @param {Function} [opts.logger]
     */
    constructor({ redis, geminiApiKey, logger }) {
        this.redis = redis;
        this.apiKey = geminiApiKey;
        this.logger = logger || ((msg, meta) => log.info(meta || {}, msg));
        this.enabled = !!geminiApiKey;

        if (!this.enabled) {
            this.logger('[NewsSentimentFilter] Disabled — no GEMINI_API_KEY set');
        }
    }

    /**
     * Main gate. Call once per BUY signal.
     * @param {string} symbol
     * @param {'BUY'|'SELL'|'HOLD'} signal
     * @returns {Promise<{ allowed: boolean, confidenceBoost: number, reason: string }>}
     */
    async check(symbol, signal) {
        if (signal === 'HOLD') {
            return { allowed: true, confidenceBoost: 0, reason: `HOLD passes news filter` };
        }

        if (!this.enabled) {
            return { allowed: true, confidenceBoost: 0, reason: 'News filter disabled (no API key)' };
        }

        // Check for active block first (fast path for BUYs)
        if (signal === 'BUY' && await this._isBlocked(symbol)) {
            return {
                allowed: false,
                confidenceBoost: 0,
                reason: `${symbol} BUY blocked — negative news detected earlier today`,
            };
        }

        const result = await this._getOrFetch(symbol);

        if (signal === 'BUY') {
            if (result.sentiment === 'NEGATIVE' && result.score <= -20) {
                const blockHours = result.score <= -60 ? 8 : result.score <= -40 ? 6 : 4;
                await this._blockSymbol(symbol, result.summary, blockHours * 3600);
                return {
                    allowed: false,
                    confidenceBoost: 0,
                    reason: `${symbol} BUY blocked — negative news: ${result.summary}`,
                };
            }

            const confidenceBoost = (result.sentiment === 'POSITIVE' && result.score >= 30)
                ? Math.min(15, Math.floor(result.score / 5))
                : 0;

            const reason = confidenceBoost > 0
                ? `${symbol} news POSITIVE (+${confidenceBoost} confidence): ${result.summary}`
                : `${symbol} news NEUTRAL — no adjustment`;

            return { allowed: true, confidenceBoost, reason };
        }

        if (signal === 'SELL') {
            if (result.sentiment === 'NEGATIVE' && result.score <= -20) {
                // Boost short confidence significantly on negative news
                // E.g., score -80 --> +40 boost. Max +40.
                const confidenceBoost = Math.min(40, Math.floor(Math.abs(result.score) / 2));
                return {
                    allowed: true,
                    confidenceBoost,
                    reason: `🔥🚨 ${symbol} news HIGHLY NEGATIVE (+${confidenceBoost} short confidence): ${result.summary}`,
                };
            }

            if (result.sentiment === 'POSITIVE' && result.score >= 30) {
                return { allowed: true, confidenceBoost: 0, reason: `⚠️ ${symbol} news POSITIVE — no short boost` };
            }

            return { allowed: true, confidenceBoost: 0, reason: `${symbol} news NEUTRAL — no adjustment` };
        }
    }

    /** Manually unblock a symbol (e.g. from dashboard). */
    async unblock(symbol) {
        try {
            await this.redis.del(`${BLOCK_CACHE_PREFIX}${symbol}`);
            this.logger(`[NewsSentimentFilter] ✅ ${symbol} manually unblocked`);
        } catch (err) {
            this.logger(`[NewsSentimentFilter] Failed to unblock ${symbol}: ${err.message}`);
        }
    }

    // ── Private ──────────────────────────────────────────────────────────────

    async _getOrFetch(symbol) {
        const key = `${NEWS_CACHE_PREFIX}${symbol}`;
        try {
            const cached = await this.redis.get(key);
            if (cached) return JSON.parse(cached);
        } catch { /* cache miss */ }

        try {
            const headlines = await fetchNewsHeadlines(symbol);
            const result = await classifySentiment(symbol, headlines, this.apiKey);
            const val = { ...result, headlines, updatedAt: new Date().toISOString() };

            await this.redis.setex(key, NEWS_CACHE_TTL_SEC, JSON.stringify(val));
            this.logger(`[NewsSentimentFilter] ${symbol}: ${result.sentiment} (${result.score}) — ${result.summary}`);
            return val;
        } catch (err) {
            this.logger(`[NewsSentimentFilter] Failed for ${symbol}: ${err.message} — allowing (fail-open)`);
            return { sentiment: 'NEUTRAL', score: 0, summary: 'Fetch failed' };
        }
    }

    async _isBlocked(symbol) {
        try {
            return !!(await this.redis.get(`${BLOCK_CACHE_PREFIX}${symbol}`));
        } catch { return false; }
    }

    async _blockSymbol(symbol, reason, ttl = BLOCK_TTL_SEC) {
        try {
            await this.redis.setex(`${BLOCK_CACHE_PREFIX}${symbol}`, ttl, reason);
            const hours = Math.round(ttl / 3600);
            this.logger(`[NewsSentimentFilter] ⛔ ${symbol} blocked ${hours}h: ${reason}`);
        } catch (err) {
            this.logger(`[NewsSentimentFilter] Failed to block ${symbol}: ${err.message}`);
        }
    }
}