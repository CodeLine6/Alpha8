import EventEmitter from 'node:events';
import { createLogger } from '../lib/logger.js';
import { isMarketOpen } from './market-hours.js';

const log = createLogger('tick-feed');

/**
 * Real-time market data tick feed via Kite WebSocket.
 *
 * Wraps KiteTicker to emit normalized tick events. Supports subscribing
 * to multiple instrument tokens, automatic reconnection, and market
 * hours gating.
 *
 * Events emitted:
 *   - 'tick'    → { instrumentToken, symbol, ltp, open, high, low, close, volume, timestamp }
 *   - 'ohlcv'   → Aggregated OHLCV candle (emitted every N seconds)
 *   - 'connect'  → WebSocket connected
 *   - 'disconnect' → WebSocket disconnected
 *   - 'error'   → Connection error
 *
 * @example
 *   const feed = new TickFeed({ apiKey, accessToken });
 *   feed.subscribe([738561, 256265]); // RELIANCE, TCS instrument tokens
 *   feed.on('tick', (tick) => console.log(tick));
 *   feed.start();
 *
 * @extends EventEmitter
 */
export class TickFeed extends EventEmitter {
  /**
   * @param {Object} options
   * @param {string} options.apiKey - Kite API key
   * @param {string} options.accessToken - Kite access token
   * @param {boolean} [options.respectMarketHours=true] - Only connect during market hours
   * @param {number} [options.ohlcvIntervalMs=60000] - OHLCV aggregation interval (ms)
   * @param {Object} [options.symbolMap={}] - Map of instrumentToken → symbol name
   */
  constructor({ apiKey, accessToken, respectMarketHours = true, ohlcvIntervalMs = 60000, symbolMap = {} }) {
    super();
    this.apiKey = apiKey;
    this.accessToken = accessToken;
    this.respectMarketHours = respectMarketHours;
    this.ohlcvIntervalMs = ohlcvIntervalMs;
    this.symbolMap = symbolMap;

    /** @type {number[]} Subscribed instrument tokens */
    this.subscribedTokens = [];

    /** @type {WebSocket|null} */
    this.ws = null;

    /** @type {boolean} */
    this.isConnected = false;

    /** @type {boolean} */
    this._shouldRun = false;

    /** @type {NodeJS.Timeout|null} */
    this._reconnectTimer = null;

    /** @type {number} */
    this._reconnectAttempts = 0;

    /** @type {number} Max reconnect attempts before giving up */
    this._maxReconnectAttempts = 50;

    /** @type {Map<number, Object>} Running OHLCV aggregation per instrument */
    this._ohlcvBuffers = new Map();

    /** @type {NodeJS.Timeout|null} */
    this._ohlcvTimer = null;

    /** @type {Map<number, Object>} Latest tick per instrument */
    this.latestTicks = new Map();
  }

  /**
   * Subscribe to instrument tokens for live ticks.
   * @param {number[]} tokens - Kite instrument tokens
   * @param {string} [mode='full'] - 'full', 'quote', or 'ltp'
   */
  subscribe(tokens, mode = 'full') {
    this.subscribedTokens = [...new Set([...this.subscribedTokens, ...tokens])];
    log.info({ tokens, total: this.subscribedTokens.length }, 'Subscribed to instruments');

    // If already connected, send subscription message
    if (this.isConnected && this.ws) {
      this._sendSubscription(tokens, mode);
    }
  }

  /**
   * Unsubscribe from instrument tokens.
   * @param {number[]} tokens
   */
  unsubscribe(tokens) {
    this.subscribedTokens = this.subscribedTokens.filter((t) => !tokens.includes(t));
    tokens.forEach((t) => {
      this._ohlcvBuffers.delete(t);
      this.latestTicks.delete(t);
    });
    log.info({ tokens, remaining: this.subscribedTokens.length }, 'Unsubscribed from instruments');
  }

  /**
   * Start the tick feed. Connects WebSocket if market is open.
   */
  start() {
    this._shouldRun = true;
    log.info('Tick feed starting...');

    if (this.respectMarketHours && !isMarketOpen()) {
      log.info('Market is closed — tick feed will wait for market hours');
      return;
    }

    this._connect();
    this._startOHLCVAggregation();
  }

  /**
   * Stop the tick feed and disconnect WebSocket.
   */
  stop() {
    this._shouldRun = false;
    this._stopOHLCVAggregation();

    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }

    this.isConnected = false;
    log.info('Tick feed stopped');
  }

  /**
   * Connect to Kite WebSocket.
   * @private
   */
  async _connect() {
    try {
      // Use dynamic import to handle ws module
      const { default: WebSocket } = await import('ws');

      const wsUrl = `wss://ws.kite.trade?api_key=${this.apiKey}&access_token=${this.accessToken}`;

      this.ws = new WebSocket(wsUrl);

      this.ws.on('open', () => {
        this.isConnected = true;
        this._reconnectAttempts = 0;
        log.info('WebSocket connected to Kite Ticker');
        this.emit('connect');

        // Subscribe to tokens
        if (this.subscribedTokens.length > 0) {
          this._sendSubscription(this.subscribedTokens, 'full');
        }
      });

      this.ws.on('message', (data) => {
        this._handleMessage(data);
      });

      this.ws.on('close', (code, reason) => {
        this.isConnected = false;
        log.warn({ code, reason: reason?.toString() }, 'WebSocket disconnected');
        this.emit('disconnect', { code, reason: reason?.toString() });
        this._scheduleReconnect();
      });

      this.ws.on('error', (err) => {
        log.error({ err: err.message }, 'WebSocket error');
        this.emit('error', err);
      });
    } catch (err) {
      log.error({ err: err.message }, 'Failed to create WebSocket connection');
      this.emit('error', err);
      this._scheduleReconnect();
    }
  }

  /**
   * Send subscription message to WebSocket.
   * @private
   */
  _sendSubscription(tokens, mode) {
    if (!this.ws || this.ws.readyState !== 1) return;

    // Kite ticker expects binary subscription, but for simplicity
    // we handle it as JSON mode messages
    try {
      this.ws.send(JSON.stringify({ a: 'subscribe', v: tokens }));
      this.ws.send(JSON.stringify({ a: 'mode', v: [mode, tokens] }));
      log.info({ tokens: tokens.length, mode }, 'Subscription sent');
    } catch (err) {
      log.error({ err: err.message }, 'Failed to send subscription');
    }
  }

  /**
   * Handle incoming WebSocket message.
   * Parses binary Kite tick data and emits normalized tick events.
   * @private
   */
  _handleMessage(data) {
    try {
      // Kite sends binary data for ticks
      // For text messages (heartbeat, etc.), handle separately
      if (typeof data === 'string') {
        const parsed = JSON.parse(data);
        if (parsed.type === 'order') {
          this.emit('order_update', parsed.data);
        }
        return;
      }

      // Parse binary tick data
      const ticks = this._parseBinaryTicks(data);

      ticks.forEach((tick) => {
        const normalizedTick = {
          instrumentToken: tick.instrumentToken,
          symbol: this.symbolMap[tick.instrumentToken] || `TOKEN:${tick.instrumentToken}`,
          ltp: tick.lastPrice,
          open: tick.ohlc?.open || 0,
          high: tick.ohlc?.high || 0,
          low: tick.ohlc?.low || 0,
          close: tick.ohlc?.close || 0,
          volume: tick.volume || 0,
          change: tick.change || 0,
          timestamp: new Date().toISOString(),
        };

        this.latestTicks.set(tick.instrumentToken, normalizedTick);
        this._updateOHLCVBuffer(tick.instrumentToken, normalizedTick);
        this.emit('tick', normalizedTick);
      });
    } catch (err) {
      log.error({ err: err.message }, 'Failed to parse tick data');
    }
  }

  /**
   * Parse binary tick data from Kite WebSocket.
   * Kite sends data in a specific binary format — simplified parser here.
   * @private
   * @param {Buffer} data
   * @returns {Object[]}
   */
  _parseBinaryTicks(data) {
    const buffer = Buffer.from(data);
    const ticks = [];

    // Kite binary format: first 2 bytes = number of packets
    // Each packet: first 4 bytes = instrument token, rest depends on mode
    if (buffer.length < 4) return ticks;

    try {
      const numPackets = buffer.readInt16BE(0);
      let offset = 2;

      for (let i = 0; i < numPackets && offset < buffer.length; i++) {
        const packetLength = buffer.readInt16BE(offset);
        offset += 2;

        if (offset + packetLength > buffer.length) break;

        const instrumentToken = buffer.readInt32BE(offset);

        // LTP mode (8 bytes packet)
        if (packetLength === 8) {
          ticks.push({
            instrumentToken,
            lastPrice: buffer.readInt32BE(offset + 4) / 100,
          });
        }
        // Quote mode (28 bytes) or Full mode (44 bytes)
        else if (packetLength >= 28) {
          ticks.push({
            instrumentToken,
            lastPrice: buffer.readInt32BE(offset + 4) / 100,
            ohlc: {
              open: buffer.readInt32BE(offset + 16) / 100,
              high: buffer.readInt32BE(offset + 8) / 100,
              low: buffer.readInt32BE(offset + 12) / 100,
              close: buffer.readInt32BE(offset + 20) / 100,
            },
            volume: buffer.readUInt32BE(offset + 24),
            change: packetLength >= 32 ? buffer.readInt32BE(offset + 28) / 100 : 0,
          });
        }

        offset += packetLength;
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Binary tick parse error — partial data');
    }

    return ticks;
  }

  /**
   * Update OHLCV buffer for aggregation.
   * @private
   */
  _updateOHLCVBuffer(token, tick) {
    if (!this._ohlcvBuffers.has(token)) {
      this._ohlcvBuffers.set(token, {
        symbol: tick.symbol,
        open: tick.ltp,
        high: tick.ltp,
        low: tick.ltp,
        close: tick.ltp,
        volume: 0,
        lastVolume: tick.volume || 0, // H2: Track cumulative volume for delta
        tickCount: 0,
      });
    }

    const buf = this._ohlcvBuffers.get(token);
    buf.high = Math.max(buf.high, tick.ltp);
    buf.low = Math.min(buf.low, tick.ltp);
    buf.close = tick.ltp;
    buf.volume = tick.volume; // Cumulative from exchange
    buf.tickCount++;
  }

  /**
   * Start periodic OHLCV candle emission.
   * @private
   */
  _startOHLCVAggregation() {
    this._ohlcvTimer = setInterval(() => {
      this._ohlcvBuffers.forEach((buf, token) => {
        // H3: Skip emission if no ticks received (WS disconnected)
        if (buf.tickCount === 0) {
          log.debug({ token, symbol: buf.symbol }, 'Skipping OHLCV emission — no ticks this interval');
          return;
        }

        // H2: Calculate per-candle volume delta
        const candleVolume = buf.volume - buf.lastVolume;

        this.emit('ohlcv', {
          instrumentToken: token,
          symbol: buf.symbol,
          open: buf.open,
          high: buf.high,
          low: buf.low,
          close: buf.close,
          volume: Math.max(candleVolume, 0), // H2: Per-candle delta, not cumulative
          tickCount: buf.tickCount,
          timestamp: new Date().toISOString(),
        });

        // Reset for next interval
        this._ohlcvBuffers.set(token, {
          symbol: buf.symbol,
          open: buf.close,
          high: buf.close,
          low: buf.close,
          close: buf.close,
          volume: buf.volume,
          lastVolume: buf.volume, // H2: Carry forward for next delta
          tickCount: 0,
        });
      });
    }, this.ohlcvIntervalMs);

    this._ohlcvTimer.unref();
  }

  /**
   * Stop OHLCV aggregation.
   * @private
   */
  _stopOHLCVAggregation() {
    if (this._ohlcvTimer) {
      clearInterval(this._ohlcvTimer);
      this._ohlcvTimer = null;
    }
  }

  /**
   * Schedule a reconnection attempt with exponential backoff.
   * @private
   */
  _scheduleReconnect() {
    if (!this._shouldRun) return;
    if (this._reconnectAttempts >= this._maxReconnectAttempts) {
      log.error('Max reconnect attempts reached — tick feed stopped');
      this.emit('error', new Error('Max reconnect attempts exceeded'));
      return;
    }

    // Check market hours before reconnecting
    if (this.respectMarketHours && !isMarketOpen()) {
      log.info('Market closed — skipping reconnect');
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, this._reconnectAttempts), 30000);
    this._reconnectAttempts++;

    log.info({ attempt: this._reconnectAttempts, delayMs: delay }, 'Scheduling reconnect');

    this._reconnectTimer = setTimeout(() => {
      this._connect();
    }, delay);

    this._reconnectTimer.unref();
  }

  /**
   * Get the latest tick for an instrument.
   * @param {number} instrumentToken
   * @returns {Object|null}
   */
  getLatestTick(instrumentToken) {
    return this.latestTicks.get(instrumentToken) || null;
  }

  /**
   * Get all latest ticks.
   * @returns {Map<number, Object>}
   */
  getAllLatestTicks() {
    return this.latestTicks;
  }

  /**
   * Get feed status for monitoring.
   * @returns {Object}
   */
  getStatus() {
    return {
      isConnected: this.isConnected,
      subscribedTokens: this.subscribedTokens.length,
      reconnectAttempts: this._reconnectAttempts,
      latestTickCount: this.latestTicks.size,
      ohlcvBuffers: this._ohlcvBuffers.size,
    };
  }
}
