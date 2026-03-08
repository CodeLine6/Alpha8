/**
 * Indian Rupee formatter + shared utilities for the dashboard.
 */

/**
 * Format in Indian ₹ notation: ₹1,50,000
 */
export function formatINR(amount) {
  if (amount == null || isNaN(amount)) return '₹0';
  const isNeg = amount < 0;
  const abs = Math.abs(amount);
  const [intPart, decPart] = abs.toFixed(2).split('.');
  let formatted;
  if (intPart.length <= 3) {
    formatted = intPart;
  } else {
    const last3 = intPart.slice(-3);
    const remaining = intPart.slice(0, -3);
    const grouped = remaining.replace(/\B(?=(\d{2})+(?!\d))/g, ',');
    formatted = `${grouped},${last3}`;
  }
  const result = decPart && decPart !== '00' ? `₹${formatted}.${decPart}` : `₹${formatted}`;
  return isNeg ? `-${result}` : result;
}

/**
 * PnL color class.
 */
export function pnlColor(val) {
  if (val > 0) return 'text-green-400';
  if (val < 0) return 'text-red-400';
  return 'text-slate-400';
}

/**
 * PnL badge variant.
 */
export function pnlBadge(val) {
  if (val > 0) return 'badge-green';
  if (val < 0) return 'badge-red';
  return 'badge-blue';
}

/**
 * Format percentage.
 */
export function formatPct(val) {
  if (val == null) return '0.0%';
  return `${val >= 0 ? '+' : ''}${val.toFixed(1)}%`;
}

/**
 * API base URL for dev.
 */
export const API_BASE = process.env.NEXT_PUBLIC_API_URL || '';
