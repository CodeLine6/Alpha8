/**
 * @fileoverview News Sentiment Filter for Quant8
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
 * AI:          Claude API (claude-haiku-4-5-20251001 — cheapest, ~₹1-2/day)
 *
 * FAIL-OPEN: Any failure (network, API) allows the signal through.
 *            A missing news filter is better than blocking valid trades.
 */

import { createLogger } from '../lib/logger.js';

const log = createLogger('news-sentiment');

// NOTE: Redis keyPrefix 'quant8:' is applied automatically — don't add it here
const NEWS_CACHE_PREFIX = 'news:sentiment:';
const BLOCK_CACHE_PREFIX = 'news:blocked:';
const NEWS_CACHE_TTL_SEC = 30 * 60;     // 30 min — refresh headlines
const BLOCK_TTL_SEC = 4 * 60 * 60; // 4 hours — hold negative block
const MAX_HEADLINES = 5;
const CLAUDE_MODEL = 'claude-haiku-4-5-20251001';

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
        headers: { 'User-Agent': 'Mozilla/5.0 (Quant8/1.0)' },
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
 * Classify headlines using Claude API.
 * Returns sentiment, score (-100 to +100), and a brief summary.
 * @param {string}   symbol
 * @param {string[]} headlines
 * @param {string}   apiKey - ANTHROPIC_API_KEY
 */
export async function classifySentiment(symbol, headlines, apiKey) {
    if (!headlines || headlines.length === 0) {
        return { sentiment: 'NEUTRAL', score: 0, summary: 'No headlines available' };
    }

    const headlineText = headlines.map((h, i) => `${i + 1}. ${h}`).join('\n');

    const prompt =
        `You are analyzing news headlines about ${symbol} (Indian stock market, NSE/BSE) ` +
        `to determine if they would positively or negatively impact the stock price TODAY.\n\n` +
        `Headlines:\n${headlineText}\n\n` +
        `Respond ONLY with this exact JSON (no markdown, no preamble):\n` +
        `{"sentiment":"POSITIVE|NEGATIVE|NEUTRAL","score":-100_to_100,"summary":"max 20 words"}\n\n` +
        `NEGATIVE (-100 to -20): fraud, lawsuit, major loss, CEO resign, regulatory action, earnings miss\n` +
        `POSITIVE (20 to 100): record profit, new contract, upgrade, buyback, strong results\n` +
        `NEUTRAL (-19 to 19): routine news, analyst commentary, general market news`;

    const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'x-api-key': apiKey,
            'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
            model: CLAUDE_MODEL,
            max_tokens: 100,
            messages: [{ role: 'user', content: prompt }],
        }),
        signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) throw new Error(`Claude API ${resp.status}: ${await resp.text().then(t => t.slice(0, 100))}`);

    const data = await resp.json();
    const text = data.content?.[0]?.text ?? '{}';

    try {
        const parsed = JSON.parse(text.replace(/```json|```/g, '').trim());
        return {
            sentiment: parsed.sentiment ?? 'NEUTRAL',
            score: Number(parsed.score ?? 0),
            summary: parsed.summary ?? 'No summary',
        };
    } catch {
        throw new Error(`Unparseable Claude response: ${text.slice(0, 80)}`);
    }
}

export class NewsSentimentFilter {
    /**
     * @param {object} opts
     * @param {object}   opts.redis
     * @param {string}   [opts.anthropicApiKey]  - from ANTHROPIC_API_KEY env var
     * @param {Function} [opts.logger]
     */
    constructor({ redis, anthropicApiKey, logger }) {
        this.redis = redis;
        this.apiKey = anthropicApiKey;
        this.logger = logger || ((msg, meta) => log.info(meta || {}, msg));
        this.enabled = !!anthropicApiKey;

        if (!this.enabled) {
            this.logger('[NewsSentimentFilter] Disabled — no ANTHROPIC_API_KEY set');
        }
    }

    /**
     * Main gate. Call once per BUY signal.
     * @param {string} symbol
     * @param {'BUY'|'SELL'|'HOLD'} signal
     * @returns {Promise<{ allowed: boolean, confidenceBoost: number, reason: string }>}
     */
    async check(symbol, signal) {
        if (signal !== 'BUY') {
            return { allowed: true, confidenceBoost: 0, reason: `${signal} passes news filter` };
        }

        if (!this.enabled) {
            return { allowed: true, confidenceBoost: 0, reason: 'News filter disabled (no API key)' };
        }

        // Check for active block first (fast path)
        if (await this._isBlocked(symbol)) {
            return {
                allowed: false,
                confidenceBoost: 0,
                reason: `${symbol} BUY blocked — negative news detected earlier today`,
            };
        }

        const result = await this._getOrFetch(symbol);

        if (result.sentiment === 'NEGATIVE' && result.score <= -20) {
            await this._blockSymbol(symbol, result.summary);
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

    async _blockSymbol(symbol, reason) {
        try {
            await this.redis.setex(`${BLOCK_CACHE_PREFIX}${symbol}`, BLOCK_TTL_SEC, reason);
            this.logger(`[NewsSentimentFilter] ⛔ ${symbol} blocked 4h: ${reason}`);
        } catch (err) {
            this.logger(`[NewsSentimentFilter] Failed to block ${symbol}: ${err.message}`);
        }
    }
}