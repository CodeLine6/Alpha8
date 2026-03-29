/**
 * tests/simulator.test.js
 *
 * Unit tests for the Alpha8 market simulator components.
 * Tests:
 *   1. PriceEngine — tick output shape and OHLCV consistency
 *   2. Binary packet encoding — readable by tick-feed._parseBinaryTicks
 *   3. simulator/instruments-db — symbol↔token round-trip
 *   4. simulator/data-seeder — GBM parameter computation
 */

import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';

// ─────────────────────────────────────────────────────────────────────────────
// 1. instruments-db
// ─────────────────────────────────────────────────────────────────────────────
describe('instruments-db', () => {
  let db;

  beforeEach(async () => {
    db = await import('../simulator/instruments-db.js');
  });

  it('should have at least 10 symbols', () => {
    expect(db.INSTRUMENTS.length).toBeGreaterThanOrEqual(10);
  });

  it('symbolToToken should return a positive integer for RELIANCE', () => {
    const token = db.symbolToToken('RELIANCE');
    expect(typeof token).toBe('number');
    expect(token).toBeGreaterThan(0);
  });

  it('tokenToSymbol should round-trip for RELIANCE', () => {
    const token = db.symbolToToken('RELIANCE');
    expect(db.tokenToSymbol(token)).toBe('RELIANCE');
  });

  it('getKiteInstrumentList should include instrument_token and tradingsymbol', () => {
    const list = db.getKiteInstrumentList();
    expect(Array.isArray(list)).toBe(true);
    const rel = list.find(i => i.tradingsymbol === 'RELIANCE');
    expect(rel).toBeDefined();
    expect(rel.instrument_token).toBeGreaterThan(0);
    expect(rel.exchange).toBe('NSE');
  });

  it('buildSymbolMap should return an object keyed by token', () => {
    const map = db.buildSymbolMap();
    const token = db.symbolToToken('TCS');
    expect(map[token]).toBe('TCS');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 2. PriceEngine — tick shape and OHLCV
// ─────────────────────────────────────────────────────────────────────────────
describe('PriceEngine', () => {
  let PriceEngine;

  const makeSeedMap = (symbols) => {
    const m = new Map();
    for (const sym of symbols) {
      m.set(sym, {
        open: 1000, lastClose: 1000, high: 1010, low: 990,
        drift: 0, volatility: 0.0003, avgVolume: 500000, seededAt: new Date().toISOString(),
      });
    }
    return m;
  };

  beforeEach(async () => {
    ({ PriceEngine } = await import('../simulator/price-engine.js'));
  });

  it('should emit tick events with required fields', (done) => {
    const engine = new PriceEngine(makeSeedMap(['RELIANCE', 'TCS']), {
      tickIntervalMs: 50,
      sessionDurationMs: 200,
    });

    engine.on('tick', (ticks) => {
      engine.stop();
      expect(Array.isArray(ticks)).toBe(true);
      expect(ticks.length).toBe(2);

      for (const tick of ticks) {
        expect(typeof tick.symbol).toBe('string');
        expect(typeof tick.ltp).toBe('number');
        expect(typeof tick.open).toBe('number');
        expect(typeof tick.high).toBe('number');
        expect(typeof tick.low).toBe('number');
        expect(typeof tick.close).toBe('number');
        expect(typeof tick.volume).toBe('number');
        expect(typeof tick.change).toBe('number');
      }

      done();
    });

    engine.start();
  });

  it('OHLCV: high >= ltp >= low throughout the session', (done) => {
    const engine = new PriceEngine(makeSeedMap(['INFY']), {
      tickIntervalMs: 20,
      sessionDurationMs: 300,
    });

    const violations = [];

    engine.on('tick', (ticks) => {
      for (const tick of ticks) {
        if (tick.high < tick.ltp || tick.ltp < tick.low) {
          violations.push({ ltp: tick.ltp, high: tick.high, low: tick.low });
        }
      }
    });

    engine.on('session_end', () => {
      expect(violations).toHaveLength(0);
      done();
    });

    engine.start();
  });

  it('volume should be non-negative and increasing', (done) => {
    const engine = new PriceEngine(makeSeedMap(['SBIN']), {
      tickIntervalMs: 30,
      sessionDurationMs: 300,
    });

    let lastVolume = -1;
    let decreases = 0;

    engine.on('tick', (ticks) => {
      const tick = ticks.find(t => t.symbol === 'SBIN');
      if (tick) {
        if (lastVolume >= 0 && tick.volume < lastVolume) decreases++;
        lastVolume = tick.volume;
      }
    });

    engine.on('session_end', () => {
      expect(decreases).toBe(0);
      done();
    });

    engine.start();
  });

  it('getStatus should return correct fields when running', (done) => {
    const engine = new PriceEngine(makeSeedMap(['TCS']), {
      tickIntervalMs: 50,
      sessionDurationMs: 500,
    });

    engine.on('tick', () => {
      // Capture status while the engine is still running
      const status = engine.getStatus();
      engine.stop();

      expect(status.running).toBe(true);
      expect(typeof status.symbols).toBe('number');
      expect(status.symbols).toBe(1);
      expect(typeof status.elapsedMs).toBe('number');
      expect(status.elapsedMs).toBeGreaterThanOrEqual(0);
      done();
    });

    engine.start();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 3. Binary packet encoding → _parseBinaryTicks compatibility
// ─────────────────────────────────────────────────────────────────────────────
describe('Binary packet <-> _parseBinaryTicks round-trip', () => {
  /**
   * Replicated here so we don't import the full server (which would start listening).
   */
  function encodeKiteBinary(ticks) {
    const PACKET_LEN = 44;
    const totalSize = 2 + ticks.length * (2 + PACKET_LEN);
    const buf = Buffer.alloc(totalSize, 0);
    let offset = 0;

    buf.writeInt16BE(ticks.length, offset); offset += 2;

    for (const tick of ticks) {
      buf.writeInt16BE(PACKET_LEN, offset); offset += 2;
      buf.writeInt32BE(tick.instrumentToken,                  offset); offset += 4;
      buf.writeInt32BE(Math.round(tick.ltp   * 100),          offset); offset += 4;
      buf.writeInt32BE(Math.round(tick.high  * 100),          offset); offset += 4;
      buf.writeInt32BE(Math.round(tick.low   * 100),          offset); offset += 4;
      buf.writeInt32BE(Math.round(tick.open  * 100),          offset); offset += 4;
      buf.writeInt32BE(Math.round(tick.close * 100),          offset); offset += 4;
      buf.writeUInt32BE(tick.volume || 0,                     offset); offset += 4;
      buf.writeInt32BE(Math.round((tick.change || 0) * 100),  offset); offset += 4;
      offset += 12; // depth bytes (zeroed)
    }

    return buf;
  }

  it('should decode correct number of packets', async () => {
    const { TickFeed } = await import('../src/data/tick-feed.js');
    const feed = new TickFeed({ apiKey: 'x', accessToken: 'y' });

    const ticks = [
      { instrumentToken: 100001, ltp: 1250.5, high: 1260, low: 1240, open: 1245, close: 1230, volume: 5000, change: 1.5 },
      { instrumentToken: 100002, ltp: 3400.0, high: 3420, low: 3380, open: 3390, close: 3350, volume: 2500, change: 0.8 },
    ];

    const encoded = encodeKiteBinary(ticks);
    const decoded = feed._parseBinaryTicks(encoded);

    expect(decoded).toHaveLength(2);
  });

  it('should decode ltp within ±0.05 of original (100x int rounding)', async () => {
    const { TickFeed } = await import('../src/data/tick-feed.js');
    const feed = new TickFeed({ apiKey: 'x', accessToken: 'y' });

    const original = { instrumentToken: 100003, ltp: 1578.75, high: 1595, low: 1561, open: 1570, close: 1555, volume: 10000, change: 1.5 };
    const buf = encodeKiteBinary([original]);
    const [decoded] = feed._parseBinaryTicks(buf);

    expect(decoded.instrumentToken).toBe(original.instrumentToken);
    expect(Math.abs(decoded.lastPrice - original.ltp)).toBeLessThan(0.05);
    expect(Math.abs(decoded.ohlc.high - original.high)).toBeLessThan(0.05);
    expect(Math.abs(decoded.ohlc.low  - original.low)).toBeLessThan(0.05);
    expect(Math.abs(decoded.ohlc.open - original.open)).toBeLessThan(0.05);
    expect(decoded.volume).toBe(original.volume);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 4. data-seeder — computeGBMParams (tested via seedSymbols fallback)
// ─────────────────────────────────────────────────────────────────────────────
describe('data-seeder fallback behaviour', () => {
  it('seedSymbols should return a Map with SeedData for each symbol', async () => {
    // Use clearCache first to avoid stale data interfering
    const { seedSymbols, clearCache } = await import('../simulator/data-seeder.js');
    clearCache();

    // Feed a symbol that almost certainly doesn't exist on Yahoo
    // so we exercise the fallback path
    const result = await seedSymbols(['FAKESYM_XYZ']);

    expect(result instanceof Map).toBe(true);
    const seed = result.get('FAKESYM_XYZ');
    expect(seed).toBeDefined();
    expect(typeof seed.lastClose).toBe('number');
    expect(seed.lastClose).toBeGreaterThan(0);
    expect(typeof seed.volatility).toBe('number');
    expect(seed.volatility).toBeGreaterThan(0);
  }, 15000); // Allow time for network attempt + fallback
});
