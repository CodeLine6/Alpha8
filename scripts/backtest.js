#!/usr/bin/env node

/**
 * @fileoverview Alpha8 Backtesting CLI
 *
 * Usage:
 *   node scripts/backtest.js [options]
 *
 * Options:
 *   --symbol     NSE trading symbol (e.g. RELIANCE)          [required]
 *   --strategy   Strategy name or 'all'                       [default: all]
 *                  ema-crossover | rsi-reversion | vwap-momentum | breakout-volume | all
 *   --from       Start date YYYY-MM-DD                        [default: 6 months ago]
 *   --to         End date   YYYY-MM-DD                        [default: today]
 *   --capital    Initial capital in ₹                         [default: 100000]
 *   --interval   Candle interval                              [default: 5minute]
 *                  minute | 5minute | 15minute | day
 *   --consensus  Require min-N strategies to agree (multi)    [default: 2]
 *   --csv        Path to local CSV file (skip API fetch)
 *   --no-cache   Disable local data cache
 *   --output     Directory for CSV output                     [default: ./backtest-output]
 *   --compare    Run all strategies and print comparison table
 *   --help       Show this help message
 *
 * Examples:
 *   # Backtest EMA crossover on RELIANCE for last 3 months
 *   node scripts/backtest.js --symbol RELIANCE --strategy ema-crossover --from 2024-10-01
 *
 *   # Compare all strategies on INFY
 *   node scripts/backtest.js --symbol INFY --compare
 *
 *   # Run with custom capital and export CSV
 *   node scripts/backtest.js --symbol TCS --capital 500000 --from 2024-01-01 --to 2024-06-30
 *
 *   # Use local CSV file (custom data source)
 *   node scripts/backtest.js --symbol HDFC --csv ./data/hdfc_5min.csv
 */

import { parseArgs } from 'util';
import { join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { existsSync } from 'fs';

import { fetchHistoricalData } from '../src/backtesting/historical-data-fetcher.js';
import { BacktestEngine, ALL_STRATEGIES } from '../src/backtesting/backtest-engine.js';
import { calculateMetrics } from '../src/backtesting/metrics-calculator.js';
import { printReport, printComparison, exportCsv, exportDailyPnlCsv } from '../src/backtesting/report-generator.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── CLI argument parsing ───────────────────────────────────────────────────

const { values: args } = parseArgs({
  options: {
    symbol: { type: 'string' },
    strategy: { type: 'string', default: 'all' },
    from: { type: 'string' },
    to: { type: 'string' },
    capital: { type: 'string', default: '100000' },
    interval: { type: 'string', default: '5minute' },
    consensus: { type: 'string', default: '2' },
    csv: { type: 'string' },
    'no-cache': { type: 'boolean', default: false },
    output: { type: 'string', default: join(__dirname, '../backtest-output') },
    compare: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
  strict: false,
});

// ── Help ───────────────────────────────────────────────────────────────────

if (args.help) {
  const helpText = `
╔══════════════════════════════════════════════════════════════╗
║              Alpha8 — Backtesting CLI                        ║
╚══════════════════════════════════════════════════════════════╝

USAGE
  node scripts/backtest.js [options]

OPTIONS
  --symbol     NSE trading symbol (required)      e.g. RELIANCE
  --strategy   Strategy to test                   [default: all]
               ema-crossover | rsi-reversion | vwap-momentum
               breakout-volume | all
  --from       Start date YYYY-MM-DD              [default: 6mo ago]
  --to         End date   YYYY-MM-DD              [default: today]
  --capital    Initial capital ₹                  [default: 100000]
  --interval   Candle size                        [default: 5minute]
               minute | 5minute | 15minute | day
  --consensus  Min strategies to agree (multi)    [default: 2]
  --csv        Path to local CSV data file
  --no-cache   Disable data cache
  --output     CSV output directory               [default: ./backtest-output]
  --compare    Run all strategies + comparison table
  --help       Show this message

EXAMPLES
  node scripts/backtest.js --symbol RELIANCE --strategy ema-crossover
  node scripts/backtest.js --symbol INFY --compare --from 2024-01-01
  node scripts/backtest.js --symbol TCS --capital 500000 --from 2024-01-01 --to 2024-06-30
  node scripts/backtest.js --symbol HDFC --csv ./data/hdfc_5min.csv

NOTES
  • Data is fetched from Yahoo Finance by default (free, no credentials needed)
  • If Kite credentials are configured, Kite Connect is used instead (higher quality)
  • Data is cached locally to avoid repeated API calls (backtest-cache/)
  • Yahoo Finance intraday data is limited to last 60 days; use --interval day for longer periods
`.trim();
  console.log(helpText);
  process.exit(0);
}

// ── Validation ─────────────────────────────────────────────────────────────

if (!args.symbol) {
  console.error('\n❌ Error: --symbol is required\n');
  console.error('  Example: node scripts/backtest.js --symbol RELIANCE\n');
  process.exit(1);
}

const symbol = args.symbol.toUpperCase().trim();
const capital = Number(args.capital);
const noCache = args['no-cache'] ?? false;
const outputDir = resolve(args.output);
const minCons = parseInt(args.consensus, 10);

if (isNaN(capital) || capital <= 0) {
  console.error(`\n❌ Error: --capital must be a positive number, got: ${args.capital}\n`);
  process.exit(1);
}

// Resolve strategy list
let strategyList;
if (args.compare) {
  strategyList = ALL_STRATEGIES; // Compare runs all strategies
} else if (args.strategy === 'all') {
  strategyList = ALL_STRATEGIES;
} else {
  strategyList = [args.strategy];
  if (!ALL_STRATEGIES.includes(args.strategy)) {
    console.error(`\n❌ Error: Unknown strategy "${args.strategy}"`);
    console.error(`  Valid: ${ALL_STRATEGIES.join(', ')}, all\n`);
    process.exit(1);
  }
}

// Date range
const toDate = args.to ? new Date(args.to) : new Date();
const fromDate = args.from ? new Date(args.from) : (() => {
  const d = new Date();
  d.setMonth(d.getMonth() - 6);
  return d;
})();

if (isNaN(fromDate.getTime()) || isNaN(toDate.getTime())) {
  console.error('\n❌ Error: --from and --to must be valid dates (YYYY-MM-DD)\n');
  process.exit(1);
}

if (fromDate >= toDate) {
  console.error('\n❌ Error: --from must be before --to\n');
  process.exit(1);
}

// CSV path validation
if (args.csv && !existsSync(resolve(args.csv))) {
  console.error(`\n❌ Error: CSV file not found: ${args.csv}\n`);
  process.exit(1);
}

// ── Main ───────────────────────────────────────────────────────────────────

async function main() {
  console.log('\n');
  console.log('  ╔══════════════════════════════════════════╗');
  console.log('  ║         Alpha8 — Backtesting             ║');
  console.log('  ╚══════════════════════════════════════════╝');
  console.log('');
  console.log(`  Symbol     : ${symbol}`);
  console.log(`  Period     : ${fromDate.toISOString().slice(0, 10)} → ${toDate.toISOString().slice(0, 10)}`);
  console.log(`  Capital    : ₹${capital.toLocaleString('en-IN')}`);
  console.log(`  Strategies : ${strategyList.join(', ')}`);
  console.log(`  Interval   : ${args.interval}`);
  console.log('');

  // ── Fetch historical data ────────────────────────────────────────────────
  let kite = null;
  try {
    // Try to load Kite client if credentials are configured
    const { default: KiteClient } = await import('../src/api/kite-client.js');
    kite = new KiteClient();
    console.log('  📡 Kite Connect credentials found — using Kite historical data');
  } catch {
    console.log('  📡 No Kite credentials — using Yahoo Finance (free)');
  }

  let candles;
  let dataSource = 'yahoo';

  try {
    candles = await fetchHistoricalData({
      symbol,
      from: fromDate,
      to: toDate,
      interval: args.interval,
      kite,
      csvPath: args.csv ? resolve(args.csv) : null,
      noCache,
      logger: (msg) => console.log(`  ${msg}`),
    });

    if (kite) dataSource = 'kite';
    if (args.csv) dataSource = 'csv';
  } catch (err) {
    console.error(`\n❌ Failed to fetch data: ${err.message}\n`);
    console.error('  Tips:');
    console.error('  • Yahoo Finance intraday data is limited to last 60 days');
    console.error('  • For longer periods, use --interval day');
    console.error('  • Or provide a CSV file with --csv <path>');
    console.error('');
    process.exit(1);
  }

  if (candles.length === 0) {
    console.error(`\n❌ No candles found for ${symbol} in the requested date range\n`);
    process.exit(1);
  }

  console.log(`  ✅ Loaded ${candles.length} candles\n`);

  // ── Run backtests ────────────────────────────────────────────────────────
  const results = [];

  for (const strategyName of strategyList) {
    console.log(`  ▶ Running: ${strategyName}...`);

    try {
      const engine = new BacktestEngine({
        symbol,
        strategies: [strategyName],
        initialCapital: capital,
        useConsensus: false, // Single-strategy mode
        logger: () => { }, // Silent during run
      });

      const { trades } = await engine.run([...candles]); // clone to avoid mutation
      const metrics = calculateMetrics(trades, capital);

      results.push({ name: strategyName, trades, metrics });

      console.log(`     → ${trades.length} trades | Return: ${metrics.totalReturnPct >= 0 ? '+' : ''}${metrics.totalReturnPct}% | Sharpe: ${metrics.sharpeRatio}`);
    } catch (err) {
      console.error(`  ❌ ${strategyName} failed: ${err.message}`);
    }
  }

  if (results.length === 0) {
    console.error('\n❌ All strategies failed. Check strategy file imports.\n');
    process.exit(1);
  }

  console.log('');

  // ── Output ───────────────────────────────────────────────────────────────

  if (args.compare && results.length > 1) {
    // Comparison mode — print the table first
    printComparison(results);
  }

  // Print individual reports
  for (const result of results) {
    printReport({
      symbol,
      strategies: [result.name],
      fromDate: fromDate.toISOString().slice(0, 10),
      toDate: toDate.toISOString().slice(0, 10),
      metrics: result.metrics,
      trades: result.trades,
      dataSource,
    });

    // Export CSV trade log
    if (result.trades.length > 0) {
      const csvName = `${symbol}_${result.name}_${fromDate.toISOString().slice(0, 10)}_${toDate.toISOString().slice(0, 10)}`;
      const tradeCsv = exportCsv(result.trades, outputDir, csvName);
      const dailyCsv = exportDailyPnlCsv(result.metrics.dailyPnl, outputDir, csvName);

      console.log(`  📄 Trade log  → ${tradeCsv}`);
      console.log(`  📄 Daily P&L  → ${dailyCsv}`);
      console.log('');
    }
  }

  // ── Multi-strategy consensus run (if running 'all' or multiple) ──────────
  if (strategyList.length > 1 && !args.compare) {
    console.log('  ▶ Running consensus mode (all strategies must agree ≥2)...');

    try {
      const engine = new BacktestEngine({
        symbol,
        strategies: strategyList,
        initialCapital: capital,
        useConsensus: true,
        minConsensus: minCons,
        logger: () => { },
      });

      const { trades } = await engine.run([...candles]);
      const metrics = calculateMetrics(trades, capital);

      printReport({
        symbol,
        strategies: ['CONSENSUS (' + strategyList.join('+') + ')'],
        fromDate: fromDate.toISOString().slice(0, 10),
        toDate: toDate.toISOString().slice(0, 10),
        metrics,
        trades,
        dataSource,
      });

      if (trades.length > 0) {
        const csvName = `${symbol}_consensus_${fromDate.toISOString().slice(0, 10)}_${toDate.toISOString().slice(0, 10)}`;
        const tradeCsv = exportCsv(trades, outputDir, csvName);
        console.log(`  📄 Consensus trade log → ${tradeCsv}`);
        console.log('');
      }
    } catch (err) {
      console.error(`  ❌ Consensus run failed: ${err.message}`);
    }
  }

  console.log('  ✅ Backtest complete.\n');
}

main().catch(err => {
  console.error(`\n❌ Fatal error: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
