import { createLogger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';
import { decryptToken } from '../lib/crypto-utils.js';

const log = createLogger('broker');

/**
 * Unified Broker Abstraction Layer.
 *
 * Provides a single interface that abstracts over Kite Connect (primary) and
 * AngelOne (fallback). On primary failure + circuit open, automatically falls
 * back to the secondary broker.
 *
 * Normalizes responses from both brokers into a consistent format.
 *
 * FIX: _refreshToken() now calls decryptToken() before setting the access token.
 *      Without this, the encrypted ciphertext was being passed directly to
 *      kite.setAccessToken() after encryption was added, causing all broker
 *      calls to fail silently after a token refresh.
 *
 * FIX: isTokenValid() added as a separate health check that distinguishes
 *      "broker API down" from "token expired".
 */
export class BrokerManager {
  /**
   * @param {import('./kite-client.js').KiteClient} primary - Primary broker (Kite)
   * @param {import('./angel-client.js').AngelClient} [fallback] - Fallback broker (AngelOne)
   */
  constructor(primary, fallback = null) {
    this.primary = primary;
    this.fallback = fallback;
    this.activeBroker = 'primary';
    this._tokenRefreshing = false;

    log.info({
      primary: primary?.name || 'none',
      fallback: fallback?.name || 'none',
    }, 'BrokerManager initialized');
  }

  /**
   * Execute a broker operation with automatic fallback.
   * @private
   */
  async _executeWithFallback(operation, primaryFn, fallbackFn = null) {
    try {
      const result = await primaryFn(this.primary);
      if (this.activeBroker !== 'primary') {
        this.activeBroker = 'primary';
        log.info({ operation }, 'Switched back to primary broker');
      }
      return result;
    } catch (primaryErr) {
      log.error({ operation, err: primaryErr.message }, 'Primary broker failed');

      if (this._isTokenExpired(primaryErr)) {
        const refreshed = await this._refreshToken();
        if (refreshed) {
          try {
            log.info({ operation }, 'Retrying with refreshed token');
            return await primaryFn(this.primary);
          } catch (retryErr) {
            log.error({ operation, err: retryErr.message }, 'Retry after token refresh failed');
          }
        }
      }

      if (this.fallback && fallbackFn) {
        try {
          log.warn({ operation }, 'Falling back to secondary broker');
          this.activeBroker = 'fallback';
          return await fallbackFn(this.fallback);
        } catch (fallbackErr) {
          log.error({ operation, err: fallbackErr.message }, 'Fallback broker also failed');
          throw new Error(
            `Both brokers failed for [${operation}]: ` +
            `Primary: ${primaryErr.message} | Fallback: ${fallbackErr.message}`
          );
        }
      }

      throw primaryErr;
    }
  }

  /**
   * Check if error indicates token expiry.
   * @private
   */
  _isTokenExpired(err) {
    const msg = (err.message || '').toLowerCase();
    const status = err.response?.status || err.statusCode || 0;
    return status === 403 || status === 401 ||
      msg.includes('token') || msg.includes('session') || msg.includes('unauthorized');
  }

  /**
   * Re-read access token from Redis, decrypt it, and update the primary broker.
   *
   * FIX APPLIED: decryptToken() is now called on the raw Redis value before
   * passing it to kite.setAccessToken(). Previously the encrypted ciphertext
   * was set directly, causing all subsequent broker calls to fail with auth errors.
   *
   * @private
   * @returns {Promise<boolean>} True if token was refreshed successfully.
   */
  async _refreshToken() {
    if (this._tokenRefreshing) return false;
    this._tokenRefreshing = true;

    try {
      const redis = getRedis();
      if (!redis) {
        log.error('Cannot refresh token — Redis not available');
        return false;
      }

      const rawValue = await redis.get('kite:access_token');
      if (!rawValue) {
        log.error('Cannot refresh token — no token in Redis');
        return false;
      }

      // Decrypt before setting — decryptToken handles plaintext fallback
      // gracefully if TOKEN_ENCRYPTION_KEY is not set or token is legacy plaintext.
      let accessToken;
      try {
        accessToken = decryptToken(rawValue);
      } catch (decryptErr) {
        log.error({ err: decryptErr.message },
          'Token decryption failed during refresh — token may be corrupt');
        return false;
      }

      if (this.primary?.kite) {
        this.primary.kite.setAccessToken(accessToken);
        log.warn('Access token refreshed and decrypted from Redis');
        return true;
      }

      return false;
    } catch (err) {
      log.error({ err: err.message }, 'Token refresh from Redis failed');
      return false;
    } finally {
      this._tokenRefreshing = false;
    }
  }

  // ─── Order Operations (Normalized) ──────────────────────────────────────────

  async placeOrder(params) {
    log.info({ symbol: params.symbol, side: params.side, qty: params.quantity },
      'BrokerManager: placeOrder');

    return this._executeWithFallback(
      'placeOrder',
      async (kite) => {
        const response = await kite.placeOrder({
          exchange: params.exchange || 'NSE',
          tradingsymbol: params.symbol,
          transaction_type: params.side,
          quantity: params.quantity,
          order_type: params.orderType || 'MARKET',
          product: params.product || 'MIS',
          price: params.price,
          trigger_price: params.triggerPrice,
        });
        return this._normalizeOrderResponse(response, 'kite', params);
      },
      this.fallback
        ? async (angel) => {
          const response = await angel.placeOrder({
            exchange: params.exchange || 'NSE',
            tradingsymbol: params.symbol,
            transaction_type: params.side,
            quantity: params.quantity,
            order_type: params.orderType || 'MARKET',
            product: params.product === 'MIS' ? 'INTRADAY' : 'DELIVERY',
            price: params.price,
            trigger_price: params.triggerPrice,
          });
          return this._normalizeOrderResponse(response, 'angel', params);
        }
        : null
    );
  }

  /**
   * Place an emergency order bypassing the circuit breaker.
   * Does NOT fall back to secondary broker — speed over resilience for exits.
   */
  async placeEmergencyOrder(params) {
    log.warn({ symbol: params.symbol, side: params.side, qty: params.quantity },
      'BrokerManager: placeEmergencyOrder (circuit bypass)');

    const response = await this.primary.placeEmergencyOrder({
      exchange: params.exchange || 'NSE',
      tradingsymbol: params.symbol,
      transaction_type: params.side,
      quantity: params.quantity,
      order_type: params.orderType || 'MARKET',
      product: params.product || 'MIS',
      price: params.price,
      trigger_price: params.triggerPrice,
    });

    return this._normalizeOrderResponse(response, 'kite', params);
  }

  async cancelOrder(orderId) {
    return this._executeWithFallback(
      'cancelOrder',
      (kite) => kite.cancelOrder(orderId),
      this.fallback ? (angel) => angel.cancelOrder(orderId) : null
    );
  }

  async getOrders() {
    return this._executeWithFallback(
      'getOrders',
      (kite) => kite.getOrders(),
      this.fallback ? (angel) => angel.getOrders() : null
    );
  }

  // ─── Portfolio Operations ────────────────────────────────────────────────────

  async getPositions() {
    return this._executeWithFallback(
      'getPositions',
      (kite) => kite.getPositions(),
      this.fallback ? (angel) => angel.getPositions() : null
    );
  }

  async getHoldings() {
    return this._executeWithFallback(
      'getHoldings',
      (kite) => kite.getHoldings(),
      this.fallback ? (angel) => angel.getHoldings() : null
    );
  }

  // ─── Market Data ─────────────────────────────────────────────────────────────

  async getLTP(instruments) {
    return this._executeWithFallback(
      'getLTP',
      (kite) => kite.getLTP(instruments),
      null
    );
  }

  async getQuote(instruments) {
    return this._executeWithFallback(
      'getQuote',
      (kite) => kite.getQuote(instruments),
      null
    );
  }

  async getInstruments(exchange) {
    return this._executeWithFallback(
      'getInstruments',
      (kite) => kite.getInstruments(exchange),
      null
    );
  }

  async getHistoricalData(instrumentToken, interval, from, to) {
    return this._executeWithFallback(
      'getHistoricalData',
      (kite) => kite.getHistoricalData(instrumentToken, interval, from, to),
      null
    );
  }

  async getProfile() {
    return this._executeWithFallback(
      'getProfile',
      (kite) => kite.getProfile(),
      null
    );
  }

  async getMargins() {
    return this._executeWithFallback(
      'getMargins',
      (kite) => kite.getMargins(),
      this.fallback ? (angel) => angel.getMargins() : null
    );
  }

  // ─── Health Checks ───────────────────────────────────────────────────────────

  /**
   * Check if broker API is reachable (network level).
   * @returns {Promise<boolean>}
   */
  async isConnected() {
    try {
      await this.primary.getProfile();
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check if the current access token is valid (auth level).
   * Separate from isConnected() so the dashboard can distinguish:
   *   broker: false  → API unreachable (network issue)
   *   brokerTokenValid: false → API reachable but token expired (run: npm run login)
   *
   * @returns {Promise<boolean|null>} true=valid, false=expired, null=no broker
   */
  async isTokenValid() {
    try {
      const profile = await this.primary.getProfile();
      return !!(profile?.user_id || profile?.user_name);
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      const isTokenErr = msg.includes('token') || msg.includes('session') ||
        msg.includes('unauthorized') ||
        (err.response?.status === 403) ||
        (err.response?.status === 401);
      if (isTokenErr) return false;
      // Non-token error (network, etc.) — rethrow so caller knows API is down
      throw err;
    }
  }

  // ─── Utilities ───────────────────────────────────────────────────────────────

  _normalizeOrderResponse(response, broker, originalParams = {}) {
    return {
      orderId: response.order_id || response.orderid || response.orderId || null,
      broker,
      status: response.status || 'PLACED',
      timestamp: new Date().toISOString(),
      symbol: originalParams.symbol || response.tradingsymbol || null,
      side: originalParams.side || response.transaction_type || response.transactiontype || null,
      quantity: originalParams.quantity || response.quantity || null,
      raw: response,
    };
  }

  getStatus() {
    return {
      activeBroker: this.activeBroker,
      primary: this.primary?.getCircuitStatus?.() || { state: 'UNKNOWN' },
      fallback: this.fallback?.getCircuitStatus?.() || null,
    };
  }
}