/**
 * Indian Rupee formatter and utility functions for notifications.
 *
 * Indian number system: 1,00,000 (not 100,000)
 * Pattern: last 3 digits, then groups of 2.
 *
 * @module format-utils
 */

/**
 * Format a number in Indian ₹ notation.
 * Examples: 1500 → ₹1,500 | 150000 → ₹1,50,000 | -2500 → -₹2,500
 *
 * @param {number} amount
 * @returns {string}
 */
export function formatINR(amount) {
  if (amount == null || isNaN(amount)) return '₹0';

  const isNeg = amount < 0;
  const abs = Math.abs(amount);
  const [intPart, decPart] = abs.toFixed(2).split('.');

  // Indian grouping: last 3, then groups of 2
  let formatted;
  if (intPart.length <= 3) {
    formatted = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const remaining = intPart.slice(0, -3);
    const grouped = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    formatted = `${grouped},${last3}`;
  }

  const result = decPart && decPart !== '00'
    ? `₹${formatted}.${decPart}`
    : `₹${formatted}`;

  return isNeg ? `-${result}` : result;
}

/**
 * Get PnL emoji based on value.
 * @param {number} pnl
 * @returns {string}
 */
export function pnlEmoji(pnl) {
  if (pnl > 0) return '🟢';
  if (pnl < 0) return '🔴';
  return '⚪';
}

/**
 * Escape HTML special characters for Telegram HTML mode.
 * @param {string} str
 * @returns {string}
 */
export function escapeHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Get current IST time string.
 * @returns {string}
 */
export function istTimestamp() {
  return new Date().toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'medium',
  });
}
