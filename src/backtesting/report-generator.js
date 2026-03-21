/**
 * @fileoverview Backtest report generator for Alpha8.
 *
 * Produces two outputs:
 *   1. Rich formatted terminal report with all key metrics
 *   2. CSV trade log export for Excel/Google Sheets analysis
 */

import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, dirname } from 'path';
import { compareStrategies } from './metrics-calculator.js';

/** Indian number formatting for ₹ amounts */
function formatINR(amount) {
  if (Math.abs(amount) >= 10_000_000) {
    return `₹${(amount / 10_000_000).toFixed(2)}Cr`;
  }
  if (Math.abs(amount) >= 100_000) {
    return `₹${(amount / 100_000).toFixed(2)}L`;
  }
  // Indian grouping: 12,34,567
  const num = Math.abs(Math.round(amount));
  const numStr = num.toString();
  let formatted = '';

  if (numStr.length <= 3) {
    formatted = numStr;
  } else {
    formatted = numStr.slice(-3);
    let remaining = numStr.slice(0, -3);
    while (remaining.length > 2) {
      formatted = remaining.slice(-2) + ',' + formatted;
      remaining = remaining.slice(0, -2);
    }
    formatted = remaining + ',' + formatted;
  }

  return (amount < 0 ? '-' : '') + '₹' + formatted;
}

/** Right-pad a string to N chars */
const rpad = (s, n) => String(s).padEnd(n);

/** Left-pad a string to N chars */
const lpad = (s, n) => String(s).padStart(n);

/** Colour helpers (ANSI — gracefully degrade in non-TTY) */
const isTTY = process.stdout.isTTY ?? false;
const green = s => isTTY ? `\x1b[32m${s}\x1b[0m` : s;
const red = s => isTTY ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = s => isTTY ? `\x1b[33m${s}\x1b[0m` : s;
const bold = s => isTTY ? `\x1b[1m${s}\x1b[0m` : s;
const dim = s => isTTY ? `\x1b[2m${s}\x1b[0m` : s;
const cyan = s => isTTY ? `\x1b[36m${s}\x1b[0m` : s;

/**
 * Colour a P&L number: green if positive, red if negative.
 */
function colourPnl(value, formatted) {
  if (value > 0) return green(formatted);
  if (value < 0) return red(formatted);
  return formatted;
}

/**
 * Generate and print a full backtest report to stdout.
 *
 * @param {object} params
 * @param {string}              params.symbol
 * @param {string[]}            params.strategies
 * @param {string}              params.fromDate
 * @param {string}              params.toDate
 * @param {object}              params.metrics     - from calculateMetrics()
 * @param {Array}               params.trades      - trade log
 * @param {string}              [params.dataSource]
 */
export function printReport({ symbol, strategies, fromDate, toDate, metrics, trades, dataSource = 'historical' }) {
  const W = 62; // report width
  const hr = '─'.repeat(W);
  const dhr = '═'.repeat(W);

  const returnSign = metrics.totalReturnPct >= 0 ? '+' : '';
  const returnStr = `${returnSign}${metrics.totalReturnPct}%`;

  console.log('');
  console.log(bold(`╔${'═'.repeat(W)}╗`));
  console.log(bold(`║${centre('Alpha8 — BACKTEST REPORT', W)}║`));
  console.log(bold(`╚${'═'.repeat(W)}╝`));
  console.log('');

  // ── Configuration ──────────────────────────────────────────────────────────
  console.log(bold(`  CONFIGURATION`));
  console.log(`  ${hr}`);
  console.log(`  Symbol        : ${bold(symbol)}`);
  console.log(`  Strategies    : ${strategies.join(', ')}`);
  console.log(`  Period        : ${fromDate} → ${toDate}`);
  console.log(`  Initial Cap.  : ${bold(formatINR(metrics.initialCapital))}`);
  console.log(`  Data Source   : ${dataSource}`);
  console.log('');

  // ── Returns summary ────────────────────────────────────────────────────────
  console.log(bold(`  RETURNS`));
  console.log(`  ${hr}`);
  console.log(`  Final Capital : ${bold(colourPnl(metrics.totalPnl, formatINR(metrics.finalCapital)))}`);
  console.log(`  Total P&L     : ${bold(colourPnl(metrics.totalPnl, formatINR(metrics.totalPnl)))}`);
  console.log(`  Total Return  : ${bold(colourPnl(metrics.totalReturnPct, returnStr))}`);
  console.log('');

  // ── Trade statistics ───────────────────────────────────────────────────────
  console.log(bold(`  TRADE STATISTICS`));
  console.log(`  ${hr}`);
  console.log(`  Total Trades  : ${bold(metrics.totalTrades)}`);
  console.log(`  Winning       : ${green(metrics.winningTrades)} (${metrics.winRate}%)`);
  console.log(`  Losing        : ${red(metrics.losingTrades)}`);
  console.log(`  Avg Win       : ${green('+' + metrics.avgWinPct + '%')}`);
  console.log(`  Avg Loss      : ${red(metrics.avgLossPct + '%')}`);
  console.log(`  Best Trade    : ${green('+' + metrics.bestTradePct + '%')}`);
  console.log(`  Worst Trade   : ${red(metrics.worstTradePct + '%')}`);
  console.log(`  Avg Duration  : ${metrics.avgTradeDurationMin} min`);
  console.log('');

  // ── Risk metrics ───────────────────────────────────────────────────────────
  console.log(bold(`  RISK METRICS`));
  console.log(`  ${hr}`);
  const sharpeColour = metrics.sharpeRatio >= 1 ? green : (metrics.sharpeRatio >= 0.5 ? yellow : red);
  const ddColour = metrics.maxDrawdownPct <= 5 ? green : (metrics.maxDrawdownPct <= 15 ? yellow : red);
  const pfColour = metrics.profitFactor >= 1.5 ? green : (metrics.profitFactor >= 1 ? yellow : red);

  console.log(`  Sharpe Ratio  : ${sharpeColour(bold(metrics.sharpeRatio))}`);
  console.log(`  Sortino Ratio : ${metrics.sortinoRatio}`);
  console.log(`  Calmar Ratio  : ${metrics.calmarRatio}`);
  console.log(`  Max Drawdown  : ${ddColour(metrics.maxDrawdownPct + '%')}`);
  console.log(`  Profit Factor : ${pfColour(metrics.profitFactor)}`);
  console.log('');

  // ── Exit breakdown ─────────────────────────────────────────────────────────
  if (trades.length > 0) {
    const signalExits = trades.filter(t => t.exitReason === 'SIGNAL').length;
    const stopExits = trades.filter(t => t.exitReason === 'STOP_LOSS').length;
    const squareOffExits = trades.filter(t => t.exitReason === 'SQUARE_OFF').length;

    console.log(bold(`  EXIT BREAKDOWN`));

    // ── Long vs Short breakdown ───────────────────────────────────────────
    if (metrics.directionBreakdown) {
      const { long, short } = metrics.directionBreakdown;
      console.log(bold(`  LONG vs SHORT`));
      console.log(`  ${hr}`);
      if (long.count > 0) {
        console.log(
          `  📈 Longs  : ${long.count} trades | ` +
          `${green(long.wins + 'W')} / ${red((long.count - long.wins) + 'L')} | ` +
          `${long.winRate}% WR | ` +
          colourPnl(long.pnl, formatINR(long.pnl))
        );
      }
      if (short.count > 0) {
        console.log(
          `  📉 Shorts : ${short.count} trades | ` +
          `${green(short.wins + 'W')} / ${red((short.count - short.wins) + 'L')} | ` +
          `${short.winRate}% WR | ` +
          colourPnl(short.pnl, formatINR(short.pnl))
        );
      }
      console.log('');
    }
    console.log(`  ${hr}`);
    console.log(`  Signal exits  : ${signalExits}`);
    console.log(`  Stop losses   : ${red(stopExits)}`);
    console.log(`  Square-offs   : ${yellow(squareOffExits)}`);
    console.log('');
  }

  // ── Cost summary ─────────────────────────────────────────────────────────
  if (trades.length > 0 && trades[0].totalCost !== undefined) {
    const totalCosts = trades.reduce((s, t) => s + (t.totalCost || 0), 0);
    const totalGross = trades.reduce((s, t) => s + (t.grossPnl || t.pnl || 0), 0);
    const totalNet = trades.reduce((s, t) => s + (t.pnl || 0), 0);
    console.log(bold(`  TRANSACTION COSTS`));
    console.log(`  ${hr}`);
    console.log(`  Total Charges  : ${red(formatINR(totalCosts))}`);
    console.log(`  Gross P&L      : ${colourPnl(totalGross, formatINR(totalGross))}`);
    console.log(`  Net P&L        : ${bold(colourPnl(totalNet, formatINR(totalNet)))}`);
    console.log(`  Cost/Trade avg : ${formatINR(totalCosts / trades.length)}`);
    console.log('');
  }

  // ── Equity curve (mini ASCII) ──────────────────────────────────────────────
  if (metrics.equityCurve.length > 2) {
    console.log(bold(`  EQUITY CURVE (mini)`));
    console.log(`  ${hr}`);
    console.log('  ' + miniEquityCurve(metrics.equityCurve, 50));
    console.log('');
  }

  // ── Assessment ────────────────────────────────────────────────────────────
  console.log(bold(`  ASSESSMENT`));
  console.log(`  ${hr}`);
  const assessment = assessStrategy(metrics);
  for (const line of assessment) {
    console.log(`  ${line}`);
  }
  console.log('');

  console.log(dim(`  ⚠️  Past performance does not guarantee future results.`));
  console.log(dim(`  This is a simulation. Always validate with paper trading first.`));
  console.log('');
}

/**
 * Print a strategy comparison table.
 *
 * @param {Array<{ name: string, metrics: object }>} results
 */
export function printComparison(results) {
  const ranked = compareStrategies(results);
  const W = 80;

  console.log('');
  console.log(bold('  STRATEGY COMPARISON'));
  console.log(`  ${'─'.repeat(W)}`);

  const header = [
    rpad('Strategy', 20),
    lpad('Return', 9),
    lpad('Win Rate', 9),
    lpad('Sharpe', 8),
    lpad('MaxDD', 8),
    lpad('PF', 6),
    lpad('Trades', 7),
  ].join('  ');

  console.log(`  ${bold(header)}`);
  console.log(`  ${'─'.repeat(W)}`);

  for (const r of ranked) {
    const row = [
      rpad(r.strategy, 20),
      lpad((r.returnPct >= 0 ? '+' : '') + r.returnPct + '%', 9),
      lpad(r.winRate + '%', 9),
      lpad(r.sharpe, 8),
      lpad(r.maxDrawdown + '%', 8),
      lpad(r.profitFactor === Infinity ? '∞' : r.profitFactor, 6),
      lpad(r.totalTrades, 7),
    ].join('  ');

    const colour = r.returnPct > 0 ? green : red;
    console.log(`  ${colour(row)}`);
  }

  console.log(`  ${'─'.repeat(W)}`);
  console.log(`  ${dim('Ranked by Sharpe Ratio (higher is better)')}`);
  console.log('');
}

/**
 * Export the complete trade log to CSV.
 *
 * @param {Array}  trades     - trade log from BacktestEngine
 * @param {string} outputDir  - directory to write CSV into
 * @param {string} fileName   - file name (without extension)
 * @returns {string}  full path to created CSV
 */
export function exportCsv(trades, outputDir, fileName) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const headers = [
    'symbol', 'strategy', 'entryTime', 'exitTime',
    'entryPrice', 'exitPrice', 'quantity',
    'pnl', 'pnlPct', 'exitReason', 'confidence',
    'entryReason',
  ];

  const rows = trades.map(t => [
    t.symbol,
    t.strategy,
    t.entryTime.toISOString(),
    t.exitTime.toISOString(),
    t.entryPrice,
    t.exitPrice,
    t.quantity,
    t.pnl,
    t.pnlPct,
    t.exitReason,
    t.confidence ?? '',
    `"${(t.entryReason ?? '').replace(/"/g, "'")}"`,
  ]);

  const csv = [
    headers.join(','),
    ...rows.map(r => r.join(',')),
  ].join('\n');

  const filePath = join(outputDir, `${fileName}.csv`);
  writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

/**
 * Export daily P&L series to CSV.
 *
 * @param {Array}  dailyPnl   - [{ date, pnl }]
 * @param {string} outputDir
 * @param {string} fileName
 * @returns {string}
 */
export function exportDailyPnlCsv(dailyPnl, outputDir, fileName) {
  if (!existsSync(outputDir)) mkdirSync(outputDir, { recursive: true });

  const headers = ['date', 'pnl'];
  const rows = dailyPnl.map(d => [d.date, d.pnl]);

  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n');

  const filePath = join(outputDir, `${fileName}_daily.csv`);
  writeFileSync(filePath, csv, 'utf8');
  return filePath;
}

// ── Helpers ────────────────────────────────────────────────────────────────

function centre(text, width) {
  const pad = Math.max(0, width - text.length);
  const left = Math.floor(pad / 2);
  const right = pad - left;
  return ' '.repeat(left) + text + ' '.repeat(right);
}

/**
 * Generate a mini ASCII equity curve.
 * @param {number[]} curve
 * @param {number}   width  - characters wide
 * @returns {string}
 */
function miniEquityCurve(curve, width) {
  const CHARS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
  const min = Math.min(...curve);
  const max = Math.max(...curve);
  const range = max - min;

  if (range === 0) return '─'.repeat(width);

  // Sample `width` points from the curve
  const step = (curve.length - 1) / (width - 1);
  const sampled = [];
  for (let i = 0; i < width; i++) {
    const idx = Math.round(i * step);
    sampled.push(curve[Math.min(idx, curve.length - 1)]);
  }

  return sampled.map(v => {
    const normalised = (v - min) / range;
    const idx = Math.min(Math.floor(normalised * CHARS.length), CHARS.length - 1);
    const ch = CHARS[idx];
    return v >= curve[0] ? green(ch) : red(ch);
  }).join('');
}

/**
 * Produce a one-line qualitative assessment of the strategy.
 * @param {object} metrics
 * @returns {string[]}
 */
function assessStrategy(metrics) {
  const lines = [];

  // Overall verdict
  if (metrics.sharpeRatio >= 1.5 && metrics.totalReturnPct > 0) {
    lines.push(green('✅ STRONG — High risk-adjusted returns. Good candidate for paper trading.'));
  } else if (metrics.sharpeRatio >= 0.8 && metrics.totalReturnPct > 0) {
    lines.push(yellow('⚠️  MODERATE — Positive returns but room for improvement.'));
  } else if (metrics.totalReturnPct > 0) {
    lines.push(yellow('⚠️  WEAK — Positive returns but poor risk-adjusted performance.'));
  } else {
    lines.push(red('❌ POOR — Negative returns. Do NOT use in paper trading.'));
  }

  // Win rate assessment
  if (metrics.winRate < 40) {
    lines.push(red(`   Win rate ${metrics.winRate}% is low. Strategy may need signal filtering.`));
  }

  // Drawdown assessment
  if (metrics.maxDrawdownPct > 20) {
    lines.push(red(`   Max drawdown ${metrics.maxDrawdownPct}% exceeds safe limits (>20%). High risk.`));
  } else if (metrics.maxDrawdownPct > 10) {
    lines.push(yellow(`   Max drawdown ${metrics.maxDrawdownPct}% is elevated. Consider tighter stops.`));
  }

  // Profit factor
  if (metrics.profitFactor < 1 && metrics.totalTrades > 5) {
    lines.push(red(`   Profit factor < 1 means losses outweigh gains.`));
  }

  // Sample size warning
  if (metrics.totalTrades < 20) {
    lines.push(yellow(`   Only ${metrics.totalTrades} trades — results may not be statistically significant.`));
  }

  return lines;
}
