import axios from 'axios';
import { createLogger } from '../lib/logger.js';
import {
  tradeExecutedAlert,
  tradeRejectedAlert,
  dailySummaryAlert,
  killSwitchAlert,
  healthAlert,
} from './telegram-alerts.js';

const log = createLogger('telegram-bot');

/**
 * Telegram Bot — async message sender with queue.
 *
 * Key design: NEVER blocks trading logic. All sends are fire-and-forget
 * from the caller's perspective. Messages are queued and drained
 * sequentially to respect Telegram rate limits (~30 msgs/sec).
 *
 * @module telegram-bot
 */

/** Max queued messages before oldest are evicted. */
const MAX_QUEUE_SIZE = 100;

export class TelegramBot {
  /**
   * @param {Object} [config]
   * @param {string} [config.token] - Bot token from @BotFather
   * @param {string} [config.chatId] - Chat/group ID to send to
   * @param {boolean} [config.enabled=true] - Master enable flag
   * @param {number} [config.rateDelayMs=100] - Delay between messages (rate limit safety)
   * @param {number} [config.maxQueueSize] - Max queued messages (default 100)
   */
  constructor(config = {}) {
    this.token = config.token || process.env.TELEGRAM_BOT_TOKEN || '';
    this.chatId = config.chatId || process.env.TELEGRAM_CHAT_ID || '';
    this.enabled = config.enabled ?? (!!this.token && !!this.chatId);
    this.rateDelayMs = config.rateDelayMs ?? 100;
    this.maxQueueSize = config.maxQueueSize ?? MAX_QUEUE_SIZE;

    /** @type {{ text: string, resolve: Function }[]} */
    this._queue = [];
    this._draining = false;
    this._totalSent = 0;
    this._totalFailed = 0;
    this._totalDropped = 0;

    if (this.enabled) {
      log.info({ chatId: this.chatId }, 'TelegramBot initialized');
    } else {
      log.warn('TelegramBot DISABLED — missing token or chatId');
    }
  }

  // ═══════════════════════════════════════════════════════
  // PUBLIC API — High-level alert methods
  // ═══════════════════════════════════════════════════════

  /**
   * Alert 1: Trade executed.
   * @param {Object} trade - { symbol, side, quantity, price, strategy, orderId }
   */
  notifyTradeExecuted(trade) {
    return this._enqueue(tradeExecutedAlert(trade));
  }

  /**
   * Alert 2: Trade rejected.
   * @param {Object} rejection - { symbol, reason, strategy, side }
   */
  notifyTradeRejected(rejection) {
    return this._enqueue(tradeRejectedAlert(rejection));
  }

  /**
   * Alert 3: Daily summary.
   * @param {Object} summary - { pnl, tradeCount, winCount, lossCount, bestTrade, worstTrade }
   */
  notifyDailySummary(summary) {
    return this._enqueue(dailySummaryAlert(summary));
  }

  /**
   * Alert 4: Kill switch engaged.
   * @param {Object} data - { reason, openPositions, dailyPnL }
   */
  notifyKillSwitch(data) {
    return this._enqueue(killSwitchAlert(data));
  }

  /**
   * Alert 5: System health alert.
   * @param {Object} health - { broker, redis, db, detail }
   */
  notifyHealthAlert(health) {
    return this._enqueue(healthAlert(health));
  }

  /**
   * Send raw HTML message (for custom alerts).
   * @param {string} html
   */
  sendRaw(html) {
    return this._enqueue(html);
  }

  // ═══════════════════════════════════════════════════════
  // QUEUE — Never blocks trading logic
  // ═══════════════════════════════════════════════════════

  /**
   * Enqueue a message. Returns immediately — does NOT await delivery.
   * @private
   * @param {string} text - HTML message
   * @returns {Promise<void>} Resolves when queued (not when sent)
   */
  _enqueue(text) {
    if (!this.enabled) {
      log.debug('Telegram disabled — message dropped');
      return Promise.resolve();
    }

    // Evict oldest messages if queue is full
    while (this._queue.length >= this.maxQueueSize) {
      const evicted = this._queue.shift();
      evicted.resolve(); // Unblock any awaiter
      this._totalDropped++;
      log.warn({
        queueSize: this._queue.length,
        maxQueueSize: this.maxQueueSize,
        totalDropped: this._totalDropped,
      }, 'Telegram queue full — dropping oldest message');
    }

    return new Promise((resolve) => {
      this._queue.push({ text, resolve });
      // M5: catch prevents _draining flag deadlock on unexpected errors
      this._drain().catch((err) => {
        this._draining = false;
        log.error({ err: err.message }, 'Telegram drain error — flag reset');
      });
    });
  }

  /**
   * Drain the queue sequentially with rate limiting.
   * @private
   */
  async _drain() {
    if (this._draining) return;
    this._draining = true;

    while (this._queue.length > 0) {
      const { text, resolve } = this._queue.shift();

      try {
        await this._send(text);
        this._totalSent++;
      } catch (err) {
        this._totalFailed++;
        // Graceful failure — log, don't crash
        log.error({
          err: err.message,
          status: err.response?.status,
          queueRemaining: this._queue.length,
        }, 'Telegram send failed — message dropped');
      }

      resolve(); // Resolve regardless of success/failure

      // Rate limit safety
      if (this._queue.length > 0) {
        await this._delay(this.rateDelayMs);
      }
    }

    this._draining = false;
  }

  /**
   * Send a single message to Telegram API.
   * @private
   * @param {string} text - HTML formatted message
   */
  async _send(text) {
    const url = `https://api.telegram.org/bot${this.token}/sendMessage`;

    const response = await axios.post(url, {
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    }, {
      timeout: 10000, // 10s timeout
    });

    log.debug({
      messageId: response.data?.result?.message_id,
    }, 'Telegram message sent');

    return response.data;
  }

  // ═══════════════════════════════════════════════════════
  // STATUS
  // ═══════════════════════════════════════════════════════

  /**
   * Get bot status for monitoring.
   * @returns {Object}
   */
  getStatus() {
    return {
      enabled: this.enabled,
      chatId: this.chatId ? `***${this.chatId.slice(-4)}` : 'not set',
      queueLength: this._queue.length,
      maxQueueSize: this.maxQueueSize,
      totalSent: this._totalSent,
      totalFailed: this._totalFailed,
      totalDropped: this._totalDropped,
    };
  }

  /**
   * @private
   */
  _delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
