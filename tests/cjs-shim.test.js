/**
 * Test: Verify the kiteconnect CJS package imports correctly via createRequire.
 * This validates our ESM-CJS shim approach works in this Node.js environment.
 */

import { describe, test, expect } from '@jest/globals';
import { createRequire } from 'node:module';

describe('CJS Shim Verification', () => {
  test('createRequire should be available from node:module', () => {
    expect(typeof createRequire).toBe('function');
  });

  test('should successfully import kiteconnect CJS package via createRequire', () => {
    const require = createRequire(import.meta.url);
    const kiteconnect = require('kiteconnect');

    expect(kiteconnect).toBeDefined();
    expect(kiteconnect.KiteConnect).toBeDefined();
    expect(typeof kiteconnect.KiteConnect).toBe('function');
  });

  test('should be able to instantiate KiteConnect from CJS import', () => {
    const require = createRequire(import.meta.url);
    const { KiteConnect } = require('kiteconnect');

    const kite = new KiteConnect({ api_key: 'test_key' });
    expect(kite).toBeDefined();
    expect(typeof kite.placeOrder).toBe('function');
    expect(typeof kite.getPositions).toBe('function');
    expect(typeof kite.getOrders).toBe('function');
    expect(typeof kite.setAccessToken).toBe('function');
  });

  test('KiteConnect instance should accept setAccessToken', () => {
    const require = createRequire(import.meta.url);
    const { KiteConnect } = require('kiteconnect');

    const kite = new KiteConnect({ api_key: 'test_key' });
    // Should not throw
    expect(() => kite.setAccessToken('test_token')).not.toThrow();
  });
});
