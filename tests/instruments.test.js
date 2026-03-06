/**
 * Unit tests for InstrumentManager.
 */

import { describe, test, expect, beforeEach, jest } from '@jest/globals';
import { InstrumentManager } from '../src/data/instruments.js';

// Mock instruments (simulating what Kite returns)
const MOCK_INSTRUMENTS = [
  {
    instrument_token: 738561,
    tradingsymbol: 'RELIANCE',
    name: 'Reliance Industries',
    exchange: 'NSE',
    segment: 'NSE',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
    expiry: null,
  },
  {
    instrument_token: 256265,
    tradingsymbol: 'TCS',
    name: 'Tata Consultancy Services',
    exchange: 'NSE',
    segment: 'NSE',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
    expiry: null,
  },
  {
    instrument_token: 408065,
    tradingsymbol: 'INFY',
    name: 'Infosys Limited',
    exchange: 'NSE',
    segment: 'NSE',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
    expiry: null,
  },
  {
    instrument_token: 500209,
    tradingsymbol: 'RELIANCE',
    name: 'Reliance Industries',
    exchange: 'BSE',
    segment: 'BSE',
    instrument_type: 'EQ',
    lot_size: 1,
    tick_size: 0.05,
    expiry: null,
  },
];

function createMockBroker() {
  return {
    getInstruments: jest.fn(async (exchange) =>
      MOCK_INSTRUMENTS.filter((i) => i.exchange === exchange)
    ),
  };
}

describe('InstrumentManager', () => {
  let manager;
  let broker;

  beforeEach(() => {
    broker = createMockBroker();
    manager = new InstrumentManager(broker);
    // Pre-load instruments by building maps directly (skip Redis in tests)
    manager._buildMaps(MOCK_INSTRUMENTS.map((i) => ({
      instrumentToken: i.instrument_token,
      tradingSymbol: i.tradingsymbol,
      name: i.name,
      exchange: i.exchange,
      segment: i.segment,
      instrumentType: i.instrument_type,
      lotSize: i.lot_size,
      tickSize: i.tick_size,
      expiry: i.expiry,
    })));
  });

  // ─── Symbol Lookup ────────────────────────────────────

  test('should look up instrument by symbol', () => {
    const inst = manager.getBySymbol('TCS');
    expect(inst).not.toBeNull();
    expect(inst.tradingSymbol).toBe('TCS');
    expect(inst.instrumentToken).toBe(256265);
  });

  test('should look up instrument by exchange-qualified symbol', () => {
    const inst = manager.getBySymbol('NSE:RELIANCE');
    expect(inst).not.toBeNull();
    expect(inst.exchange).toBe('NSE');
    expect(inst.instrumentToken).toBe(738561);
  });

  test('should look up BSE instrument by exchange-qualified symbol', () => {
    const inst = manager.getBySymbol('BSE:RELIANCE');
    expect(inst).not.toBeNull();
    expect(inst.exchange).toBe('BSE');
    expect(inst.instrumentToken).toBe(500209);
  });

  test('should return null for unknown symbol', () => {
    expect(manager.getBySymbol('UNKNOWN')).toBeNull();
  });

  // ─── Token Lookup ─────────────────────────────────────

  test('should look up instrument by token', () => {
    const inst = manager.getByToken(256265);
    expect(inst).not.toBeNull();
    expect(inst.tradingSymbol).toBe('TCS');
  });

  test('should return null for unknown token', () => {
    expect(manager.getByToken(999999)).toBeNull();
  });

  test('should get token from symbol', () => {
    expect(manager.getToken('INFY')).toBe(408065);
    expect(manager.getToken('MISSING')).toBeNull();
  });

  // ─── Search ───────────────────────────────────────────

  test('should search instruments by partial symbol', () => {
    const results = manager.search('REL');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results.some((r) => r.tradingSymbol === 'RELIANCE')).toBe(true);
  });

  test('should search instruments by name', () => {
    const results = manager.search('Tata');
    expect(results.length).toBeGreaterThanOrEqual(1);
    expect(results[0].tradingSymbol).toBe('TCS');
  });

  test('should respect search limit', () => {
    const results = manager.search('', undefined, 2);
    expect(results.length).toBeLessThanOrEqual(2);
  });

  // ─── Symbol Resolution ────────────────────────────────

  test('should resolve symbols to tokens and symbolMap', () => {
    const { tokens, symbolMap } = manager.resolveSymbols(['NSE:RELIANCE', 'TCS', 'INFY']);

    expect(tokens).toHaveLength(3);
    expect(tokens).toContain(738561); // NSE:RELIANCE
    expect(tokens).toContain(256265);
    expect(tokens).toContain(408065);
    expect(symbolMap[738561]).toBe('RELIANCE');
    expect(symbolMap[256265]).toBe('TCS');
  });

  test('should skip unknown symbols in resolution', () => {
    const { tokens } = manager.resolveSymbols(['NSE:RELIANCE', 'FAKESYM']);
    expect(tokens).toHaveLength(1);
  });

  // ─── Equities Filter ─────────────────────────────────

  test('should filter equities by exchange', () => {
    const equities = manager.getEquities('NSE');
    expect(equities.every((e) => e.instrumentType === 'EQ')).toBe(true);
    expect(equities.every((e) => e.exchange === 'NSE')).toBe(true);
  });

  // ─── Status ───────────────────────────────────────────

  test('should return correct status', () => {
    const status = manager.getStatus();
    expect(status.loaded).toBe(true);
    expect(status.tokenCount).toBe(4);
    expect(status.exchanges).toContain('NSE');
    expect(status.exchanges).toContain('BSE');
  });
});
