/**
 * Unit tests for the Circuit Breaker pattern implementation.
 */

import { describe, test, expect, beforeEach } from '@jest/globals';
import { CircuitBreaker, CIRCUIT_STATE } from '../src/api/circuit-breaker.js';

describe('CircuitBreaker', () => {
  let breaker;

  beforeEach(() => {
    breaker = new CircuitBreaker('test-api', {
      failureThreshold: 3,
      cooldownMs: 100,
      successThreshold: 2,
      timeoutMs: 500,
    });
  });

  // ─── Basic Operation ──────────────────────────────────

  test('should start in CLOSED state', () => {
    expect(breaker.state).toBe(CIRCUIT_STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);
  });

  test('should pass through successful calls in CLOSED state', async () => {
    const result = await breaker.execute(() => Promise.resolve('success'));
    expect(result).toBe('success');
    expect(breaker.state).toBe(CIRCUIT_STATE.CLOSED);
  });

  test('should return correct status object', () => {
    const status = breaker.getStatus();
    expect(status).toEqual({
      name: 'test-api',
      state: 'CLOSED',
      failureCount: 0,
      successCount: 0,
      totalTrips: 0,
      lastFailureTime: null,
    });
  });

  // ─── Failure Tracking ─────────────────────────────────

  test('should count failures without opening when below threshold', async () => {
    const failFn = () => Promise.reject(new Error('fail'));

    await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    expect(breaker.failureCount).toBe(1);
    expect(breaker.state).toBe(CIRCUIT_STATE.CLOSED);

    await expect(breaker.execute(failFn)).rejects.toThrow('fail');
    expect(breaker.failureCount).toBe(2);
    expect(breaker.state).toBe(CIRCUIT_STATE.CLOSED);
  });

  test('should open circuit after reaching failure threshold', async () => {
    const failFn = () => Promise.reject(new Error('fail'));

    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }

    expect(breaker.state).toBe(CIRCUIT_STATE.OPEN);
    expect(breaker.totalTrips).toBe(1);
  });

  test('should reset failure count on success', async () => {
    const failFn = () => Promise.reject(new Error('fail'));
    const successFn = () => Promise.resolve('ok');

    // Two failures, then a success
    await expect(breaker.execute(failFn)).rejects.toThrow();
    await expect(breaker.execute(failFn)).rejects.toThrow();
    expect(breaker.failureCount).toBe(2);

    await breaker.execute(successFn);
    expect(breaker.failureCount).toBe(0);
  });

  // ─── OPEN State Behavior ──────────────────────────────

  test('should block requests when OPEN', async () => {
    // Force open state
    const failFn = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }
    expect(breaker.state).toBe(CIRCUIT_STATE.OPEN);

    // Should throw circuit open error
    await expect(breaker.execute(() => Promise.resolve('ok'))).rejects.toThrow(
      /Circuit breaker.*OPEN.*blocked/
    );
  });

  test('should have CIRCUIT_OPEN error code when open', async () => {
    const failFn = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }

    try {
      await breaker.execute(() => Promise.resolve('ok'));
    } catch (err) {
      expect(err.code).toBe('CIRCUIT_OPEN');
    }
  });

  // ─── HALF_OPEN Recovery ───────────────────────────────

  test('should transition to HALF_OPEN after cooldown', async () => {
    // Trip the breaker
    const failFn = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }
    expect(breaker.state).toBe(CIRCUIT_STATE.OPEN);

    // Wait for cooldown
    await new Promise((resolve) => setTimeout(resolve, 150));

    // Next call should probe (HALF_OPEN)
    const result = await breaker.execute(() => Promise.resolve('probe-success'));
    expect(result).toBe('probe-success');
    expect(breaker.state).toBe(CIRCUIT_STATE.HALF_OPEN);
  });

  test('should close circuit after enough successes in HALF_OPEN', async () => {
    const failFn = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    // Two successes needed (successThreshold = 2)
    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.state).toBe(CIRCUIT_STATE.HALF_OPEN);

    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.state).toBe(CIRCUIT_STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);
  });

  test('should re-open on failure during HALF_OPEN', async () => {
    const failFn = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }

    await new Promise((resolve) => setTimeout(resolve, 150));

    // One success probes to HALF_OPEN
    await breaker.execute(() => Promise.resolve('ok'));
    expect(breaker.state).toBe(CIRCUIT_STATE.HALF_OPEN);

    // Failure should re-open
    await expect(breaker.execute(failFn)).rejects.toThrow();
    expect(breaker.state).toBe(CIRCUIT_STATE.OPEN);
    expect(breaker.totalTrips).toBe(2);
  });

  // ─── Timeout ──────────────────────────────────────────

  test('should timeout slow calls', async () => {
    const slowFn = () => new Promise((resolve) => setTimeout(resolve, 1000));

    await expect(breaker.execute(slowFn)).rejects.toThrow(/timed out/);
    expect(breaker.failureCount).toBe(1);
  });

  // ─── Manual Reset ─────────────────────────────────────

  test('should reset to CLOSED on manual reset', async () => {
    const failFn = () => Promise.reject(new Error('fail'));
    for (let i = 0; i < 3; i++) {
      await expect(breaker.execute(failFn)).rejects.toThrow();
    }
    expect(breaker.state).toBe(CIRCUIT_STATE.OPEN);

    breaker.reset();
    expect(breaker.state).toBe(CIRCUIT_STATE.CLOSED);
    expect(breaker.failureCount).toBe(0);

    // Should work again
    const result = await breaker.execute(() => Promise.resolve('after-reset'));
    expect(result).toBe('after-reset');
  });
});
