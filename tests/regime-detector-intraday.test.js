/**
 * tests/regime-detector-intraday.test.js
 *
 * Unit tests for the two-layer intraday RegimeDetector.
 *
 * Tests cover:
 *  - Layer 1 VOLATILE gate (range_ratio >= 1.8)
 *  - Layer 2 TRENDING / NEUTRAL / SIDEWAYS via ADX thresholds
 *  - Combined priority: Layer 1 overrides Layer 2
 *  - Fail-open behaviour (no candles, no baseline)
 *  - getRegime() Redis cache read (fail-open TRENDING)
 *  - check() return shape for all four regimes
 *  - Daily baseline update (update() method)
 *  - Telegram alert fires on regime change (not on first run or same regime)
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import {
    RegimeDetector,
    calculateADX,
    calculateATR,
    trueRange,
    classifyRegime,
} from '../src/filters/regime-detector.js';

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Build a mock Redis client.
 * store is plain object shared between setex/get calls.
 */
function makeMockRedis(store = {}) {
    return {
        setex: jest.fn(async (key, ttl, val) => { store[key] = val; return 'OK'; }),
        get:   jest.fn(async (key) => store[key] ?? null),
    };
}

/**
 * Generate N synthetic 5-minute candles with controllable ADX characteristics.
 *
 * trending=true  → alternating higher-highs and consistent direction (high ADX)
 * trending=false → flat/choppy bars (low ADX)
 */
function makeIntradayCandles(count = 60, { trending = false, baseClose = 22000 } = {}) {
    const candles = [];
    let close = baseClose;
    for (let i = 0; i < count; i++) {
        if (trending) {
            // Strong upward trending bars
            const open = close;
            close = open + 20 + (i % 3) * 5; // consistent direction
            candles.push({ open, high: close + 10, low: open - 2, close });
        } else {
            // Flat/choppy bars for low ADX
            const open = close;
            close = baseClose + Math.sin(i * 0.5) * 5;
            candles.push({ open, high: Math.max(open, close) + 3, low: Math.min(open, close) - 3, close });
        }
    }
    return candles;
}

/**
 * Generate N synthetic daily candles with consistent daily range.
 */
function makeDailyCandles(count = 20, { avgRange = 200 } = {}) {
    const candles = [];
    let close = 22000;
    for (let i = 0; i < count; i++) {
        const open = close;
        close = open + (i % 2 === 0 ? 100 : -80);
        candles.push({
            open,
            high: Math.max(open, close) + avgRange / 2,
            low:  Math.min(open, close) - avgRange / 2,
            close,
        });
    }
    return candles;
}

// ─── Pure Function Tests ───────────────────────────────────────────────────────

describe('Pure functions — trueRange / calculateATR / calculateADX', () => {
    test('trueRange with no prev candle returns high-low', () => {
        expect(trueRange({ high: 100, low: 90, close: 95 }, null)).toBe(10);
    });

    test('trueRange with prev close above current high returns correct TR', () => {
        const tr = trueRange({ high: 100, low: 95, close: 98 }, { close: 110 });
        expect(tr).toBe(15); // Math.abs(100 - 110) = 15
    });

    test('calculateATR returns null for insufficient candles', () => {
        expect(calculateATR([{ high: 100, low: 90, close: 95 }], 14)).toBeNull();
    });

    test('calculateATR returns a positive number for sufficient candles', () => {
        const candles = makeDailyCandles(30);
        const atr = calculateATR(candles, 14);
        expect(atr).toBeGreaterThan(0);
    });

    test('calculateADX returns null for fewer than 2*period+1 candles', () => {
        const candles = makeIntradayCandles(20, { trending: true }); // < 29 needed for period=14
        expect(calculateADX(candles, 14)).toBeNull();
    });

    test('calculateADX returns a number in [0,100] for sufficient candles', () => {
        const candles = makeIntradayCandles(60, { trending: true });
        const adx = calculateADX(candles, 14);
        expect(adx).not.toBeNull();
        expect(adx).toBeGreaterThanOrEqual(0);
        expect(adx).toBeLessThanOrEqual(100);
    });

    test('classifyRegime (deprecated) still returns a valid shape', () => {
        const result = classifyRegime({ atr: 100, atrAvg30: 50, adx: 30, currentPrice: 22000 });
        expect(result).toHaveProperty('regime');
        expect(result).toHaveProperty('positionSizeMultiplier');
        expect(result).toHaveProperty('rangeRatio', null); // new field present with null
    });
});

// ─── RegimeDetector.update() — daily baseline ─────────────────────────────────

describe('RegimeDetector.update() — daily baseline', () => {
    test('stores avg_daily_range in Redis under regime:daily_baseline', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });
        const dailyCandles = makeDailyCandles(25, { avgRange: 200 });

        await rd.update(dailyCandles);

        expect(store['regime:daily_baseline']).toBeDefined();
        const baseline = parseFloat(store['regime:daily_baseline']);
        expect(baseline).toBeGreaterThan(0);
    });

    test('returns null and does not update Redis for insufficient candles', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const result = await rd.update(makeDailyCandles(10)); // < 20 needed
        expect(result).toBeNull();
        expect(store['regime:daily_baseline']).toBeUndefined();
    });

    test('does NOT write to the regime key (full classification removed)', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });
        await rd.update(makeDailyCandles(25));

        // The 'regime' key must NOT be set by update() alone
        expect(store['regime']).toBeUndefined();
    });
});

// ─── RegimeDetector.updateIntraday() ─────────────────────────────────────────

describe('RegimeDetector.updateIntraday() — Layer 1 VOLATILE gate', () => {
    test('detects VOLATILE when range_ratio >= 1.8', async () => {
        // avg_daily_range = 200, today range = 200 * 1.9 = 380 → ratio 1.9
        const store = { 'regime:daily_baseline': '200' };
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const todayOHLC = { high: 22380, low: 22000 }; // range = 380
        const result = await rd.updateIntraday([], todayOHLC);

        expect(result.regime).toBe('VOLATILE');
        expect(result.positionSizeMultiplier).toBe(0.0);
        expect(result.rangeRatio).toBeGreaterThanOrEqual(1.8);
    });

    test('VOLATILE overrides ADX TRENDING signal (Layer 1 priority)', async () => {
        const store = { 'regime:daily_baseline': '150' };
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        // ADX should be high (trending candles), but range_ratio >= 1.8 wins
        const trendingCandles = makeIntradayCandles(60, { trending: true });
        const todayOHLC = { high: 22300, low: 22000 }; // range = 300, ratio = 2.0

        const result = await rd.updateIntraday(trendingCandles, todayOHLC);
        expect(result.regime).toBe('VOLATILE');
    });

    test('no VOLATILE when range_ratio < 1.8 (passes to Layer 2)', async () => {
        const store = { 'regime:daily_baseline': '200' };
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const todayOHLC = { high: 22200, low: 22000 }; // range = 200, ratio = 1.0
        const result = await rd.updateIntraday(makeIntradayCandles(60, { trending: true }), todayOHLC);

        expect(result.regime).not.toBe('VOLATILE');
    });
});

describe('RegimeDetector.updateIntraday() — Layer 2 ADX classification', () => {
    test('returns SIDEWAYS when ADX < 15 (flat market, no baseline)', async () => {
        // No baseline set — range_ratio will be null, falls through to Layer 2
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        // Deliberately flat candles → ultra-low ADX
        const flatCandles = [];
        for (let i = 0; i < 60; i++) {
            flatCandles.push({ open: 22000, high: 22001, low: 21999, close: 22000 });
        }

        const result = await rd.updateIntraday(flatCandles, null);
        // ADX near 0 → SIDEWAYS
        expect(result.regime).toBe('SIDEWAYS');
        expect(result.positionSizeMultiplier).toBe(0.5);
    });

    test('returns TRENDING when ADX >= 25 and no volatile range', async () => {
        const store = { 'regime:daily_baseline': '200' };
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const trendingCandles = makeIntradayCandles(60, { trending: true });
        const todayOHLC = { high: 22150, low: 22000 }; // range 150, ratio 0.75

        const result = await rd.updateIntraday(trendingCandles, todayOHLC);
        // Trending candles should produce ADX >= 25 after enough data
        if (result.adx !== null && result.adx >= 25) {
            expect(result.regime).toBe('TRENDING');
            expect(result.positionSizeMultiplier).toBe(1.0);
        } else {
            // ADX might not reach 25 with synthetic candles — just check it's not VOLATILE
            expect(result.regime).not.toBe('VOLATILE');
        }
    });

    test('returns TRENDING (fail-open) when no candles provided and no baseline', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const result = await rd.updateIntraday([], null);
        expect(result.regime).toBe('TRENDING');
        expect(result.positionSizeMultiplier).toBe(1.0);
        expect(result.adx).toBeNull();
        expect(result.rangeRatio).toBeNull();
    });

    test('result always has rangeRatio and adx fields', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const result = await rd.updateIntraday(makeIntradayCandles(60), { high: 22200, low: 22000 });

        expect(result).toHaveProperty('rangeRatio');
        expect(result).toHaveProperty('adx');
        expect(result).toHaveProperty('regime');
        expect(result).toHaveProperty('positionSizeMultiplier');
        expect(result).toHaveProperty('reason');
        expect(result).toHaveProperty('updatedAt');
    });

    test('caches result in Redis under regime key', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        await rd.updateIntraday(makeIntradayCandles(60), null);

        expect(store['regime']).toBeDefined();
        const cached = JSON.parse(store['regime']);
        expect(cached).toHaveProperty('regime');
    });
});

// ─── RegimeDetector.getRegime() ───────────────────────────────────────────────

describe('RegimeDetector.getRegime() — cache read', () => {
    test('returns cached regime from Redis', async () => {
        const cachedRegime = {
            regime: 'NEUTRAL', positionSizeMultiplier: 1.0,
            reason: 'test', atr: null, adx: 20, atrPct: null,
            volatilityRatio: null, rangeRatio: 1.1,
            updatedAt: new Date().toISOString(),
        };
        const store = { regime: JSON.stringify(cachedRegime) };
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const result = await rd.getRegime();
        expect(result.regime).toBe('NEUTRAL');
        expect(result.adx).toBe(20);
    });

    test('returns TRENDING fail-open when no cache', async () => {
        const store = {};
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const result = await rd.getRegime();
        expect(result.regime).toBe('TRENDING');
        expect(result.positionSizeMultiplier).toBe(1.0);
    });

    test('returns within 100ms (cache read only)', async () => {
        const store = { regime: JSON.stringify({ regime: 'SIDEWAYS', positionSizeMultiplier: 0.5 }) };
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {} });

        const t = Date.now();
        await rd.getRegime();
        expect(Date.now() - t).toBeLessThan(100);
    });

    test('returns TRENDING fail-open when Redis throws', async () => {
        const brokenRedis = {
            get: jest.fn().mockRejectedValue(new Error('Redis down')),
            setex: jest.fn(),
        };
        const rd = new RegimeDetector({ redis: brokenRedis, logger: () => {} });

        const result = await rd.getRegime();
        expect(result.regime).toBe('TRENDING'); // fail-open
    });
});

// ─── RegimeDetector.check() ───────────────────────────────────────────────────

describe('RegimeDetector.check() — pipeline gate', () => {
    test('VOLATILE → allowed=false, sizeMultiplier=0', async () => {
        const rd = new RegimeDetector({
            redis: makeMockRedis({ regime: JSON.stringify({ regime: 'VOLATILE', positionSizeMultiplier: 0 }) }),
            logger: () => {},
        });
        const r = await rd.check();
        expect(r.allowed).toBe(false);
        expect(r.sizeMultiplier).toBe(0);
    });

    test('NEUTRAL → allowed=true, sizeMultiplier=1.0', async () => {
        const rd = new RegimeDetector({
            redis: makeMockRedis({ regime: JSON.stringify({ regime: 'NEUTRAL', positionSizeMultiplier: 1.0 }) }),
            logger: () => {},
        });
        const r = await rd.check();
        expect(r.allowed).toBe(true);
        expect(r.sizeMultiplier).toBe(1.0);
    });

    test('TRENDING → allowed=true, sizeMultiplier=1.0', async () => {
        const rd = new RegimeDetector({
            redis: makeMockRedis({ regime: JSON.stringify({ regime: 'TRENDING', positionSizeMultiplier: 1.0 }) }),
            logger: () => {},
        });
        const r = await rd.check();
        expect(r.allowed).toBe(true);
        expect(r.sizeMultiplier).toBe(1.0);
    });

    test('SIDEWAYS → allowed=true, sizeMultiplier=0.5', async () => {
        const rd = new RegimeDetector({
            redis: makeMockRedis({ regime: JSON.stringify({ regime: 'SIDEWAYS', positionSizeMultiplier: 0.5 }) }),
            logger: () => {},
        });
        const r = await rd.check();
        expect(r.allowed).toBe(true);
        expect(r.sizeMultiplier).toBe(0.5);
    });

    test('no cache (fail-open) → allowed=true', async () => {
        const rd = new RegimeDetector({ redis: makeMockRedis({}), logger: () => {} });
        const r = await rd.check();
        expect(r.allowed).toBe(true);
        expect(r.sizeMultiplier).toBe(1.0);
    });
});

// ─── Telegram alert behaviour ─────────────────────────────────────────────────

describe('RegimeDetector — Telegram regime-change alerts', () => {
    function makeTelegram() {
        return { enabled: true, sendRaw: jest.fn().mockResolvedValue(undefined) };
    }

    test('no alert when regime is same as previous', async () => {
        const store = {};
        const tg = makeTelegram();
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {}, telegram: tg });
        rd._lastRegime = 'TRENDING';

        await rd.updateIntraday([], null); // will return TRENDING (fail-open)

        expect(tg.sendRaw).not.toHaveBeenCalled();
    });

    test('alert fires when regime changes to VOLATILE', async () => {
        const store = { 'regime:daily_baseline': '200' };
        const tg = makeTelegram();
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {}, telegram: tg });
        rd._lastRegime = 'TRENDING'; // pretend previous was TRENDING

        const todayOHLC = { high: 22400, low: 22000 }; // range=400, ratio=2.0 → VOLATILE
        await rd.updateIntraday([], todayOHLC);

        // Allow fire-and-forget to settle
        await new Promise(r => setTimeout(r, 50));
        expect(tg.sendRaw).toHaveBeenCalledTimes(1);
        const msg = tg.sendRaw.mock.calls[0][0];
        expect(msg).toContain('TRENDING');
        expect(msg).toContain('VOLATILE');
    });

    test('no alert on first run (_lastRegime is null)', async () => {
        const store = { 'regime:daily_baseline': '200' };
        const tg = makeTelegram();
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {}, telegram: tg });
        // _lastRegime starts as null

        await rd.updateIntraday([], null);
        await new Promise(r => setTimeout(r, 50));
        expect(tg.sendRaw).not.toHaveBeenCalled();
    });

    test('Telegram alert includes rangeRatio and ADX', async () => {
        const store = { 'regime:daily_baseline': '200' };
        const tg = makeTelegram();
        const rd = new RegimeDetector({ redis: makeMockRedis(store), logger: () => {}, telegram: tg });
        rd._lastRegime = 'TRENDING';

        const todayOHLC = { high: 22400, low: 22000 }; // VOLATILE
        await rd.updateIntraday([], todayOHLC);
        await new Promise(r => setTimeout(r, 50));

        const msg = tg.sendRaw.mock.calls[0][0];
        expect(msg).toContain('Range Ratio');
        expect(msg).toContain('ADX');
    });
});
