import axios from 'axios';
import { createLogger } from '../lib/logger.js';
import { CircuitBreaker } from './circuit-breaker.js';

const log = createLogger('angel-client');

/**
 * AngelOne Smart API client — fallback broker.
 *
 * Uses REST API calls via axios since Smart API SDK has CJS/ESM issues.
 * This is a lightweight implementation covering core trading operations.
 *
 * API Docs: https://smartapi.angelbroking.com/docs
 *
 * @example
 *   const angel = new AngelClient({
 *     apiKey: config.ANGEL_API_KEY,
 *     clientId: config.ANGEL_CLIENT_ID,
 *     password: config.ANGEL_PASSWORD,
 *     totpSecret: config.ANGEL_TOTP_SECRET,
 *   });
 *   await angel.authenticate();
 *   const positions = await angel.getPositions();
 */

const BASE_URL = 'https://apiconnect.angelbroking.com';

/** Map our order types to AngelOne's */
const ORDER_TYPE_MAP = {
  MARKET: 'MARKET',
  LIMIT: 'LIMIT',
  'SL-M': 'STOPLOSS_MARKET',
};

/** Map our exchanges to AngelOne's */
const EXCHANGE_MAP = {
  NSE: 'NSE',
  BSE: 'BSE',
  NFO: 'NFO',
};

export class AngelClient {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - SmartAPI key
   * @param {string} options.clientId - AngelOne client ID
   * @param {string} options.password - Account password
   * @param {string} [options.totpSecret] - TOTP secret for 2FA
   */
  constructor({ apiKey, clientId, password, totpSecret }) {
    this.apiKey = apiKey;
    this.clientId = clientId;
    this.password = password;
    this.totpSecret = totpSecret || '';
    this.name = 'angel';

    this.jwtToken = null;
    this.refreshToken = null;
    this.feedToken = null;

    /** @type {number|null} Epoch ms when JWT expires (AngelOne tokens last ~24h) */
    this.tokenExpiresAt = null;
    /** @type {boolean} Guard to prevent concurrent refresh attempts */
    this._isRefreshing = false;
    /** @type {Array<{resolve: Function, reject: Function}>} Queued requests waiting on token refresh */
    this._refreshQueue = [];

    this.http = axios.create({
      baseURL: BASE_URL,
      timeout: 15000,
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-UserType': 'USER',
        'X-SourceID': 'WEB',
        'X-ClientLocalIP': '127.0.0.1',
        'X-ClientPublicIP': '127.0.0.1',
        'X-MACAddress': '00:00:00:00:00:00',
        'X-PrivateKey': apiKey,
      },
    });

    this._setupInterceptors();

    this.breaker = new CircuitBreaker('angel-api', {
      failureThreshold: 5,
      cooldownMs: 30000,
      timeoutMs: 15000,
    });

    log.info('AngelOne Smart API client initialized');
  }

  /**
   * Setup axios response interceptor for automatic JWT refresh on 401.
   * When a 401 is received, queues concurrent requests and retries them
   * after re-authentication completes.
   * @private
   */
  _setupInterceptors() {
    this.http.interceptors.response.use(
      (response) => response,
      async (error) => {
        const originalRequest = error.config;

        // Only intercept 401s, and don't retry login/refresh endpoints
        const is401 = error.response?.status === 401;
        const isAuthEndpoint = originalRequest?.url?.includes('/loginByPassword') ||
                               originalRequest?.url?.includes('/generateToken');

        if (!is401 || isAuthEndpoint || originalRequest._retried) {
          return Promise.reject(error);
        }

        // If a refresh is already in progress, queue this request
        if (this._isRefreshing) {
          return new Promise((resolve, reject) => {
            this._refreshQueue.push({ resolve, reject });
          }).then(() => {
            originalRequest.headers['Authorization'] = `Bearer ${this.jwtToken}`;
            originalRequest._retried = true;
            return this.http(originalRequest);
          });
        }

        this._isRefreshing = true;
        originalRequest._retried = true;

        try {
          // Try refresh token first, fall back to full re-auth
          if (this.refreshToken) {
            await this._refreshJWT();
          } else {
            await this.authenticate();
          }

          // Retry the original request
          originalRequest.headers['Authorization'] = `Bearer ${this.jwtToken}`;

          // Drain queued requests
          this._refreshQueue.forEach(({ resolve }) => resolve());
          this._refreshQueue = [];

          return this.http(originalRequest);
        } catch (refreshErr) {
          // Reject all queued requests
          this._refreshQueue.forEach(({ reject }) => reject(refreshErr));
          this._refreshQueue = [];
          log.error({ err: refreshErr.message }, 'JWT refresh failed — all queued requests rejected');
          return Promise.reject(refreshErr);
        } finally {
          this._isRefreshing = false;
        }
      }
    );
  }

  /**
   * Refresh the JWT using the refresh token.
   * @private
   * @returns {Promise<void>}
   */
  async _refreshJWT() {
    log.info('Refreshing AngelOne JWT via refresh token');
    const res = await this.http.post('/rest/auth/angelbroking/jwt/v1/generateTokens', {
      refreshToken: this.refreshToken,
    });

    if (res.data?.status === false) {
      throw new Error(`AngelOne token refresh failed: ${res.data?.message || 'Unknown'}`);
    }

    this.jwtToken = res.data.data.jwtToken;
    this.refreshToken = res.data.data.refreshToken;
    this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000; // ~23 hours
    this.http.defaults.headers.common['Authorization'] = `Bearer ${this.jwtToken}`;
    log.info('AngelOne JWT refreshed successfully');
  }

  /**
   * Check if the JWT is expired or about to expire (within 5 min).
   * @returns {boolean}
   */
  isTokenExpired() {
    if (!this.tokenExpiresAt) return true;
    return Date.now() >= this.tokenExpiresAt - 5 * 60 * 1000;
  }

  // ─── Authentication ─────────────────────────────────────

  /**
   * Authenticate with AngelOne and obtain JWT + feed tokens.
   * @param {string} [totp] - Time-based OTP (if not using totpSecret)
   * @returns {Promise<Object>} Session data
   */
  async authenticate(totp) {
    return this.breaker.execute(async () => {
      const payload = {
        clientcode: this.clientId,
        password: this.password,
        ...(totp ? { totp } : {}),
      };

      const res = await this.http.post('/rest/auth/angelbroking/user/v1/loginByPassword', payload);

      if (res.data?.status === false) {
        throw new Error(`AngelOne auth failed: ${res.data?.message || 'Unknown error'}`);
      }

      this.jwtToken = res.data.data.jwtToken;
      this.refreshToken = res.data.data.refreshToken;
      this.feedToken = res.data.data.feedToken;
      this.tokenExpiresAt = Date.now() + 23 * 60 * 60 * 1000; // ~23 hours

      // Set auth header for subsequent requests
      this.http.defaults.headers.common['Authorization'] = `Bearer ${this.jwtToken}`;

      log.info({ clientId: this.clientId }, 'AngelOne authentication successful');
      return res.data.data;
    });
  }

  /**
   * Set JWT token directly (skip login).
   * @param {string} token
   */
  setAccessToken(token) {
    this.jwtToken = token;
    this.http.defaults.headers.common['Authorization'] = `Bearer ${token}`;
  }

  // ─── Orders ─────────────────────────────────────────────

  /**
   * Place an order on AngelOne.
   * @param {Object} params
   * @param {string} params.exchange - NSE, BSE, NFO
   * @param {string} params.tradingsymbol - Symbol name
   * @param {string} params.symboltoken - AngelOne symbol token
   * @param {string} params.transaction_type - BUY or SELL
   * @param {number} params.quantity - Order quantity
   * @param {string} [params.order_type='MARKET'] - MARKET, LIMIT, SL-M
   * @param {string} [params.product='INTRADAY'] - INTRADAY, DELIVERY
   * @param {number} [params.price=0] - Limit price
   * @param {number} [params.trigger_price=0] - Stop-loss trigger price
   * @returns {Promise<Object>} Order response
   */
  async placeOrder(params) {
    return this.breaker.execute(async () => {
      log.info({ params }, 'Placing AngelOne order');

      const payload = {
        variety: 'NORMAL',
        tradingsymbol: params.tradingsymbol,
        symboltoken: params.symboltoken || '',
        transactiontype: params.transaction_type,
        exchange: EXCHANGE_MAP[params.exchange] || 'NSE',
        ordertype: ORDER_TYPE_MAP[params.order_type] || 'MARKET',
        producttype: params.product === 'MIS' ? 'INTRADAY' : (params.product || 'INTRADAY'),
        duration: params.validity || 'DAY',
        price: params.price || 0,
        triggerprice: params.trigger_price || 0,
        quantity: String(params.quantity),
      };

      const res = await this.http.post('/rest/secure/angelbroking/order/v1/placeOrder', payload);
      log.info({ orderId: res.data.data?.orderid }, 'AngelOne order placed');
      return { order_id: res.data.data?.orderid, ...res.data.data };
    });
  }

  /**
   * Modify an existing order.
   * @param {string} orderId
   * @param {Object} params
   * @returns {Promise<Object>}
   */
  async modifyOrder(orderId, params) {
    return this.breaker.execute(async () => {
      log.info({ orderId, params }, 'Modifying AngelOne order');
      const payload = {
        variety: 'NORMAL',
        orderid: orderId,
        ...params,
      };
      const res = await this.http.post('/rest/secure/angelbroking/order/v1/modifyOrder', payload);
      return res.data.data;
    });
  }

  /**
   * Cancel an order.
   * @param {string} orderId
   * @returns {Promise<Object>}
   */
  async cancelOrder(orderId) {
    return this.breaker.execute(async () => {
      log.info({ orderId }, 'Cancelling AngelOne order');
      const payload = { variety: 'NORMAL', orderid: orderId };
      const res = await this.http.post('/rest/secure/angelbroking/order/v1/cancelOrder', payload);
      return res.data.data;
    });
  }

  /**
   * Get all orders for the day.
   * @returns {Promise<Object[]>}
   */
  async getOrders() {
    return this.breaker.execute(async () => {
      const res = await this.http.get('/rest/secure/angelbroking/order/v1/getOrderBook');
      return res.data.data || [];
    });
  }

  // ─── Portfolio ──────────────────────────────────────────

  /**
   * Get current positions.
   * @returns {Promise<Object[]>}
   */
  async getPositions() {
    return this.breaker.execute(async () => {
      const res = await this.http.get('/rest/secure/angelbroking/order/v1/getPosition');
      return res.data.data || [];
    });
  }

  /**
   * Get holdings.
   * @returns {Promise<Object[]>}
   */
  async getHoldings() {
    return this.breaker.execute(async () => {
      const res = await this.http.get('/rest/secure/angelbroking/portfolio/v1/getHolding');
      return res.data.data || [];
    });
  }

  // ─── Market Data ────────────────────────────────────────

  /**
   * Get LTP for instruments.
   * @param {string} exchange - NSE, BSE
   * @param {string} tradingsymbol - Symbol name
   * @param {string} symboltoken - Symbol token
   * @returns {Promise<Object>}
   */
  async getLTP(exchange, tradingsymbol, symboltoken) {
    return this.breaker.execute(async () => {
      const payload = { exchange, tradingsymbol, symboltoken };
      const res = await this.http.post('/rest/secure/angelbroking/order/v1/getLtpData', payload);
      return res.data.data;
    });
  }

  /**
   * Get candle/historical data.
   * @param {Object} params
   * @param {string} params.exchange - Exchange
   * @param {string} params.symboltoken - Symbol token
   * @param {string} params.interval - ONE_MINUTE, FIVE_MINUTE, etc.
   * @param {string} params.fromdate - Start date (yyyy-MM-dd HH:mm)
   * @param {string} params.todate - End date
   * @returns {Promise<Object[]>}
   */
  async getHistoricalData(params) {
    return this.breaker.execute(async () => {
      const res = await this.http.post('/rest/secure/angelbroking/historical/v1/getCandleData', params);
      return res.data.data || [];
    });
  }

  // ─── Account ────────────────────────────────────────────

  /**
   * Get user profile.
   * @returns {Promise<Object>}
   */
  async getProfile() {
    return this.breaker.execute(async () => {
      const res = await this.http.get('/rest/secure/angelbroking/user/v1/getProfile');
      return res.data.data;
    });
  }

  /**
   * Get account margins/funds.
   * @returns {Promise<Object>}
   */
  async getMargins() {
    return this.breaker.execute(async () => {
      const res = await this.http.get('/rest/secure/angelbroking/user/v1/getRMS');
      return res.data.data;
    });
  }

  /**
   * Get circuit breaker status.
   * @returns {Object}
   */
  getCircuitStatus() {
    return this.breaker.getStatus();
  }
}
