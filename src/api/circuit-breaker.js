import { createLogger } from '../lib/logger.js';

const log = createLogger('circuit-breaker');

/**
 * Circuit Breaker pattern for API failure resilience.
 *
 * States:
 *   CLOSED  → Normal operation, requests pass through
 *   OPEN    → Failures exceeded threshold, requests are blocked
 *   HALF_OPEN → After cooldown, allow one probe request
 *
 * @example
 *   const breaker = new CircuitBreaker('kite-api', {
 *     failureThreshold: 5,
 *     cooldownMs: 30000,
 *   });
 *   const result = await breaker.execute(() => kiteClient.placeOrder(params));
 */

/** @enum {string} */
export const CIRCUIT_STATE = Object.freeze({
  CLOSED: 'CLOSED',
  OPEN: 'OPEN',
  HALF_OPEN: 'HALF_OPEN',
});

export class CircuitBreaker {
  /**
   * @param {string} name - Identifier for logging (e.g. 'kite-api')
   * @param {Object} [options]
   * @param {number} [options.failureThreshold=5] - Failures before opening
   * @param {number} [options.cooldownMs=30000] - Ms to wait before half-open probe
   * @param {number} [options.successThreshold=2] - Successes in half-open to close
   * @param {number} [options.timeoutMs=10000] - Per-request timeout
   */
  constructor(name, options = {}) {
    this.name = name;
    this.failureThreshold = options.failureThreshold ?? 5;
    this.cooldownMs = options.cooldownMs ?? 30000;
    this.successThreshold = options.successThreshold ?? 2;
    this.timeoutMs = options.timeoutMs ?? 10000;

    this.state = CIRCUIT_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    this.totalTrips = 0;
  }

  /**
   * Execute a function through the circuit breaker.
   * @template T
   * @param {() => Promise<T>} fn - Async function to execute
   * @returns {Promise<T>}
   * @throws {Error} If circuit is OPEN or the function fails
   */
  async execute(fn) {
    if (this.state === CIRCUIT_STATE.OPEN) {
      if (this._shouldAttemptReset()) {
        this.state = CIRCUIT_STATE.HALF_OPEN;
        log.info({ breaker: this.name }, 'Circuit → HALF_OPEN (probing)');
      } else {
        const err = new Error(`Circuit breaker [${this.name}] is OPEN — request blocked`);
        err.code = 'CIRCUIT_OPEN';
        throw err;
      }
    }

    try {
      const result = await this._executeWithTimeout(fn);
      this._onSuccess();
      return result;
    } catch (err) {
      this._onFailure(err);
      throw err;
    }
  }

  /**
   * Wrap fn in a timeout race.
   * @private
   */
  async _executeWithTimeout(fn) {
    let timer;
    return Promise.race([
      fn().then(
        (result) => { clearTimeout(timer); return result; },
        (err) => { clearTimeout(timer); throw err; },
      ),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`Circuit breaker [${this.name}] timed out after ${this.timeoutMs}ms`)),
          this.timeoutMs
        );
      }),
    ]);
  }

  /** @private */
  _onSuccess() {
    if (this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.successCount++;
      if (this.successCount >= this.successThreshold) {
        this.state = CIRCUIT_STATE.CLOSED;
        this.failureCount = 0;
        this.successCount = 0;
        log.info({ breaker: this.name }, 'Circuit → CLOSED (recovered)');
      }
    } else {
      this.failureCount = 0;
    }
  }

  /** @private */
  _onFailure(err) {
    this.failureCount++;
    this.lastFailureTime = Date.now();
    log.warn(
      { breaker: this.name, failures: this.failureCount, err: err.message },
      'Circuit breaker failure recorded'
    );

    if (this.failureCount >= this.failureThreshold || this.state === CIRCUIT_STATE.HALF_OPEN) {
      this.state = CIRCUIT_STATE.OPEN;
      this.successCount = 0;
      this.totalTrips++;
      log.error(
        { breaker: this.name, totalTrips: this.totalTrips },
        'Circuit → OPEN (requests blocked)'
      );
    }
  }

  /** @private */
  _shouldAttemptReset() {
    return this.lastFailureTime && Date.now() - this.lastFailureTime >= this.cooldownMs;
  }

  /**
   * Get current circuit breaker status for monitoring.
   * @returns {{ name: string, state: string, failureCount: number, totalTrips: number }}
   */
  getStatus() {
    return {
      name: this.name,
      state: this.state,
      failureCount: this.failureCount,
      successCount: this.successCount,
      totalTrips: this.totalTrips,
      lastFailureTime: this.lastFailureTime,
    };
  }

  /**
   * Manually reset the circuit breaker to CLOSED.
   */
  reset() {
    this.state = CIRCUIT_STATE.CLOSED;
    this.failureCount = 0;
    this.successCount = 0;
    this.lastFailureTime = null;
    log.info({ breaker: this.name }, 'Circuit manually reset → CLOSED');
  }
}
