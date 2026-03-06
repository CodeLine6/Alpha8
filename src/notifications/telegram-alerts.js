import { createLogger } from '../lib/logger.js';
import { formatINR, pnlEmoji, escapeHTML, istTimestamp } from './format-utils.js';

const log = createLogger('telegram');

/**
 * Telegram Alert Formatter.
 *
 * Generates HTML-formatted messages for all 5 alert types.
 * Uses Telegram HTML parse mode (not Markdown).
 *
 * @module telegram-alerts
 */

/**
 * Alert 1: Trade Executed
 *
 * @param {Object} trade
 * @param {string} trade.symbol
 * @param {string} trade.side - 'BUY' or 'SELL'
 * @param {number} trade.quantity
 * @param {number} trade.price
 * @param {string} trade.strategy
 * @param {string} [trade.orderId]
 * @returns {string} HTML message
 */
export function tradeExecutedAlert(trade) {
  const emoji = trade.side === 'BUY' ? '📈' : '📉';
  const sideLabel = trade.side === 'BUY' ? '🟢 BUY' : '🔴 SELL';

  return [
    `${emoji} <b>Trade Executed</b>`,
    '',
    `<b>Symbol:</b> ${escapeHTML(trade.symbol)}`,
    `<b>Direction:</b> ${sideLabel}`,
    `<b>Quantity:</b> ${trade.quantity}`,
    `<b>Price:</b> ${formatINR(trade.price)}`,
    `<b>Strategy:</b> ${escapeHTML(trade.strategy)}`,
    trade.orderId ? `<b>Order ID:</b> <code>${escapeHTML(trade.orderId)}</code>` : '',
    '',
    `<i>${istTimestamp()}</i>`,
  ].filter(Boolean).join('\n');
}

/**
 * Alert 2: Trade Rejected
 *
 * @param {Object} rejection
 * @param {string} rejection.symbol
 * @param {string} rejection.reason
 * @param {string} rejection.strategy
 * @param {string} [rejection.side]
 * @returns {string} HTML message
 */
export function tradeRejectedAlert(rejection) {
  return [
    `⚠️ <b>Trade Rejected</b>`,
    '',
    `<b>Symbol:</b> ${escapeHTML(rejection.symbol)}`,
    rejection.side ? `<b>Side:</b> ${rejection.side}` : '',
    `<b>Reason:</b> ${escapeHTML(rejection.reason)}`,
    `<b>Strategy:</b> ${escapeHTML(rejection.strategy)}`,
    '',
    `<i>${istTimestamp()}</i>`,
  ].filter(Boolean).join('\n');
}

/**
 * Alert 3: Daily Summary
 *
 * @param {Object} summary
 * @param {number} summary.pnl - Total P&L
 * @param {number} summary.tradeCount - Total trades
 * @param {number} [summary.winCount=0]
 * @param {number} [summary.lossCount=0]
 * @param {Object} [summary.bestTrade] - { symbol, pnl }
 * @param {Object} [summary.worstTrade] - { symbol, pnl }
 * @param {number} [summary.capitalDeployed]
 * @param {boolean} [summary.killSwitchEngaged=false]
 * @returns {string} HTML message
 */
export function dailySummaryAlert(summary) {
  const emoji = pnlEmoji(summary.pnl);
  const winRate = summary.tradeCount > 0
    ? ((summary.winCount || 0) / summary.tradeCount * 100).toFixed(1)
    : '0.0';

  const lines = [
    `📊 <b>Daily Summary</b>`,
    '',
    `${emoji} <b>Total P&amp;L:</b> ${formatINR(summary.pnl)}`,
    `<b>Trades:</b> ${summary.tradeCount}`,
    `<b>Win/Loss:</b> ${summary.winCount || 0}W / ${summary.lossCount || 0}L (${winRate}%)`,
  ];

  if (summary.bestTrade) {
    lines.push(
      `🏆 <b>Best:</b> ${escapeHTML(summary.bestTrade.symbol)} ${formatINR(summary.bestTrade.pnl)}`
    );
  }
  if (summary.worstTrade) {
    lines.push(
      `💔 <b>Worst:</b> ${escapeHTML(summary.worstTrade.symbol)} ${formatINR(summary.worstTrade.pnl)}`
    );
  }
  if (summary.capitalDeployed != null) {
    lines.push(`<b>Capital Deployed:</b> ${formatINR(summary.capitalDeployed)}`);
  }
  if (summary.killSwitchEngaged) {
    lines.push('', '🛑 <b>Kill switch was engaged today</b>');
  }

  lines.push('', `<i>${istTimestamp()}</i>`);
  return lines.join('\n');
}

/**
 * Alert 4: Kill Switch Engaged
 *
 * @param {Object} data
 * @param {string} data.reason
 * @param {number} [data.openPositions=0]
 * @param {number} [data.dailyPnL]
 * @returns {string} HTML message
 */
export function killSwitchAlert(data) {
  return [
    `🛑 <b>KILL SWITCH ENGAGED</b>`,
    '',
    `<b>Reason:</b> ${escapeHTML(data.reason)}`,
    `<b>Open Positions:</b> ${data.openPositions || 0}`,
    data.dailyPnL != null ? `<b>Daily P&amp;L:</b> ${formatINR(data.dailyPnL)}` : '',
    '',
    `⚠️ <i>All new orders are BLOCKED until manual reset.</i>`,
    '',
    `<i>${istTimestamp()}</i>`,
  ].filter(Boolean).join('\n');
}

/**
 * Alert 5: System Health Alert
 *
 * @param {Object} health
 * @param {boolean} health.broker
 * @param {boolean} health.redis
 * @param {boolean} health.db
 * @param {string} [health.detail] - Additional detail
 * @returns {string} HTML message
 */
export function healthAlert(health) {
  const statusIcon = (ok) => ok ? '✅' : '❌';

  return [
    `🏥 <b>System Health Alert</b>`,
    '',
    `${statusIcon(health.broker)} <b>Broker API:</b> ${health.broker ? 'Connected' : 'DOWN'}`,
    `${statusIcon(health.redis)} <b>Redis:</b> ${health.redis ? 'Connected' : 'DOWN'}`,
    `${statusIcon(health.db)} <b>Database:</b> ${health.db ? 'Connected' : 'DOWN'}`,
    health.detail ? `\n<b>Detail:</b> ${escapeHTML(health.detail)}` : '',
    '',
    `<i>${istTimestamp()}</i>`,
  ].filter(Boolean).join('\n');
}
