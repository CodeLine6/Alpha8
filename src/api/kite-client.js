import { createRequire } from 'node:module';
import { createLogger } from '../lib/logger.js';
import { CircuitBreaker } from './circuit-breaker.js';

const require = createRequire(import.meta.url);
const { KiteConnect } = require('kiteconnect');

const log = createLogger('kite-client');

/**
 * Zerodha Kite Connect API client wrapper.
 *
 * Handles authentication, order operations, portfolio queries, and market data
 * through the Kite Connect API. All calls go through a circuit breaker.
 *
 * @example
 *   const kite = new KiteClient({
 *     apiKey: config.KITE_API_KEY,
 *     apiSecret: config.KITE_API_SECRET,
 *     accessToken: config.KITE_ACCESS_TOKEN,
 *   });
 *   const positions = await kite.getPositions();
 */
export class KiteClient {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - Kite Connect API key
   * @param {string} options.apiSecret - Kite Connect API secret
   * @param {string} options.accessToken - Pre-generated access token
   */
  constructor({ apiKey, apiSecret, accessToken }) {
    this.apiKey = apiKey;
    this.apiSecret = apiSecret;
    this.name = 'kite';

    this.kite = new KiteConnect({ api_key: apiKey });
    this.kite.setAccessToken(accessToken);

    this.breaker = new CircuitBreaker('kite-api', {
      failureThreshold: 5,
      cooldownMs: 30000,
      timeoutMs: 15000,
    });

    log.info('Kite Connect client initialized');
  }

  // ─── Authentication ─────────────────────────────────────

  /**
   * Generate login URL for request token flow.
   * @returns {string} Kite login URL
   */
  getLoginURL() {
    return this.kite.getLoginURL();
  }

  /**
   * Generate a new session (access token) from a request token.
   * @param {string} requestToken - Token received from login redirect
   * @returns {Promise<Object>} Session data with access_token
   */
  async generateSession(requestToken) {
    return this.breaker.execute(async () => {
      const session = await this.kite.generateSession(requestToken, this.apiSecret);
      this.kite.setAccessToken(session.access_token);
      log.info('New Kite session generated');
      return session;
    });
  }

  /**
   * Set access token manually (e.g. from stored token).
   * @param {string} accessToken
   */
  setAccessToken(accessToken) {
    this.kite.setAccessToken(accessToken);
    log.info('Kite access token updated');
  }

  // ─── Orders ─────────────────────────────────────────────

  /**
   * Place an order on Kite.
   * @param {Object} params
   * @param {string} params.exchange - Exchange (NSE, BSE, NFO)
   * @param {string} params.tradingsymbol - Instrument trading symbol
   * @param {string} params.transaction_type - BUY or SELL
   * @param {number} params.quantity - Number of shares
   * @param {string} [params.order_type='MARKET'] - MARKET, LIMIT, SL-M
   * @param {string} [params.product='MIS'] - MIS (intraday), CNC (delivery)
   * @param {number} [params.price] - Limit price (required for LIMIT)
   * @param {number} [params.trigger_price] - Trigger price (required for SL-M)
   * @param {string} [params.validity='DAY'] - DAY or IOC
   * @returns {Promise<Object>} Order response with order_id
   */
  async placeOrder(params) {
    return this.breaker.execute(async () => {
      log.info({ params }, 'Placing Kite order');
      const response = await this.kite.placeOrder('regular', {
        exchange: params.exchange || 'NSE',
        tradingsymbol: params.tradingsymbol,
        transaction_type: params.transaction_type,
        quantity: params.quantity,
        order_type: params.order_type || 'MARKET',
        product: params.product || 'MIS',
        price: params.price,
        trigger_price: params.trigger_price,
        validity: params.validity || 'DAY',
      });
      log.info({ orderId: response.order_id }, 'Kite order placed');
      return response;
    });
  }

  /**
   * Place an emergency order that bypasses the circuit breaker OPEN state.
   * ONLY for use in stop-loss / force-exit paths.
   */
  async placeEmergencyOrder(params) {
    return this.breaker.execute(async () => {
      log.info({ params }, 'Placing emergency Kite order (circuit bypass)');
      const response = await this.kite.placeOrder('regular', {
        exchange: params.exchange || 'NSE',
        tradingsymbol: params.tradingsymbol,
        transaction_type: params.transaction_type,
        quantity: params.quantity,
        order_type: params.order_type || 'MARKET',
        product: params.product || 'MIS',
        price: params.price,
        trigger_price: params.trigger_price,
        validity: params.validity || 'DAY',
      });
      log.info({ orderId: response.order_id }, 'Emergency Kite order placed');
      return response;
    }, { force: true }); // C3 FIX: bypass OPEN circuit
  }

  /**
   * Modify an existing order.
   * @param {string} orderId - Order ID to modify
   * @param {Object} params - Fields to update (quantity, price, order_type, etc.)
   * @returns {Promise<Object>}
   */
  async modifyOrder(orderId, params) {
    return this.breaker.execute(async () => {
      log.info({ orderId, params }, 'Modifying Kite order');
      return this.kite.modifyOrder('regular', orderId, params);
    });
  }

  /**
   * Cancel an open order.
   * @param {string} orderId - Order ID to cancel
   * @returns {Promise<Object>}
   */
  async cancelOrder(orderId) {
    return this.breaker.execute(async () => {
      log.info({ orderId }, 'Cancelling Kite order');
      return this.kite.cancelOrder('regular', orderId);
    });
  }

  /**
   * Get all orders for the current trading day.
   * @returns {Promise<Object[]>} Array of order objects
   */
  async getOrders() {
    return this.breaker.execute(() => this.kite.getOrders());
  }

  /**
   * Get order history for a specific order ID.
   * @param {string} orderId
   * @returns {Promise<Object[]>} Array of order status updates
   */
  async getOrderHistory(orderId) {
    return this.breaker.execute(() => this.kite.getOrderHistory(orderId));
  }

  // ─── Portfolio ──────────────────────────────────────────

  /**
   * Get current positions (day + net).
   * @returns {Promise<{ day: Object[], net: Object[] }>}
   */
  async getPositions() {
    return this.breaker.execute(() => this.kite.getPositions());
  }

  /**
   * Get holdings (delivery/CNC stocks).
   * @returns {Promise<Object[]>}
   */
  async getHoldings() {
    return this.breaker.execute(() => this.kite.getHoldings());
  }

  // ─── Market Data ────────────────────────────────────────

  /**
   * Get live quotes for instruments.
   * @param {string[]} instruments - e.g. ['NSE:RELIANCE', 'NSE:TCS']
   * @returns {Promise<Object>} Quotes keyed by instrument
   */
  async getQuote(instruments) {
    return this.breaker.execute(async () => {
      const raw = await Promise.resolve(this.kite.getQuote(instruments));
      // M2 FIX: KiteConnect v3 wraps response in { data: {...} }
      if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') {
        const topKeys = Object.keys(raw);
        if (topKeys.length === 1 && topKeys[0] === 'data') {
          return raw.data;
        }
      }
      return raw;
    });
  }

  /**
   * Get Last Traded Price for instruments.
   * Wrapped in Promise.resolve() because KiteConnect SDK versions differ:
   *   v4+: returns Promise<{ 'NSE:RELIANCE': { last_price: ... } }>
   *   v3:  returns synchronously: { data: { 'NSE:RELIANCE': { last_price: ... } } }
   * M2 FIX: normalise both shapes to always return the instrument-keyed object.
   */
  async getLTP(instruments) {
    return this.breaker.execute(async () => {
      const raw = await Promise.resolve(this.kite.getLTP(instruments));
      // M2 FIX: KiteConnect v3 wraps response in { data: {...} }
      if (raw && typeof raw === 'object' && raw.data && typeof raw.data === 'object') {
        const topKeys = Object.keys(raw);
        if (topKeys.length === 1 && topKeys[0] === 'data') {
          return raw.data;
        }
      }
      return raw;
    });
  }

  /**
   * Get OHLC data for instruments.
   * @param {string[]} instruments
   * @returns {Promise<Object>}
   */
  async getOHLC(instruments) {
    return this.breaker.execute(() => this.kite.getOHLC(instruments));
  }

  /**
   * Get historical candle data.
   * @param {number} instrumentToken - Kite instrument token
   * @param {string} interval - minute, 3minute, 5minute, 15minute, 30minute, 60minute, day
   * @param {string|Date} from - Start date
   * @param {string|Date} to - End date
   * @param {boolean} [continuous=false] - For futures continuous data
   * @returns {Promise<Object>} Historical OHLCV candles
   */
  async getHistoricalData(instrumentToken, interval, from, to, continuous = false) {
    return this.breaker.execute(() =>
      this.kite.getHistoricalData(instrumentToken, interval, from, to, continuous)
    );
  }

  // ─── Instruments ────────────────────────────────────────

  /**
   * Get all tradeable instruments (dump).
   * @param {string} [exchange] - Filter by exchange (NSE, BSE, NFO)
   * @returns {Promise<Object[]>}
   */
  async getInstruments(exchange) {
    return this.breaker.execute(() => this.kite.getInstruments(exchange));
  }

  // ─── Account ────────────────────────────────────────────

  /**
   * Get user profile.
   * @returns {Promise<Object>}
   */
  async getProfile() {
    return this.breaker.execute(() => this.kite.getProfile());
  }

  /**
   * Get account margins.
   * @returns {Promise<Object>}
   */
  async getMargins() {
    return this.breaker.execute(() => this.kite.getMargins());
  }

  /**
   * Get circuit breaker status for monitoring.
   * @returns {Object}
   */
  getCircuitStatus() {
    return this.breaker.getStatus();
  }
}
