/**
 * Unit tests for the Telegram notifications module.
 * Tests formatINR, all 5 alert formatters, and TelegramBot queue.
 */

import { describe, test, expect, jest } from '@jest/globals';
import { formatINR, pnlEmoji, escapeHTML } from '../src/notifications/format-utils.js';
import {
  tradeExecutedAlert,
  tradeRejectedAlert,
  dailySummaryAlert,
  killSwitchAlert,
  healthAlert,
} from '../src/notifications/telegram-alerts.js';
import { TelegramBot } from '../src/notifications/telegram-bot.js';

// ═══════════════════════════════════════════════════════════
// FORMAT UTILS
// ═══════════════════════════════════════════════════════════

describe('formatINR', () => {
  test('should format basic amounts', () => {
    expect(formatINR(1500)).toBe('₹1,500');
    expect(formatINR(100)).toBe('₹100');
    expect(formatINR(0)).toBe('₹0');
  });

  test('should use Indian grouping (lakhs/crores)', () => {
    expect(formatINR(150000)).toBe('₹1,50,000');
    expect(formatINR(10000000)).toBe('₹1,00,00,000');
    expect(formatINR(1234567)).toBe('₹12,34,567');
  });

  test('should handle negative amounts', () => {
    expect(formatINR(-2500)).toBe('-₹2,500');
    expect(formatINR(-150000)).toBe('-₹1,50,000');
  });

  test('should handle decimals', () => {
    expect(formatINR(1500.75)).toBe('₹1,500.75');
    expect(formatINR(100.50)).toBe('₹100.50');
  });

  test('should handle edge cases', () => {
    expect(formatINR(null)).toBe('₹0');
    expect(formatINR(undefined)).toBe('₹0');
    expect(formatINR(NaN)).toBe('₹0');
  });

  test('should drop .00 decimal', () => {
    expect(formatINR(1500.00)).toBe('₹1,500');
  });
});

describe('pnlEmoji', () => {
  test('should return green for profit', () => {
    expect(pnlEmoji(100)).toBe('🟢');
  });

  test('should return red for loss', () => {
    expect(pnlEmoji(-50)).toBe('🔴');
  });

  test('should return white for zero', () => {
    expect(pnlEmoji(0)).toBe('⚪');
  });
});

describe('escapeHTML', () => {
  test('should escape special characters', () => {
    expect(escapeHTML('<script>')).toBe('&lt;script&gt;');
    expect(escapeHTML('A & B')).toBe('A &amp; B');
  });

  test('should handle null/undefined', () => {
    expect(escapeHTML(null)).toBe('');
    expect(escapeHTML(undefined)).toBe('');
  });
});

// ═══════════════════════════════════════════════════════════
// ALERT FORMATTERS
// ═══════════════════════════════════════════════════════════

describe('tradeExecutedAlert', () => {
  test('should format BUY trade', () => {
    const msg = tradeExecutedAlert({
      symbol: 'RELIANCE',
      side: 'BUY',
      quantity: 10,
      price: 2500,
      strategy: 'EMA_CROSSOVER',
    });

    expect(msg).toContain('Trade Executed');
    expect(msg).toContain('RELIANCE');
    expect(msg).toContain('🟢 BUY');
    expect(msg).toContain('10');
    expect(msg).toContain('₹2,500');
    expect(msg).toContain('EMA_CROSSOVER');
    expect(msg).toContain('📈');
  });

  test('should format SELL trade', () => {
    const msg = tradeExecutedAlert({
      symbol: 'TCS',
      side: 'SELL',
      quantity: 5,
      price: 3000,
      strategy: 'RSI_MEAN_REVERSION',
    });

    expect(msg).toContain('🔴 SELL');
    expect(msg).toContain('📉');
  });

  test('should include optional orderId', () => {
    const msg = tradeExecutedAlert({
      symbol: 'INFY',
      side: 'BUY',
      quantity: 1,
      price: 1500,
      strategy: 'test',
      orderId: 'ORD-123',
    });

    expect(msg).toContain('ORD-123');
  });
});

describe('tradeRejectedAlert', () => {
  test('should format rejection', () => {
    const msg = tradeRejectedAlert({
      symbol: 'RELIANCE',
      reason: 'Daily loss limit exceeded',
      strategy: 'EMA_CROSSOVER',
    });

    expect(msg).toContain('Trade Rejected');
    expect(msg).toContain('⚠️');
    expect(msg).toContain('RELIANCE');
    expect(msg).toContain('Daily loss limit exceeded');
    expect(msg).toContain('EMA_CROSSOVER');
  });
});

describe('dailySummaryAlert', () => {
  test('should format full summary with best/worst', () => {
    const msg = dailySummaryAlert({
      pnl: 5000,
      tradeCount: 10,
      winCount: 7,
      lossCount: 3,
      bestTrade: { symbol: 'INFY', pnl: 2000 },
      worstTrade: { symbol: 'TCS', pnl: -500 },
    });

    expect(msg).toContain('Daily Summary');
    expect(msg).toContain('🟢'); // profit
    expect(msg).toContain('₹5,000');
    expect(msg).toContain('7W / 3L');
    expect(msg).toContain('70.0%');
    expect(msg).toContain('🏆');
    expect(msg).toContain('INFY');
    expect(msg).toContain('₹2,000');
    expect(msg).toContain('💔');
    expect(msg).toContain('TCS');
  });

  test('should format loss summary', () => {
    const msg = dailySummaryAlert({
      pnl: -3000,
      tradeCount: 5,
      winCount: 1,
      lossCount: 4,
    });

    expect(msg).toContain('🔴');
    expect(msg).toContain('-₹3,000');
  });

  test('should show kill switch warning when engaged', () => {
    const msg = dailySummaryAlert({
      pnl: -5000,
      tradeCount: 3,
      killSwitchEngaged: true,
    });

    expect(msg).toContain('🛑');
    expect(msg).toContain('Kill switch');
  });

  test('should handle zero trades', () => {
    const msg = dailySummaryAlert({
      pnl: 0,
      tradeCount: 0,
    });

    expect(msg).toContain('0');
    expect(msg).toContain('0.0%');
  });
});

describe('killSwitchAlert', () => {
  test('should format kill switch alert', () => {
    const msg = killSwitchAlert({
      reason: 'Drawdown exceeded 5%',
      openPositions: 3,
      dailyPnL: -5000,
    });

    expect(msg).toContain('🛑');
    expect(msg).toContain('KILL SWITCH ENGAGED');
    expect(msg).toContain('Drawdown exceeded 5%');
    expect(msg).toContain('3');
    expect(msg).toContain('-₹5,000');
    expect(msg).toContain('BLOCKED');
  });
});

describe('healthAlert', () => {
  test('should format healthy status', () => {
    const msg = healthAlert({ broker: true, redis: true, db: true });

    expect(msg).toContain('System Health');
    expect(msg).toContain('✅');
    expect(msg).toContain('Connected');
  });

  test('should format unhealthy status', () => {
    const msg = healthAlert({
      broker: false,
      redis: true,
      db: false,
      detail: 'Broker API unresponsive',
    });

    expect(msg).toContain('❌');
    expect(msg).toContain('DOWN');
    expect(msg).toContain('Broker API unresponsive');
  });
});

// ═══════════════════════════════════════════════════════════
// TELEGRAM BOT
// ═══════════════════════════════════════════════════════════

describe('TelegramBot', () => {
  test('should be disabled when no token/chatId', () => {
    const bot = new TelegramBot({ token: '', chatId: '' });
    expect(bot.enabled).toBe(false);
  });

  test('should drop messages when disabled', async () => {
    const bot = new TelegramBot({ enabled: false });

    await bot.notifyTradeExecuted({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500, strategy: 'EMA',
    });

    expect(bot._totalSent).toBe(0);
    expect(bot._queue).toHaveLength(0);
  });

  test('should enqueue messages when enabled', async () => {
    const bot = new TelegramBot({
      token: 'test-token',
      chatId: '12345',
      enabled: true,
      rateDelayMs: 0,
    });

    // Override _send to avoid actual HTTP call
    bot._send = jest.fn(async () => ({ ok: true }));

    await bot.notifyTradeExecuted({
      symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000, strategy: 'RSI',
    });

    // Wait for drain
    await new Promise((r) => setTimeout(r, 50));

    expect(bot._send).toHaveBeenCalled();
    expect(bot._totalSent).toBe(1);

    const sentHtml = bot._send.mock.calls[0][0];
    expect(sentHtml).toContain('TCS');
    expect(sentHtml).toContain('Trade Executed');
  });

  test('should handle _send failure gracefully', async () => {
    const bot = new TelegramBot({
      token: 'test-token',
      chatId: '12345',
      enabled: true,
      rateDelayMs: 0,
    });

    bot._send = jest.fn(async () => { throw new Error('Network error'); });

    await bot.notifyKillSwitch({
      reason: 'Drawdown exceeded',
      openPositions: 2,
    });

    await new Promise((r) => setTimeout(r, 50));

    expect(bot._totalFailed).toBe(1);
    expect(bot._totalSent).toBe(0);
    // Should not throw — just log
  });

  test('should process queue sequentially', async () => {
    const bot = new TelegramBot({
      token: 'test-token',
      chatId: '12345',
      enabled: true,
      rateDelayMs: 0,
    });

    const order = [];
    bot._send = jest.fn(async (text) => {
      order.push(text.includes('RELIANCE') ? 'R' : 'T');
    });

    bot.notifyTradeExecuted({
      symbol: 'RELIANCE', side: 'BUY', quantity: 10, price: 2500, strategy: 'A',
    });
    bot.notifyTradeExecuted({
      symbol: 'TCS', side: 'BUY', quantity: 5, price: 3000, strategy: 'B',
    });

    await new Promise((r) => setTimeout(r, 100));

    expect(order).toEqual(['R', 'T']); // FIFO
    expect(bot._totalSent).toBe(2);
  });

  test('getStatus should return bot state', () => {
    const bot = new TelegramBot({ token: 'abc', chatId: '99999' });
    const status = bot.getStatus();

    expect(status.enabled).toBe(true);
    expect(status.chatId).toContain('***');
    expect(status.queueLength).toBe(0);
    expect(status.totalSent).toBe(0);
    expect(status.totalFailed).toBe(0);
  });

  test('all 5 alert methods should be callable', async () => {
    const bot = new TelegramBot({ enabled: false });

    // None should throw
    await bot.notifyTradeExecuted({ symbol: 'A', side: 'BUY', quantity: 1, price: 100, strategy: 'x' });
    await bot.notifyTradeRejected({ symbol: 'B', reason: 'test', strategy: 'y' });
    await bot.notifyDailySummary({ pnl: 0, tradeCount: 0 });
    await bot.notifyKillSwitch({ reason: 'test' });
    await bot.notifyHealthAlert({ broker: true, redis: true, db: true });
  });

  test('should evict oldest messages when queue exceeds maxQueueSize', async () => {
    const bot = new TelegramBot({
      token: 'test-token',
      chatId: '12345',
      enabled: true,
      maxQueueSize: 3,
      rateDelayMs: 0,
    });

    // Block the drain so messages pile up
    let unblock;
    bot._send = jest.fn(() => new Promise((resolve) => { unblock = resolve; }));

    // Enqueue 5 messages (cap is 3). First one starts draining immediately,
    // so queue holds items 2-5. Items 2 gets evicted when 5 arrives.
    bot.sendRaw('msg-1');
    bot.sendRaw('msg-2');
    bot.sendRaw('msg-3');
    bot.sendRaw('msg-4');
    bot.sendRaw('msg-5');

    // Oldest queued messages should have been dropped
    expect(bot._totalDropped).toBeGreaterThan(0);

    // Unblock drain and let it finish
    unblock({ ok: true });
    await new Promise((r) => setTimeout(r, 100));

    const status = bot.getStatus();
    expect(status.totalDropped).toBeGreaterThan(0);
    expect(status.maxQueueSize).toBe(3);
  });
});
