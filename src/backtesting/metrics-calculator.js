/**
 * @fileoverview Backtesting performance metrics calculator.
 *
 * Computes standard quantitative trading metrics from a completed trade log:
 *   - Total return %
 *   - Win rate
 *   - Average win / average loss
 *   - Profit factor
 *   - Max drawdown %
 *   - Sharpe ratio (annualised, risk-free = 6% for India)
 *   - Sortino ratio
 *   - Calmar ratio
 *   - Total trades, winning trades, losing trades
 *   - Best trade, worst trade
 *   - Average trade duration (minutes)
 *   - Daily P&L series (for equity curve)
 */

/**
 * @typedef {object} Trade
 * @property {string}  symbol
 * @property {string}  strategy
 * @property {'BUY'}   side         - always BUY for entry (sells are exits)
 * @property {number}  entryPrice
 * @property {number}  exitPrice
 * @property {number}  quantity
 * @property {number}  pnl           - realised P&L in ₹
 * @property {number}  pnlPct        - P&L as % of entry value
 * @property {string}  exitReason    - 'SIGNAL'|'STOP_LOSS'|'SQUARE_OFF'
 * @property {Date}    entryTime
 * @property {Date}    exitTime
 */

/**
 * @typedef {object} BacktestMetrics
 * @property {number}   initialCapital
 * @property {number}   finalCapital
 * @property {number}   totalReturnPct
 * @property {number}   totalTrades
 * @property {number}   winningTrades
 * @property {number}   losingTrades
 * @property {number}   winRate              - 0-100 %
 * @property {number}   avgWinPct
 * @property {number}   avgLossPct
 * @property {number}   profitFactor
 * @property {number}   maxDrawdownPct
 * @property {number}   sharpeRatio
 * @property {number}   sortinoRatio
 * @property {number}   calmarRatio
 * @property {number}   bestTradePct
 * @property {number}   worstTradePct
 * @property {number}   avgTradeDurationMin
 * @property {number}   totalPnl
 * @property {Array}    dailyPnl             - [{ date, pnl, capital }]
 * @property {Array}    equityCurve          - capital after each trade
 */

/** Annual risk-free rate assumed for India (6% = 0.06) */
const RISK_FREE_RATE_ANNUAL = 0.06;

/** Trading days per year on NSE */
const TRADING_DAYS_PER_YEAR = 252;

/**
 * Round a number to N decimal places.
 */
const round = (n, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;

/**
 * Calculate all backtesting performance metrics.
 *
 * @param {Trade[]}  trades          - completed trade log from BacktestEngine
 * @param {number}   initialCapital  - starting capital in ₹
 * @returns {BacktestMetrics}
 */
export function calculateMetrics(trades, initialCapital) {
  if (!trades || trades.length === 0) {
    return emptyMetrics(initialCapital);
  }

  // ── 1. Basic counts ────────────────────────────────────────────────────────
  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl <= 0);

  const totalPnl = trades.reduce((s, t) => s + t.pnl, 0);
  const finalCapital = initialCapital + totalPnl;

  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));

  // ── 2. Win/loss statistics ─────────────────────────────────────────────────
  const winRate = (wins.length / trades.length) * 100;
  const avgWinPct = wins.length > 0
    ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length
    : 0;
  const avgLossPct = losses.length > 0
    ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length
    : 0;
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : Infinity;

  const bestTrade = trades.reduce((m, t) => t.pnlPct > m.pnlPct ? t : m, trades[0]);
  const worstTrade = trades.reduce((m, t) => t.pnlPct < m.pnlPct ? t : m, trades[0]);

  // ── 3. Trade duration ──────────────────────────────────────────────────────
  const durations = trades.map(t =>
    (t.exitTime.getTime() - t.entryTime.getTime()) / (1000 * 60)
  );
  const avgTradeDurationMin = durations.reduce((s, d) => s + d, 0) / durations.length;

  // ── 4. Equity curve & daily P&L ───────────────────────────────────────────
  const equityCurve = [initialCapital];
  let capital = initialCapital;
  for (const t of trades) {
    capital += t.pnl;
    equityCurve.push(round(capital));
  }

  const dailyPnlMap = new Map();
  for (const t of trades) {
    const day = t.exitTime.toISOString().slice(0, 10);
    dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + t.pnl);
  }
  const dailyPnlArray = [...dailyPnlMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, pnl]) => ({ date, pnl: round(pnl) }));

  // ── 5. Max drawdown ────────────────────────────────────────────────────────
  const maxDrawdownPct = calculateMaxDrawdown(equityCurve);

  // ── 6. Sharpe ratio (annualised) ───────────────────────────────────────────
  // Using daily returns from the daily P&L series
  const dailyReturnsPct = buildDailyReturnSeries(trades, initialCapital);
  const sharpeRatio = calculateSharpe(dailyReturnsPct);
  const sortinoRatio = calculateSortino(dailyReturnsPct);

  // ── 7. Calmar ratio ────────────────────────────────────────────────────────
  const totalReturnPct = ((finalCapital - initialCapital) / initialCapital) * 100;
  const calmarRatio = maxDrawdownPct > 0
    ? round(totalReturnPct / maxDrawdownPct, 2)
    : Infinity;

  // ── Long / Short breakdown ──────────────────────────────────────────────
  const longTrades = trades.filter(t => !t.isShort);
  const shortTrades = trades.filter(t => t.isShort);

  const directionBreakdown = {
    long: {
      count: longTrades.length,
      wins: longTrades.filter(t => t.pnl > 0).length,
      pnl: round(longTrades.reduce((s, t) => s + t.pnl, 0)),
      winRate: longTrades.length
        ? round((longTrades.filter(t => t.pnl > 0).length / longTrades.length) * 100, 1)
        : 0,
    },
    short: {
      count: shortTrades.length,
      wins: shortTrades.filter(t => t.pnl > 0).length,
      pnl: round(shortTrades.reduce((s, t) => s + t.pnl, 0)),
      winRate: shortTrades.length
        ? round((shortTrades.filter(t => t.pnl > 0).length / shortTrades.length) * 100, 1)
        : 0,
    },
  };

  return {
    initialCapital: round(initialCapital),
    finalCapital: round(finalCapital),
    totalPnl: round(totalPnl),
    totalReturnPct: round(totalReturnPct, 2),
    totalTrades: trades.length,
    winningTrades: wins.length,
    losingTrades: losses.length,
    winRate: round(winRate, 1),
    avgWinPct: round(avgWinPct, 2),
    avgLossPct: round(avgLossPct, 2),
    profitFactor: profitFactor === Infinity ? Infinity : round(profitFactor, 2),
    maxDrawdownPct: round(maxDrawdownPct, 2),
    sharpeRatio: round(sharpeRatio, 2),
    sortinoRatio: round(sortinoRatio, 2),
    calmarRatio,
    bestTradePct: round(bestTrade.pnlPct, 2),
    worstTradePct: round(worstTrade.pnlPct, 2),
    avgTradeDurationMin: round(avgTradeDurationMin, 0),
    equityCurve,
    dailyPnl: dailyPnlArray,
    directionBreakdown,
  };
}

/**
 * Calculate maximum drawdown % from an equity curve array.
 * @param {number[]} equityCurve
 * @returns {number}
 */
export function calculateMaxDrawdown(equityCurve) {
  let peak = equityCurve[0];
  let maxDD = 0;

  for (const value of equityCurve) {
    if (value > peak) peak = value;
    const dd = ((peak - value) / peak) * 100;
    if (dd > maxDD) maxDD = dd;
  }

  return maxDD;
}

/**
 * Build daily return % series from a trade log (for Sharpe/Sortino).
 * Groups by exit date, calculates daily capital change vs previous day.
 *
 * @param {Trade[]} trades
 * @param {number}  initialCapital
 * @returns {number[]}  daily return percentages
 */
function buildDailyReturnSeries(trades, initialCapital) {
  // Aggregate P&L by exit date
  const dailyPnlMap = new Map();
  for (const t of trades) {
    const day = t.exitTime.toISOString().slice(0, 10);
    dailyPnlMap.set(day, (dailyPnlMap.get(day) ?? 0) + t.pnl);
  }

  const sorted = [...dailyPnlMap.entries()].sort(([a], [b]) => a.localeCompare(b));

  const returns = [];
  let capital = initialCapital;

  for (const [, pnl] of sorted) {
    returns.push((pnl / capital) * 100);
    capital += pnl;
  }

  return returns;
}

/**
 * Annualised Sharpe ratio.
 * Uses NSE risk-free rate (6% annual → ~0.0238% per trading day).
 *
 * @param {number[]} dailyReturnsPct  - array of daily return %
 * @returns {number}
 */
export function calculateSharpe(dailyReturnsPct) {
  if (dailyReturnsPct.length < 2) return 0;

  const rfDaily = (RISK_FREE_RATE_ANNUAL / TRADING_DAYS_PER_YEAR) * 100;
  const excess = dailyReturnsPct.map(r => r - rfDaily);

  const mean = excess.reduce((s, r) => s + r, 0) / excess.length;
  const std = stdDev(excess);

  if (std === 0) return 0;

  return (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Annualised Sortino ratio (penalises only downside volatility).
 *
 * @param {number[]} dailyReturnsPct
 * @returns {number}
 */
export function calculateSortino(dailyReturnsPct) {
  if (dailyReturnsPct.length < 2) return 0;

  const rfDaily = (RISK_FREE_RATE_ANNUAL / TRADING_DAYS_PER_YEAR) * 100;
  const excess = dailyReturnsPct.map(r => r - rfDaily);
  const mean = excess.reduce((s, r) => s + r, 0) / excess.length;
  const downsideRets = excess.filter(r => r < 0);

  if (downsideRets.length === 0) return Infinity;

  const downsideStd = stdDev(downsideRets);
  if (downsideStd === 0) return 0;

  return (mean / downsideStd) * Math.sqrt(TRADING_DAYS_PER_YEAR);
}

/**
 * Population standard deviation.
 */
function stdDev(arr) {
  if (arr.length === 0) return 0;
  const mean = arr.reduce((s, v) => s + v, 0) / arr.length;
  const variance = arr.reduce((s, v) => s + (v - mean) ** 2, 0) / arr.length;
  return Math.sqrt(variance);
}

/**
 * Empty metrics object when there are no trades.
 */
function emptyMetrics(initialCapital) {
  return {
    initialCapital,
    finalCapital: initialCapital,
    totalPnl: 0,
    totalReturnPct: 0,
    totalTrades: 0,
    winningTrades: 0,
    losingTrades: 0,
    winRate: 0,
    avgWinPct: 0,
    avgLossPct: 0,
    profitFactor: 0,
    maxDrawdownPct: 0,
    sharpeRatio: 0,
    sortinoRatio: 0,
    calmarRatio: 0,
    bestTradePct: 0,
    worstTradePct: 0,
    avgTradeDurationMin: 0,
    equityCurve: [initialCapital],
    dailyPnl: [],
  };
}

/**
 * Compare metrics across multiple strategy runs.
 * Returns a ranked summary table sorted by Sharpe ratio.
 *
 * @param {Array<{ name: string, metrics: BacktestMetrics }>} results
 * @returns {Array}
 */
export function compareStrategies(results) {
  return results
    .map(r => ({
      strategy: r.name,
      returnPct: r.metrics.totalReturnPct,
      winRate: r.metrics.winRate,
      sharpe: r.metrics.sharpeRatio,
      maxDrawdown: r.metrics.maxDrawdownPct,
      profitFactor: r.metrics.profitFactor,
      totalTrades: r.metrics.totalTrades,
    }))
    .sort((a, b) => b.sharpe - a.sharpe);
}
