/**
 * Tests for RollingTickBuffer — focusing on snapshot/restore persistence
 * so that BAVI tick history survives mid-day server restarts.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { RollingTickBuffer } from '../src/data/rolling-tick-buffer.js';
import { TICK_SIDE } from '../src/data/tick-classifier.js';

// ── Helpers ────────────────────────────────────────────────────────────────

/** Build a fake classified tick */
function makeTick(side = TICK_SIDE.BUY, qty = 100) {
  return { side, quantity: qty, price: 1000, timestamp: Date.now() };
}

/** Push N ticks for a symbol */
function fillBuffer(buf, symbol, n = 60, side = TICK_SIDE.BUY) {
  for (let i = 0; i < n; i++) buf.push(symbol, makeTick(side));
}

/** Today's date in YYYY-MM-DD IST (same logic as toSnapshot) */
function todayIST() {
  return new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' })
    .split(',')[0].trim();
}

// ── Tests ──────────────────────────────────────────────────────────────────

describe('RollingTickBuffer — snapshot / restore', () => {
  let buf;

  beforeEach(() => {
    buf = new RollingTickBuffer({ windowSize: 200 });
  });

  // ── toSnapshot ────────────────────────────────────────────────────────

  test('toSnapshot returns expected shape', () => {
    fillBuffer(buf, 'RELIANCE', 60);
    const snap = buf.toSnapshot();

    expect(snap).toHaveProperty('date', todayIST());
    expect(snap).toHaveProperty('buffers');
    expect(snap).toHaveProperty('history');
    expect(snap.buffers).toHaveProperty('RELIANCE');
    expect(Array.isArray(snap.buffers.RELIANCE)).toBe(true);
    expect(snap.buffers.RELIANCE.length).toBe(60);
  });

  test('toSnapshot on empty buffer returns empty buffers object', () => {
    const snap = buf.toSnapshot();
    expect(snap.date).toBe(todayIST());
    expect(Object.keys(snap.buffers)).toHaveLength(0);
    expect(Object.keys(snap.history)).toHaveLength(0);
  });

  test('toSnapshot trims buffer to windowSize', () => {
    const small = new RollingTickBuffer({ windowSize: 10 });
    fillBuffer(small, 'TCS', 20); // push 20 into size-10 window
    const snap = small.toSnapshot();
    expect(snap.buffers.TCS.length).toBe(10);
  });

  test('toSnapshot captures multiple symbols', () => {
    fillBuffer(buf, 'RELIANCE', 60);
    fillBuffer(buf, 'INFY', 80);
    const snap = buf.toSnapshot();
    expect(Object.keys(snap.buffers)).toHaveLength(2);
    expect(snap.buffers.INFY.length).toBe(80);
  });

  // ── loadSnapshot ──────────────────────────────────────────────────────

  test('loadSnapshot with same-day snapshot restores ticks and returns count', () => {
    fillBuffer(buf, 'RELIANCE', 70);
    fillBuffer(buf, 'INFY', 50);
    const snap = buf.toSnapshot();

    const fresh = new RollingTickBuffer({ windowSize: 200 });
    const restored = fresh.loadSnapshot(snap);

    expect(restored).toBe(2);
    expect(fresh.size('RELIANCE')).toBe(70);
    expect(fresh.size('INFY')).toBe(50);
  });

  test('loadSnapshot preserves isReliable flag for well-filled buffers', () => {
    fillBuffer(buf, 'RELIANCE', 60); // > 50 threshold
    const snap = buf.toSnapshot();

    const fresh = new RollingTickBuffer({ windowSize: 200 });
    fresh.loadSnapshot(snap);

    const imb = fresh.getImbalance('RELIANCE');
    expect(imb.isReliable).toBe(true);
    expect(imb.tickCount).toBe(60);
  });

  test('loadSnapshot trims ticks to own windowSize', () => {
    fillBuffer(buf, 'RELIANCE', 150); // fill 150 ticks
    const snap = buf.toSnapshot();

    const small = new RollingTickBuffer({ windowSize: 50 });
    small.loadSnapshot(snap);

    expect(small.size('RELIANCE')).toBe(50);
  });

  test('loadSnapshot with yesterday date returns 0 and buffer stays empty', () => {
    fillBuffer(buf, 'RELIANCE', 60);
    const snap = buf.toSnapshot();
    snap.date = '2020-01-01'; // stale date

    const fresh = new RollingTickBuffer({ windowSize: 200 });
    const restored = fresh.loadSnapshot(snap);

    expect(restored).toBe(0);
    expect(fresh.size('RELIANCE')).toBe(0);
  });

  test('loadSnapshot with null is a no-op', () => {
    const fresh = new RollingTickBuffer({ windowSize: 200 });
    expect(fresh.loadSnapshot(null)).toBe(0);
    expect(fresh.size('RELIANCE')).toBe(0);
  });

  test('loadSnapshot with malformed object is a no-op', () => {
    const fresh = new RollingTickBuffer({ windowSize: 200 });
    expect(fresh.loadSnapshot('not-an-object')).toBe(0);
    expect(fresh.loadSnapshot(42)).toBe(0);
  });

  test('loadSnapshot skips symbols with empty tick arrays', () => {
    const snap = { date: todayIST(), buffers: { EMPTY: [] }, history: {} };
    const fresh = new RollingTickBuffer({ windowSize: 200 });
    const restored = fresh.loadSnapshot(snap);
    expect(restored).toBe(0);
  });

  test('full round-trip: snapshot → restore → imbalance matches', () => {
    // Push 60 BUY ticks → strong positive imbalance
    fillBuffer(buf, 'RELIANCE', 60, TICK_SIDE.BUY);
    const imbBefore = buf.getImbalance('RELIANCE');
    const snap = buf.toSnapshot();

    const fresh = new RollingTickBuffer({ windowSize: 200 });
    fresh.loadSnapshot(snap);

    const imbAfter = fresh.getImbalance('RELIANCE');
    expect(imbAfter.isReliable).toBe(true);
    expect(imbAfter.imbalance).toBe(imbBefore.imbalance);
    expect(imbAfter.tickCount).toBe(imbBefore.tickCount);
  });

  // ── existing public API not broken ────────────────────────────────────

  test('existing push / getImbalance / reset still work after adding snapshot methods', () => {
    fillBuffer(buf, 'RELIANCE', 60);
    expect(buf.getImbalance('RELIANCE').isReliable).toBe(true);
    buf.reset('RELIANCE');
    expect(buf.size('RELIANCE')).toBe(0);
    buf.resetAll();
    expect(buf.size('RELIANCE')).toBe(0);
  });
});
