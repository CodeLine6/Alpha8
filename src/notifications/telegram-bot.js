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

    this._commandHandlers = new Map();
    this._isPolling = false;
    this._lastUpdateId = 0;

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

  /**
   * Register a command listener (e.g. '/reset')
   * @param {string} command
   * @param {Function} handler - Async callback
   */
  onCommand(command, handler) {
    this._commandHandlers.set(command, handler);
    log.info({ command }, 'Telegram command handler registered');
  }

  /**
   * Start polling for incoming messages.
   * Discards all historical messages on boot to prevent replay of old commands.
   */
  async startPolling(intervalMs = 5000) {
    if (!this.enabled || this._isPolling) return;
    this._isPolling = true;

    // N6 FIX: Discard the backlog with one retry. If both attempts fail,
    // do NOT start polling — replaying /reset_kill_switch is more dangerous
    // than missing new commands. The operator can restart to pick up commands.
    const discardBacklog = async () => {
      const url = `https://api.telegram.org/bot${this.token}/getUpdates`;
      const response = await axios.get(url, { params: { timeout: 0 }, timeout: 8000 });
      if (response.data?.ok && response.data.result.length > 0) {
        this._lastUpdateId = response.data.result.at(-1).update_id;
        log.info({ discardedUpTo: this._lastUpdateId }, 'Telegram backlog discarded');
      }
    };

    try {
      await discardBacklog();
    } catch (firstErr) {
      log.warn({ err: firstErr.message }, 'Telegram backlog discard failed — retrying once');
      try {
        await new Promise(r => setTimeout(r, 3000));
        await discardBacklog();
      } catch (retryErr) {
        log.error(
          { err: retryErr.message },
          'Could not discard Telegram backlog after retry. ' +
          'Polling will NOT start to prevent command replay (e.g. /reset_kill_switch). ' +
          'Restart the process once network is stable.'
        );
        this._isPolling = false;
        return; // explicitly do not start polling
      }
    }

    log.info('Telegram polling started');

    // Fire and forget polling loop
    this._pollLoop(intervalMs).catch(err => {
      log.error({ err: err.message }, 'Telegram polling loop crashed');
      this._isPolling = false;
    });
  }

  /**
   * Stop polling.
   */
  stopPolling() {
    this._isPolling = false;
    log.info('Telegram polling stopped');
  }

  /**
   * @private
   */
  async _pollLoop(intervalMs) {
    while (this._isPolling) {
      try {
        const url = `https://api.telegram.org/bot${this.token}/getUpdates`;
        const params = {
          offset: this._lastUpdateId + 1,
          timeout: 10,
          allowed_updates: ['message']
        };

        const response = await axios.get(url, { params, timeout: 15000 });
        const data = response.data;

        if (data && data.ok && Array.isArray(data.result)) {
          for (const update of data.result) {
            this._lastUpdateId = Math.max(this._lastUpdateId, update.update_id);
            this._handleIncomingUpdate(update); // Fire without awaiting to keep draining
          }
        }
      } catch (err) {
        log.debug({ err: err.message }, 'Telegram getUpdates polled');
      }

      await this._delay(intervalMs);
    }
  }

  /**
   * @private
   */
  async _handleIncomingUpdate(update) {
    const message = update.message;
    if (!message || !message.text) return;

    const senderChatId = message.chat.id.toString();

    // Security: Only process commands from our configured chatId
    if (senderChatId !== this.chatId.toString()) {
      return;
    }

    const text = message.text.trim();
    for (const [cmd, handler] of this._commandHandlers.entries()) {
      if (text.startsWith(cmd)) {
        log.info({ command: cmd }, 'Executing Telegram command');
        try {
          await handler(text, message);
        } catch (err) {
          log.error({ err: err.message, command: cmd }, 'Telegram command handler failed');
        }
        return;
      }
    }
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
