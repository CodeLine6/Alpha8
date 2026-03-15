import { createLogger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';

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
 * @example
 *   import { KiteClient } from './kite-client.js';
 *   import { AngelClient } from './angel-client.js';
 *
 *   const broker = new BrokerManager(
 *     new KiteClient({ ... }),
 *     new AngelClient({ ... })   // optional
 *   );
 *
 *   const order = await broker.placeOrder({
 *     symbol: 'RELIANCE',
 *     exchange: 'NSE',
 *     side: 'BUY',
 *     quantity: 10,
 *     orderType: 'MARKET',
 *   });
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
    this._tokenRefreshing = false; // C8: Prevent concurrent token refreshes

    log.info({
      primary: primary?.name || 'none',
      fallback: fallback?.name || 'none',
    }, 'BrokerManager initialized');
  }

  /**
   * Execute a broker operation with automatic fallback.
   * @private
   * @param {string} operation - Method name for logging
   * @param {(client: any) => Promise<any>} primaryFn - Call against primary broker
   * @param {((client: any) => Promise<any>) | null} fallbackFn - Call against fallback broker
   * @returns {Promise<any>}
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

      // C8: Detect token expiry and attempt refresh
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

      // Attempt fallback if available
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
   * C8: Check if error indicates token expiry.
   * @private
   */
  _isTokenExpired(err) {
    const msg = (err.message || '').toLowerCase();
    const status = err.response?.status || err.statusCode || 0;
    return status === 403 || status === 401 ||
      msg.includes('token') || msg.includes('session') || msg.includes('unauthorized');
  }

  /**
   * C8: Re-read access token from Redis and update the primary broker.
   * @private
   * @returns {Promise<boolean>} True if token was refreshed.
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
      const newToken = await redis.get('kite:access_token');
      if (!newToken) {
        log.error('Cannot refresh token — no token in Redis');
        return false;
      }
      if (this.primary?.kite) {
        this.primary.kite.setAccessToken(newToken);
        log.warn('Access token refreshed from Redis');
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

  // ─── Order Operations (Normalized) ──────────────────────

  /**
   * Place an order through the broker abstraction.
   * @param {Object} params
   * @param {string} params.symbol - Trading symbol (e.g. 'RELIANCE')
   * @param {string} params.exchange - Exchange (NSE, BSE)
   * @param {string} params.side - BUY or SELL
   * @param {number} params.quantity - Number of shares
   * @param {string} [params.orderType='MARKET'] - MARKET, LIMIT, SL-M
   * @param {string} [params.product='MIS'] - MIS (intraday) or CNC (delivery)
   * @param {number} [params.price] - Limit price
   * @param {number} [params.triggerPrice] - Stop-loss trigger price
   * @returns {Promise<{ orderId: string, broker: string }>}
   */
  async placeOrder(params) {
    log.info({ symbol: params.symbol, side: params.side, qty: params.quantity }, 'BrokerManager: placeOrder');

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
   * Cancel an order.
   * @param {string} orderId
   * @returns {Promise<Object>}
   */
  async cancelOrder(orderId) {
    return this._executeWithFallback(
      'cancelOrder',
      (kite) => kite.cancelOrder(orderId),
      this.fallback ? (angel) => angel.cancelOrder(orderId) : null
    );
  }

  /**
   * Get all orders for the day.
   * @returns {Promise<Object[]>}
   */
  async getOrders() {
    return this._executeWithFallback(
      'getOrders',
      (kite) => kite.getOrders(),
      this.fallback ? (angel) => angel.getOrders() : null
    );
  }

  // ─── Portfolio Operations ───────────────────────────────

  /**
   * Get current positions.
   * @returns {Promise<Object>}
   */
  async getPositions() {
    return this._executeWithFallback(
      'getPositions',
      (kite) => kite.getPositions(),
      this.fallback ? (angel) => angel.getPositions() : null
    );
  }

  /**
   * Get holdings.
   * @returns {Promise<Object[]>}
   */
  async getHoldings() {
    return this._executeWithFallback(
      'getHoldings',
      (kite) => kite.getHoldings(),
      this.fallback ? (angel) => angel.getHoldings() : null
    );
  }

  // ─── Market Data ────────────────────────────────────────

  /**
   * Get LTP for instruments.
   * @param {string[]} instruments - e.g. ['NSE:RELIANCE']
   * @returns {Promise<Object>}
   */
  async getLTP(instruments) {
    return this._executeWithFallback(
      'getLTP',
      (kite) => kite.getLTP(instruments),
      null // Angel LTP has different params, handled separately if needed
    );
  }

  /**
   * Get live quotes.
   * @param {string[]} instruments
   * @returns {Promise<Object>}
   */
  async getQuote(instruments) {
    return this._executeWithFallback(
      'getQuote',
      (kite) => kite.getQuote(instruments),
      null
    );
  }

  /**
   * Get all tradeable instruments for an exchange.
   * @param {string} [exchange] - Exchange filter (NSE, BSE, NFO)
   * @returns {Promise<Object[]>}
   */
  async getInstruments(exchange) {
    return this._executeWithFallback(
      'getInstruments',
      (kite) => kite.getInstruments(exchange),
      null
    );
  }

  /**
   * Get historical OHLCV candle data.
   * @param {number} instrumentToken - Kite instrument token
   * @param {string} interval - minute, 5minute, 15minute, day, etc.
   * @param {string|Date} from - Start date
   * @param {string|Date} to - End date
   * @returns {Promise<Object>}
   */
  async getHistoricalData(instrumentToken, interval, from, to) {
    return this._executeWithFallback(
      'getHistoricalData',
      (kite) => kite.getHistoricalData(instrumentToken, interval, from, to),
      null
    );
  }

  /**
   * Get user profile.
   * @returns {Promise<Object>}
   */
  async getProfile() {
    return this._executeWithFallback(
      'getProfile',
      (kite) => kite.getProfile(),
      null
    );
  }

  /**
   * Get account margins/funds.
   * @returns {Promise<Object>}
   */
  async getMargins() {
    return this._executeWithFallback(
      'getMargins',
      (kite) => kite.getMargins(),
      this.fallback ? (angel) => angel.getMargins() : null
    );
  }

  // ─── Utilities ──────────────────────────────────────────

  /**
   * Normalize order response to a consistent shape.
   * Kite returns `order_id`, Angel returns `orderid` — this unifies them.
   * @private
   * @param {Object} response - Raw broker response
   * @param {string} broker - Broker name ('kite' or 'angel')
   * @param {Object} [originalParams] - Original order params for context
   * @returns {{ orderId: string, broker: string, status: string, timestamp: string, raw: Object }}
   */
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

  /**
   * Check if the broker is connected and token is valid.
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

  async isTokenValid() {
    try {
      const profile = await this.primary.getProfile();
      return !!(profile?.user_id || profile?.user_name);
    } catch (err) {
      const msg = (err.message || '').toLowerCase();
      const isTokenError = msg.includes('token') || msg.includes('session') ||
                           msg.includes('unauthorized') || msg.includes('403');
      // Re-throw non-token errors so caller can distinguish API down vs token expired
      if (!isTokenError) throw err;
      return false;
    }
  }

  /**
   * Get combined status of both brokers for health monitoring.
   * @returns {{ primary: Object, fallback: Object | null, activeBroker: string }}
   */
  getStatus() {
    return {
      activeBroker: this.activeBroker,
      primary: this.primary?.getCircuitStatus?.() || { state: 'UNKNOWN' },
      fallback: this.fallback?.getCircuitStatus?.() || null,
    };
  }
}
