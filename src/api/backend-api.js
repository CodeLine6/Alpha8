import { createLogger } from '../lib/logger.js';
import { query, checkDatabaseHealth } from '../lib/db.js';
import { checkRedisHealth, cacheGet, cacheSet } from '../lib/redis.js';
import { fetchHistoricalData } from '../data/historical-data.js';
import { getScreenerResults } from '../intelligence/screener-engine.js';

const log = createLogger('backend-api');

/**
 * Create the API request handler for the backend HTTP server.
 *
 * ENDPOINTS:
 *   GET  /health | /api/health               — infrastructure health + broker token validity
 *   GET  /api/summary                        — daily P&L, trade counts, kill switch state
 *   GET  /api/positions                      — open positions with unrealised P&L
 *   GET  /api/trades                         — trade history with filters
 *   GET  /api/strategies/performance         — per-strategy metrics
 *   GET  /api/strategies/signals             — recent signal log
 *   GET  /api/settings                       — app configuration
 *   GET  /api/holdings                       — broker holdings + positions
 *   GET  /api/live-settings                  — all active Redis param overrides
 *   GET  /api/live-settings/schema           — full schema for all settable params
 *   POST /api/positions/exit              — manually force-exit a specific open position
 *   POST /api/killswitch                     — engage / reset kill switch
 *   POST /api/settings/mode                  — toggle paper/live mode
 *   POST /api/settings/watchlist             — add/remove watchlist symbols
 *   POST /api/live-settings                  — set / reset / resetAll param override
 *
 * @param {Object} deps
 * @param {import('../risk/kill-switch.js').KillSwitch}             deps.killSwitch
 * @param {import('../risk/risk-manager.js').RiskManager}           deps.riskManager
 * @param {import('../engine/execution-engine.js').ExecutionEngine} deps.engine
 * @param {Object}   deps.config
 * @param {Object}   [deps.broker]
 * @param {Object}   [deps.telegram]
 * @param {Object}   [deps.scout]
 * @param {Object}   [deps.holdingsManager]
 * @param {Function} [deps.getLiveSetting]
 * @param {Function} [deps.setLiveSetting]
 * @param {Function} [deps.getAllLiveSettings]
 * @param {Function} [deps.resetLiveSetting]
 * @returns {Function} HTTP request handler
 */
export function createApiHandler(deps) {
  const {
    killSwitch, riskManager, engine, config, broker, telegram, holdingsManager, tickFeed, instrumentManager,
    getLiveSetting, setLiveSetting, getAllLiveSettings, resetLiveSetting,
  } = deps;

  const API_KEY = process.env.API_SECRET_KEY || '';

  // ═══════════════════════════════════════════════════════
  // LIVE SETTINGS SCHEMA
  // Single source of truth for all overridable parameters.
  // Used by GET /api/live-settings/schema and POST validation.
  // ═══════════════════════════════════════════════════════

  const LIVE_SETTINGS_SCHEMA = {
    // ── Risk Management ──────────────────────────────────────────────────────
    MAX_DAILY_LOSS_PCT: {
      label: 'Max Daily Loss %',
      description: 'Maximum % of capital that can be lost before trading halts',
      type: 'number', min: 0.1, max: 10, step: 0.1,
      default: config.MAX_DAILY_LOSS_PCT,
      category: 'risk',
    },
    PER_TRADE_STOP_LOSS_PCT: {
      label: 'Per-Trade Stop Loss %',
      description: 'Max % of capital at risk on a single trade',
      type: 'number', min: 0.1, max: 5, step: 0.1,
      default: config.PER_TRADE_STOP_LOSS_PCT,
      category: 'risk',
    },
    MAX_POSITION_COUNT: {
      label: 'Max Open Positions',
      description: 'Maximum number of concurrent open positions',
      type: 'number', min: 1, max: 20, step: 1,
      default: config.MAX_POSITION_COUNT,
      category: 'risk',
    },
    KILL_SWITCH_DRAWDOWN_PCT: {
      label: 'Kill Switch Drawdown %',
      description: 'Drawdown % that auto-engages the kill switch',
      type: 'number', min: 1, max: 20, step: 0.5,
      default: config.KILL_SWITCH_DRAWDOWN_PCT,
      category: 'risk',
    },
    TRADING_CAPITAL: {
      label: 'Trading Capital (₹)',
      description: 'Total capital used for position sizing (overrides .env)',
      type: 'number', min: 1000, max: 10000000, step: 100,
      default: config.TRADING_CAPITAL,
      category: 'risk',
    },
    MAX_CAPITAL_EXPOSURE_PCT: {
      label: 'Max Total Exposure %',
      description: 'Max % of capital allowed in all positions combined',
      type: 'number', min: 1, max: 200, step: 5,
      default: config.MAX_CAPITAL_EXPOSURE_PCT ?? 100,
      category: 'risk',
    },
    MAX_POSITION_VALUE_PCT: {
      label: 'Max Per-Position %',
      description: 'Max % of capital allowed per single stock',
      type: 'number', min: 1, max: 100, step: 5,
      default: config.MAX_POSITION_VALUE_PCT ?? 100,
      category: 'risk',
    },
    STOP_LOSS_PCT: {
      label: 'Stop Loss %',
      description: 'Hard stop loss % below entry price — triggers immediate exit',
      type: 'number', min: 0.1, max: 5, step: 0.1,
      default: config.STOP_LOSS_PCT ?? 1.0,
      category: 'risk',
    },
    TRAILING_STOP_PCT: {
      label: 'Trailing Stop %',
      description: 'Trailing stop % below session high water mark — locks in profit',
      type: 'number', min: 0.1, max: 5, step: 0.1,
      default: config.TRAILING_STOP_PCT ?? 1.5,
      category: 'risk',
    },
    PROFIT_TARGET_PCT: {
      label: 'Profit Target %',
      description: 'Fixed % profit target for mean reversion strategies (RSI). Momentum strategies use Risk/Reward ratio instead.',
      type: 'number', min: 0.5, max: 10, step: 0.1,
      default: config.PROFIT_TARGET_PCT ?? 1.8,
      category: 'exits',
    },
    RISK_REWARD_RATIO: {
      label: 'Risk/Reward Ratio',
      description: 'Profit target = stop loss distance × this ratio. Used by EMA, VWAP, Breakout strategies.',
      type: 'number', min: 1, max: 5, step: 0.5,
      default: config.RISK_REWARD_RATIO ?? 2.0,
      category: 'exits',
    },
    PARTIAL_EXIT_ENABLED: {
      label: 'Partial Exit',
      description: 'Sell partial position at profit target, let remainder trail',
      type: 'boolean',
      default: config.PARTIAL_EXIT_ENABLED ?? true,
      category: 'exits',
    },
    PARTIAL_EXIT_PCT: {
      label: 'Partial Exit %',
      description: '% of position to sell at profit target (remainder continues trailing)',
      type: 'number', min: 10, max: 90, step: 10,
      default: config.PARTIAL_EXIT_PCT ?? 50,
      category: 'exits',
    },
    PNL_TRAIL_PCT: {
      label: 'PnL Trail Fallback %',
      description: 'How much of peak profit (%) to give back before exiting',
      type: 'number', min: 10, max: 50, step: 1,
      default: config.PNL_TRAIL_PCT ?? 25,
      category: 'exits',
    },
    PNL_TRAIL_FLOOR: {
      label: 'PnL Trail Floor (₹)',
      description: 'Minimum ₹ profit before trail activates (0 = auto 0.5% value)',
      type: 'number', min: 0, max: 10000, step: 50,
      default: config.PNL_TRAIL_FLOOR ?? 0,
      category: 'exits',
    },
    TRAIL_MODE: {
      label: 'Trail Logic Mode',
      description: 'Which trailing stop logic to use',
      type: 'select', options: ['PNL_TRAIL', 'PRICE_TRAIL', 'HYBRID'],
      default: config.TRAIL_MODE ?? 'PNL_TRAIL',
      category: 'exits',
    },
    SIGNAL_REVERSAL_ENABLED: {
      label: 'Signal Reversal Exit',
      description: 'Exit when the strategy that opened the position fires the opposite signal',
      type: 'boolean',
      default: config.SIGNAL_REVERSAL_ENABLED ?? true,
      category: 'exits',
    },
    MAX_HOLD_MINUTES: {
      label: 'Max Hold Time (min)',
      description: 'Exit flat/losing positions after this many minutes regardless of signals',
      type: 'number', min: 15, max: 240, step: 15,
      default: config.MAX_HOLD_MINUTES ?? 90,
      category: 'exits',
    },
    // ── EMA Crossover ────────────────────────────────────────────────────────
    EMA_FAST_PERIOD: {
      label: 'EMA Fast Period',
      description: 'Fast EMA period for crossover detection',
      type: 'number', min: 3, max: 20, step: 1,
      default: 9, category: 'ema',
    },
    EMA_SLOW_PERIOD: {
      label: 'EMA Slow Period',
      description: 'Slow EMA period for crossover detection',
      type: 'number', min: 10, max: 50, step: 1,
      default: 21, category: 'ema',
    },
    // ── RSI Mean Reversion ───────────────────────────────────────────────────
    RSI_PERIOD: {
      label: 'RSI Period',
      description: 'RSI calculation period',
      type: 'number', min: 5, max: 30, step: 1,
      default: 14, category: 'rsi',
    },
    RSI_OVERSOLD: {
      label: 'RSI Oversold Threshold',
      description: 'RSI below this triggers a BUY signal',
      type: 'number', min: 10, max: 40, step: 1,
      default: 30, category: 'rsi',
    },
    RSI_OVERBOUGHT: {
      label: 'RSI Overbought Threshold',
      description: 'RSI above this triggers a SELL signal',
      type: 'number', min: 60, max: 90, step: 1,
      default: 70, category: 'rsi',
    },
    RSI_EXTREME_OVERSOLD: {
      label: 'RSI Extreme Oversold',
      description: 'Extreme oversold level for confidence bonus',
      type: 'number', min: 5, max: 25, step: 1,
      default: 20, category: 'rsi',
    },
    RSI_EXTREME_OVERBOUGHT: {
      label: 'RSI Extreme Overbought',
      description: 'Extreme overbought level for confidence bonus',
      type: 'number', min: 75, max: 95, step: 1,
      default: 80, category: 'rsi',
    },
    // ── VWAP Momentum ────────────────────────────────────────────────────────
    VWAP_VOLUME_MULTIPLIER: {
      label: 'VWAP Volume Multiplier',
      description: 'Volume must be this × average to confirm signal',
      type: 'number', min: 0.5, max: 5, step: 0.1,
      default: 1.2, category: 'vwap',
    },
    VWAP_PRICE_BAND_PCT: {
      label: 'VWAP Price Band %',
      description: '% band around VWAP to filter noise crossovers',
      type: 'number', min: 0.05, max: 2, step: 0.05,
      default: 0.2, category: 'vwap',
    },
    VWAP_VOLUME_AVG_PERIOD: {
      label: 'VWAP Volume Avg Period',
      description: 'Candle period for average volume calculation',
      type: 'number', min: 5, max: 50, step: 1,
      default: 20, category: 'vwap',
    },
    // ── Breakout Volume ──────────────────────────────────────────────────────
    BREAKOUT_LOOKBACK: {
      label: 'Breakout Lookback Period',
      description: 'Candles to look back for resistance/support levels',
      type: 'number', min: 5, max: 50, step: 1,
      default: 20, category: 'breakout',
    },
    BREAKOUT_VOLUME_MULTIPLIER: {
      label: 'Breakout Volume Multiplier',
      description: 'Volume must be this × average to confirm breakout',
      type: 'number', min: 0.5, max: 5, step: 0.1,
      default: 1.5, category: 'breakout',
    },
    BREAKOUT_BB_PERIOD: {
      label: 'Bollinger Band Period',
      description: 'Period for Bollinger Band calculation',
      type: 'number', min: 5, max: 50, step: 1,
      default: 20, category: 'breakout',
    },
    BREAKOUT_BB_STDDEV: {
      label: 'Bollinger Band Std Dev',
      description: 'Standard deviations for Bollinger Band width',
      type: 'number', min: 1, max: 4, step: 0.5,
      default: 2, category: 'breakout',
    },
    // ── Signal Consensus ─────────────────────────────────────────────────────
    MIN_CONFIDENCE: {
      label: 'Minimum Confidence %',
      description: 'Minimum confidence score required for a signal to vote',
      type: 'number', min: 20, max: 90, step: 1,
      default: 40, category: 'consensus',
    },
    MIN_AGREEMENT: {
      label: 'Minimum Agreement count',
      description: 'Minimum number of strategies that must agree for a valid consensus',
      type: 'number', min: 1, max: 5, step: 1,
      default: 2, category: 'consensus',
    },
    SUPER_CONVICTION_THRESHOLD: {
      label: 'Super Conviction Threshold',
      description: 'Confidence % required for a single strategy to bypass cross-group consensus',
      type: 'number', min: 60, max: 95, step: 1,
      default: 80, category: 'consensus',
    },
    // ── ORB Strategy ─────────────────────────────────────────────────────────
    ORB_MIN_RANGE_PCT: {
      label: 'ORB Min Range %',
      description: 'Minimum percentage width of the opening range',
      type: 'number', min: 0.1, max: 2, step: 0.1,
      default: 0.3, category: 'orb',
    },
    ORB_MAX_RANGE_PCT: {
      label: 'ORB Max Range %',
      description: 'Maximum percentage width of the opening range (prevents huge whipsaws)',
      type: 'number', min: 1, max: 5, step: 0.1,
      default: 3.0, category: 'orb',
    },
    ORB_VOLUME_MULTIPLIER: {
      label: 'ORB Volume Multiplier',
      description: 'Volume must be this × average to confirm ORB breakout',
      type: 'number', min: 0.5, max: 5, step: 0.1,
      default: 1.5, category: 'orb',
    },
    // ── BAVI Strategy ────────────────────────────────────────────────────────
    BAVI_IMBALANCE_THRESHOLD: {
      label: 'BAVI Imbalance Minimum',
      description: 'Minimum bid-ask volume imbalance percentage to trigger',
      type: 'number', min: 0.1, max: 0.9, step: 0.05,
      default: 0.35, category: 'bavi',
    },
    BAVI_STRONG_IMBALANCE: {
      label: 'BAVI Strong Imbalance',
      description: 'Threshold defining a massive, high-confidence imbalance',
      type: 'number', min: 0.4, max: 0.9, step: 0.05,
      default: 0.50, category: 'bavi',
    },
    BAVI_MIN_TICK_COUNT: {
      label: 'BAVI Min Tick Count',
      description: 'Minimum ticks required in the buffer to allow a valid calculation',
      type: 'number', min: 10, max: 500, step: 10,
      default: 50, category: 'bavi',
    },
  };

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════

  function checkAuth(req, res) {
    if (!API_KEY) return true;
    const provided = req.headers['x-api-key'] || '';
    if (provided !== API_KEY) {
      json(res, { error: 'Unauthorized' }, 401);
      return false;
    }
    return true;
  }

  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        try { resolve(data ? JSON.parse(data) : {}); }
        catch (e) { reject(new Error('Invalid JSON body')); }
      });
      req.on('error', reject);
    });
  }

  function json(res, data, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
    });
    res.end(JSON.stringify(data));
  }

  function parseQuery(url) {
    const idx = url.indexOf('?');
    if (idx === -1) return {};
    return Object.fromEntries(new URLSearchParams(url.slice(idx)));
  }

  // ═══════════════════════════════════════════════════════
  // ROUTE HANDLERS
  // ═══════════════════════════════════════════════════════

  async function handleSummary(req, res) {
    try {
      const riskStatus = riskManager.getStatus();
      const ksStatus = killSwitch.getStatus();
      const roiData = riskManager.getDailyRoi();

      // Fix Bug 1: Removed dead first try/catch that assigned to undeclared `dbSummary`
      // (would throw ReferenceError in strict-mode ESM on every call).
      // Fix Bug 2: Use IST date and timezone-aware SQL comparison so trades recorded
      // at 09:30 IST (UTC day boundary) are correctly included.
      let tradeStats = { count: 0, wins: 0, losses: 0, filled: 0, rejected: 0, totalPnl: 0 };
      try {
        // Fix Bug 2: IST date instead of UTC
        const today = new Date().toLocaleString('en-CA', { timeZone: 'Asia/Kolkata' }).split(',')[0];
        const result = await query(`
          SELECT
            COUNT(*) as count,
            COUNT(*) FILTER (WHERE pnl > 0)             as wins,
            COUNT(*) FILTER (WHERE pnl < 0)             as losses,
            COUNT(*) FILTER (WHERE status = 'FILLED')   as filled,
            COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected,
            COALESCE(SUM(pnl), 0)                       as total_pnl
          FROM trades
          WHERE (created_at AT TIME ZONE 'Asia/Kolkata')::date = ($1::date)
        `, [today]);
        const row = result.rows[0];
        tradeStats = {
          count: parseInt(row.count),
          wins: parseInt(row.wins),
          losses: parseInt(row.losses),
          filled: parseInt(row.filled),
          rejected: parseInt(row.rejected),
          totalPnl: parseFloat(row.total_pnl),
        };
      } catch { /* OK — no trades yet */ }

      const liveCapital = getLiveSetting ? await getLiveSetting('TRADING_CAPITAL', config.TRADING_CAPITAL) : config.TRADING_CAPITAL;
      json(res, {
        pnl: tradeStats.totalPnl || 0,
        pnlPct: (tradeStats.totalPnl / liveCapital * 100) || 0,
        tradeCount: tradeStats.count,
        winCount: tradeStats.wins,
        lossCount: tradeStats.losses,
        filled: tradeStats.filled,
        rejected: tradeStats.rejected,
        drawdownPct: riskStatus.drawdownPct || 0,
        capital: liveCapital,
        capitalDeployed: riskStatus.dailyPnl ? Math.abs(riskStatus.dailyPnl) : 0,
        paperMode: !config.LIVE_TRADING,
        killSwitchEngaged: ksStatus.engaged,
        killSwitchReason: ksStatus.reason,
        bestTrade: null,
        worstTrade: null,
        dailyRoi: roiData.dailyRoi,
        totalCashRequired: roiData.totalCashRequired,
        currentDeployment: roiData.currentDeployment,
        walletDeployed: roiData.walletDeployed,   // net fresh wallet cash still locked in positions (≤ capital)
        peakDeployment: roiData.peakDeployment,
      });
    } catch (err) {
      log.error({ err }, 'Error in /api/summary');
      json(res, { error: err.message }, 500);
    }
  }

  async function handlePositions(req, res) {
    try {
      const enginePositions = engine._filledPositions;

      if (enginePositions && enginePositions.size > 0) {
        const symbols = Array.from(enginePositions.keys());
        let priceMap = {};

        // FAST PATH: Read instantaneous prices directly from WebSocket tick buffer
        if (tickFeed && tickFeed.latestTicks && tickFeed.symbolMap) {
            // symbolMap is { token: symbol }. Invert it once for fast lookups
            const invertedMap = {};
            for (const [tok, s] of Object.entries(tickFeed.symbolMap)) {
                invertedMap[s] = tok;
            }

            for (const sym of symbols) {
              const tokenStr = invertedMap[sym];
              if (tokenStr) {
                  const tick = tickFeed.latestTicks.get(Number(tokenStr)) || tickFeed.latestTicks.get(tokenStr);
                  if (tick && tick.ltp > 0) {
                      priceMap[sym] = tick.ltp;
                  }
              }
            }
        }

        // SLOW PATH: Fallback to broker API ONLY for symbols missing from the fast tick buffer
        const missingSymbols = symbols.filter(sym => !priceMap[sym]);
        if (broker && missingSymbols.length > 0) {
          try {
            const keys = missingSymbols.map(s => `NSE:${s}`);
            const ltp = await broker.getLTP(keys);
            for (const sym of missingSymbols) {
              const price = ltp?.[`NSE:${sym}`]?.last_price;
              if (price && price > 0) priceMap[sym] = price;
            }
          } catch { /* fail gracefully */ }
        }

        const positions = symbols.map(symbol => {
          const ctx = enginePositions.get(symbol);
          const currentPrice = priceMap[symbol] ?? null;
          const entryPrice = ctx.entryPrice ?? ctx.price;
          const isShort = ctx.isShort ?? ctx.direction === 'SELL';
          const unrealisedPnL = currentPrice != null
            ? isShort
              ? (entryPrice - currentPrice) * ctx.quantity   // short profits when price falls
              : (currentPrice - entryPrice) * ctx.quantity
            : null;
          const unrealisedPnLPct = currentPrice != null
            ? isShort
              ? ((entryPrice - currentPrice) / entryPrice) * 100  // short profits when price falls
              : ((currentPrice - entryPrice) / entryPrice) * 100
            : null;
          const holdMinutes = (Date.now() - ctx.timestamp) / 60000;
          const stopDistancePct = currentPrice != null && ctx.stopPrice
            ? ((currentPrice - ctx.stopPrice) / currentPrice) * 100 : null;
          const trailDistancePct = currentPrice != null && ctx.trailStopPrice
            ? ((currentPrice - ctx.trailStopPrice) / currentPrice) * 100 : null;

          return {
            symbol,
            side: ctx.direction ?? 'BUY',
            quantity: ctx.quantity,
            avgPrice: entryPrice,
            entryPrice,
            currentPrice,
            targetPrice: ctx.profitTargetPrice ?? null,
            stopPrice: ctx.stopPrice ?? null,
            stopLoss: ctx.stopPrice ?? null,
            trailStopPrice: ctx.trailStopPrice ?? null,
            highWaterMark: ctx.highWaterMark ?? null,
            unrealisedPnL: unrealisedPnL != null ? +unrealisedPnL.toFixed(2) : null,
            unrealisedPnLPct: unrealisedPnLPct != null ? +unrealisedPnLPct.toFixed(2) : null,
            holdMinutes: +holdMinutes.toFixed(1),
            stopDistancePct: stopDistancePct != null ? +stopDistancePct.toFixed(2) : null,
            trailDistancePct: trailDistancePct != null ? +trailDistancePct.toFixed(2) : null,
            strategies: ctx.strategies || [],
          };
        });

        return json(res, { positions, source: 'engine' });
      }

      let positions = [];
      try {
        const result = await query('SELECT * FROM open_positions ORDER BY opened_at DESC');
        positions = result.rows.map((p) => {
          const entryPrice = parseFloat(p.entry_price);
          const currentPrice = entryPrice;
          return {
            symbol: p.symbol,
            side: p.direction,
            quantity: p.quantity,
            avgPrice: entryPrice,
            entryPrice,
            currentPrice,
            targetPrice: p.profit_target ? parseFloat(p.profit_target) : null,
            stopPrice: p.stop_price ? parseFloat(p.stop_price) : null,
            stopLoss: p.stop_price ? parseFloat(p.stop_price) : null,
            unrealisedPnL: (p.direction === 'SELL'
              ? (entryPrice - currentPrice)
              : (currentPrice - entryPrice)) * p.quantity,
            product: 'MIS',
            strategy: p.opening_strategy,
          };
        });
      } catch {
        const active = engine.getActiveOrders();
        positions = active.map((o) => ({
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          avgPrice: o.price,
          entryPrice: o.price,
          currentPrice: o.filledPrice || o.price,
          targetPrice: o.profitTargetPrice ?? null,
          stopPrice: null,
          stopLoss: null,
          unrealisedPnL: ((o.filledPrice || o.price) - o.price) * o.quantity,
          product: o.product || 'MIS',
          strategy: o.strategy,
        }));
      }

      json(res, { positions, source: 'db' });
    } catch (err) {
      log.error({ err }, 'Error in /api/positions');
      json(res, { error: err.message }, 500);
    }
  }

  /**
   * GET /health — Public minimal health check.
   * Only signals process liveness. Safe to expose publicly.
   */
  async function handlePublicHealth(req, res) {
    const engaged = killSwitch?.isEngaged?.() ?? false;
    json(res, {
      status: engaged ? 'halted' : 'ok',
      ts: new Date().toISOString(),
    });
  }

  async function handleHealth(req, res) {
    if (!checkAuth(req, res)) return;
    try {
      let dbOk = false;
      let redisOk = false;
      let brokerOk = false;
      let tokenValid = null; // null = no broker configured

      try { dbOk = await checkDatabaseHealth(); } catch { /* */ }
      try { redisOk = await checkRedisHealth(); } catch { /* */ }

      if (broker) {
        try {
          brokerOk = await broker.isConnected();
          // Only check token validity if API is reachable
          if (brokerOk && typeof broker.isTokenValid === 'function') {
            tokenValid = await broker.isTokenValid();
          }
        } catch {
          brokerOk = false;
          tokenValid = null;
        }
      }

      json(res, {
        broker: brokerOk,
        brokerTokenValid: tokenValid,
        redis: redisOk,
        db: dbOk,
        dataFeed: brokerOk,
        telegram: telegram ? telegram.enabled : false,
        lastCheck: new Date().toISOString(),
      });
    } catch (err) {
      log.error({ err }, 'Error in /api/health');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleHoldings(req, res) {
    try {
      const timestamp = new Date().toISOString();
      if (!holdingsManager || !broker) {
        return json(res, { holdings: [], totalValue: 0, timestamp });
      }
      const { totalValue, holdings } = await holdingsManager.getTotalExposureValue();
      json(res, { holdings, totalValue, timestamp });
    } catch (err) {
      log.error({ err }, 'Error in /api/holdings');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleTrades(req, res) {
    try {
      const params = parseQuery(req.url);
      const conditions = [];
      const values = [];
      let paramIdx = 1;

      // Fix Bug 12: Use timezone-aware date comparison so trades created around midnight
      // IST (= 18:30 UTC) are included in the correct local day's results.
      if (params.startDate) {
        conditions.push(`(created_at AT TIME ZONE 'Asia/Kolkata')::date >= $${paramIdx++}::date`);
        values.push(params.startDate);
      }
      if (params.endDate) {
        conditions.push(`(created_at AT TIME ZONE 'Asia/Kolkata')::date <= $${paramIdx++}::date`);
        values.push(params.endDate);
      }
      if (params.strategy) {
        conditions.push(`(strategy = $${paramIdx} OR opening_strategies LIKE $${paramIdx + 1})`);
        values.push(params.strategy, `%"${params.strategy}"%`);
        paramIdx += 2;
      }
      if (params.symbol) {
        conditions.push(`symbol ILIKE $${paramIdx++}`);
        values.push(`%${params.symbol}%`);
      }
      if (params.side) {
        conditions.push(`side = $${paramIdx++}`);
        values.push(params.side);
      }

      const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
      const result = await query(
        `SELECT * FROM trades ${where} ORDER BY created_at DESC LIMIT 200`,
        values
      );

      const trades = result.rows.map((t) => {
        // Derive trade type from available fields (no schema change needed):
        //   opening_strategies not null  → this row IS an entry (BUY=long entry, SELL=short entry)
        //   pnl != 0 + side=BUY         → short cover (closing a short)
        //   pnl != 0 + side=SELL        → long exit

        let hasOpeningStrategies = t.opening_strategies && t.opening_strategies !== '[]' && t.opening_strategies !== 'null';

        const pnl = parseFloat(t.pnl) || 0;

        // Fix for past trades affected by the execution engine race condition:
        // Exits should never pretend to be entries.
        const exitStrategies = new Set([
          'MANUAL_EXIT', 'PARTIAL_EXIT', 'STOP_LOSS', 'TRAILING_STOP',
          'PROFIT_TARGET', 'END_OF_DAY', 'MAX_HOLD_TIME', 'SIGNAL_REVERSAL', 'KILL_SWITCH'
        ]);
        if (exitStrategies.has(t.strategy)) {
          hasOpeningStrategies = false;
        }

        let tradeType;
        if (t.side === 'BUY') {
          if (hasOpeningStrategies) tradeType = 'LONG_ENTRY';
          else if (Math.abs(pnl) < 0.01 && !exitStrategies.has(t.strategy)) tradeType = 'LONG_ENTRY'; // Legacy fallback
          else tradeType = 'SHORT_COVER';
        } else {
          if (hasOpeningStrategies) tradeType = 'SHORT_ENTRY';
          else if (Math.abs(pnl) < 0.01 && !exitStrategies.has(t.strategy)) tradeType = 'SHORT_ENTRY'; // Legacy fallback
          else tradeType = 'LONG_EXIT';
        }

        let displayStrategy = t.strategy;
        if (hasOpeningStrategies) {
          try {
            const parsed = JSON.parse(t.opening_strategies);
            if (parsed.length > 0) displayStrategy = parsed[0];
          } catch (e) {}
        }

        return {
          date: new Date(t.created_at).toLocaleDateString('en-IN'),
          timestamp: new Date(t.created_at).toISOString(),
          symbol: t.symbol,
          side: t.side,
          tradeType,
          quantity: t.quantity,
          price: parseFloat(t.price),
          pnl,
          strategy: displayStrategy,
          status: t.status,
          orderId: t.order_id,
          capitalDeployed: t.capital_deployed ? parseFloat(t.capital_deployed) : null,
          tradeRoi: t.trade_roi ? parseFloat(t.trade_roi) : null,
        };
      });

      json(res, { trades });
    } catch (err) {
      log.error({ err }, 'Error in /api/trades');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleStrategiesPerformance(req, res) {
    try {
      const result = await query(`
        SELECT
          CASE 
            WHEN opening_strategies IS NOT NULL AND opening_strategies NOT IN ('null', '[]')
            THEN (opening_strategies::json->>0)
            ELSE strategy
          END as clean_strategy,
          COUNT(*) as trade_count,
          COUNT(*) FILTER (WHERE pnl > 0)  as wins,
          COUNT(*) FILTER (WHERE pnl <= 0) as losses,
          ROUND(AVG(pnl / NULLIF(price * quantity, 0) * 100)::numeric, 2) as avg_return,
          COALESCE(SUM(pnl), 0) as total_pnl,
          ROUND((COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*)::numeric, 0) * 100), 1) as win_rate
        FROM trades
        WHERE strategy IS NOT NULL
          AND strategy NOT IN ('MANUAL_EXIT', 'PARTIAL_EXIT', 'STOP_LOSS', 'TRAILING_STOP', 'PROFIT_TARGET', 'END_OF_DAY', 'MAX_HOLD_TIME', 'SIGNAL_REVERSAL', 'KILL_SWITCH')
        GROUP BY clean_strategy
        ORDER BY total_pnl DESC
      `);

      const strategies = result.rows.map((r) => ({
        name: r.clean_strategy.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        winRate: parseFloat(r.win_rate) || 0,
        avgReturn: parseFloat(r.avg_return) || 0,
        totalPnl: parseFloat(r.total_pnl) || 0,
        sharpe: null,
        maxDrawdown: null,
        tradeCount: parseInt(r.trade_count),
        wins: parseInt(r.wins),
        losses: parseInt(r.losses),
      }));

      json(res, { strategies });
    } catch (err) {
      log.error({ err }, 'Error in /api/strategies/performance');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleStrategiesSignals(req, res) {
    try {
      const params = parseQuery(req.url);
      const limit = Math.min(parseInt(params.limit) || 50, 200);
      const result = await query(
        'SELECT * FROM signals ORDER BY created_at DESC LIMIT $1',
        [limit]
      );

      const signals = result.rows.map((s) => {
        const dt = new Date(s.created_at);
        return {
          date: dt.toLocaleDateString('en-IN', {
            day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata',
          }),
          time: dt.toLocaleTimeString('en-IN', {
            hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata',
          }),
          strategy: s.strategy,
          symbol: s.symbol,
          signal: s.signal,
          confidence: s.confidence,
          actedOn: s.acted_on,
        };
      });

      json(res, { signals });
    } catch (err) {
      log.error({ err }, 'Error in /api/strategies/signals');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleSettingsGet(req, res) {
    try {
      let watchlist = [];
      try {
        const result = await query("SELECT value FROM settings WHERE key = 'watchlist'");
        watchlist = result.rows[0] ? JSON.parse(result.rows[0].value) : [];
      } catch { /* */ }

      let telegramStatus = { enabled: false, totalSent: 0, totalFailed: 0, queueLength: 0 };
      if (telegram) {
        const s = telegram.getStatus();
        telegramStatus = {
          enabled: s.enabled,
          totalSent: s.totalSent,
          totalFailed: s.totalFailed,
          queueLength: s.queueLength,
        };
      }

      const liveCapital = getLiveSetting ? await getLiveSetting('TRADING_CAPITAL', config.TRADING_CAPITAL) : config.TRADING_CAPITAL;
      const liveMaxDailyLoss = getLiveSetting ? await getLiveSetting('MAX_DAILY_LOSS_PCT', config.MAX_DAILY_LOSS_PCT) : config.MAX_DAILY_LOSS_PCT;
      const livePerTradeStopLoss = getLiveSetting ? await getLiveSetting('PER_TRADE_STOP_LOSS_PCT', config.PER_TRADE_STOP_LOSS_PCT) : config.PER_TRADE_STOP_LOSS_PCT;
      const liveMaxPositionCount = getLiveSetting ? await getLiveSetting('MAX_POSITION_COUNT', config.MAX_POSITION_COUNT) : config.MAX_POSITION_COUNT;
      const liveKillSwitchDrawdown = getLiveSetting ? await getLiveSetting('KILL_SWITCH_DRAWDOWN_PCT', config.KILL_SWITCH_DRAWDOWN_PCT) : config.KILL_SWITCH_DRAWDOWN_PCT;

      json(res, {
        paperMode: !config.LIVE_TRADING,
        capital: liveCapital,
        maxDailyLossPct: liveMaxDailyLoss,
        perTradeStopLossPct: livePerTradeStopLoss,
        maxPositionCount: liveMaxPositionCount,
        killSwitchDrawdownPct: liveKillSwitchDrawdown,
        killSwitchEngaged: killSwitch.isEngaged(),
        watchlist,
        telegram: telegramStatus,
      });
    } catch (err) {
      log.error({ err }, 'Error in /api/settings');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleKillSwitch(req, res) {
    if (!checkAuth(req, res)) return;
    try {
      const body = await parseBody(req);
      if (body.action === 'engage') {
        await killSwitch.engage(body.reason || 'Manual dashboard trigger');
        log.warn({ reason: body.reason }, '🛑 Kill switch ENGAGED from dashboard');
        json(res, { success: true, engaged: true });
      } else if (body.action === 'reset') {
        const result = await killSwitch.reset('CONFIRM_RESET');
        json(res, { success: result, engaged: killSwitch.isEngaged() });
      } else {
        json(res, killSwitch.getStatus());
      }
    } catch (err) {
      log.error({ err }, 'Error in /api/killswitch');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleSettingsMode(req, res) {
    if (!checkAuth(req, res)) return;
    try {
      const body = await parseBody(req);
      await cacheSet('trading:mode', { paperMode: body.paperMode });
      log.info({ paperMode: body.paperMode }, 'Trading mode preference updated');
      json(res, { success: true, paperMode: body.paperMode });
    } catch (err) {
      log.error({ err }, 'Error in /api/settings/mode');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleSettingsWatchlist(req, res) {
    if (!checkAuth(req, res)) return;
    try {
      const body = await parseBody(req);

      let watchlist = [];
      try {
        const result = await query("SELECT value FROM settings WHERE key = 'watchlist'");
        watchlist = result.rows[0] ? JSON.parse(result.rows[0].value) : [];
      } catch { /* */ }

      if (body.action === 'add' && body.symbol) {
        if (!watchlist.includes(body.symbol)) watchlist.push(body.symbol);
      } else if (body.action === 'remove' && body.symbol) {
        watchlist = watchlist.filter((s) => s !== body.symbol);
      }

      await query(
        `INSERT INTO settings (key, value, updated_at) VALUES ('watchlist', $1, NOW())
         ON CONFLICT (key) DO UPDATE SET value = $1, updated_at = NOW()`,
        [JSON.stringify(watchlist)]
      );

      json(res, { success: true, watchlist });
    } catch (err) {
      log.error({ err }, 'Error in /api/settings/watchlist');
      json(res, { error: err.message }, 500);
    }
  }

  // ═══════════════════════════════════════════════════════
  // LIVE SETTINGS HANDLERS
  // ═══════════════════════════════════════════════════════

  async function handleLiveSettingsGet(req, res) {
    try {
      if (!getAllLiveSettings) {
        return json(res, {
          settings: {}, activeRiskParams: {}, baseRiskParams: {},
          available: false, reason: 'Live settings not configured',
        });
      }

      const overrides = await getAllLiveSettings();
      const settings = {};

      for (const [key, schema] of Object.entries(LIVE_SETTINGS_SCHEMA)) {
        const hasOverride = key in overrides &&
          overrides[key] !== null &&
          overrides[key] !== undefined;

        settings[key] = {
          ...schema,
          currentValue: hasOverride ? Number(overrides[key]) : schema.default,
          overrideValue: hasOverride ? Number(overrides[key]) : null,
          isOverridden: hasOverride,
        };
      }

      const riskStatus = riskManager.getStatus();

      json(res, {
        settings,
        activeRiskParams: riskStatus.activeParams || {},
        baseRiskParams: riskStatus.baseParams || {},
        available: true,
      });
    } catch (err) {
      log.error({ err }, 'Error in GET /api/live-settings');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleLiveSettingsSet(req, res) {
    if (!checkAuth(req, res)) return;

    try {
      if (!setLiveSetting || !resetLiveSetting) {
        return json(res, { error: 'Live settings not configured' }, 503);
      }

      const body = await parseBody(req);

      // ── Reset all overrides ────────────────────────────────────────────────
      if (body.resetAll) {
        for (const key of Object.keys(LIVE_SETTINGS_SCHEMA)) {
          await resetLiveSetting(key).catch(() => { });
        }
        log.info('All live settings reset to .env defaults');
        json(res, { success: true, action: 'resetAll' });
        return;
      }

      const { key, value, reset } = body;

      if (!key || !(key in LIVE_SETTINGS_SCHEMA)) {
        return json(res, {
          error: `Unknown setting key: "${key}"`,
          validKeys: Object.keys(LIVE_SETTINGS_SCHEMA),
        }, 400);
      }

      // ── Reset single key ───────────────────────────────────────────────────
      if (reset) {
        await resetLiveSetting(key);
        log.info({ key }, 'Live setting reset to .env default');
        json(res, { success: true, action: 'reset', key });
        return;
      }

      // ── Validate value ─────────────────────────────────────────────────────
      const schema = LIVE_SETTINGS_SCHEMA[key];

      // ADD THIS BLOCK before the numValue lines:
      // Handle boolean type params (PARTIAL_EXIT_ENABLED, SIGNAL_REVERSAL_ENABLED)
      if (schema.type === 'boolean') {
        if (value !== 'true' && value !== 'false' && value !== true && value !== false) {
          return json(res, { error: `Value must be 'true' or 'false' for boolean parameter ${key}` }, 400);
        }
        const boolValue = value === 'true' || value === true;
        await setLiveSetting(key, String(boolValue));
        log.info({ key, value: boolValue }, '⚙️  Live boolean setting updated');
        json(res, { success: true, action: 'set', key, value: boolValue, label: schema.label });
        return;
      }

      // Handle select type params (TRAIL_MODE)
      if (schema.type === 'select') {
        if (!schema.options.includes(value)) {
          return json(res, { error: `Invalid option '${value}' for ${key}. Allowed: ${schema.options.join(', ')}` }, 400);
        }
        await setLiveSetting(key, value);
        log.info({ key, value }, '⚙️  Live select setting updated');
        json(res, { success: true, action: 'set', key, value, label: schema.label });
        return;
      }

      const numValue = Number(value);

      if (isNaN(numValue)) {
        return json(res, { error: `Value must be a number, got: ${value}` }, 400);
      }
      if (numValue < schema.min || numValue > schema.max) {
        return json(res, {
          error: `Value ${numValue} out of range [${schema.min}, ${schema.max}] for ${key}`,
        }, 400);
      }

      // ── Cross-param guards ─────────────────────────────────────────────────

      // EMA fast < slow guard (Fix N7)
      if (key === 'EMA_FAST_PERIOD') {
        const slow = getLiveSetting ? await getLiveSetting('EMA_SLOW_PERIOD', 21) : 21;
        if (numValue >= slow) {
          return json(res, {
            error: `EMA_FAST_PERIOD (${numValue}) must be less than EMA_SLOW_PERIOD (${slow}).`,
          }, 400);
        }
      }
      if (key === 'EMA_SLOW_PERIOD') {
        const fast = getLiveSetting ? await getLiveSetting('EMA_FAST_PERIOD', 9) : 9;
        if (numValue <= fast) {
          return json(res, {
            error: `EMA_SLOW_PERIOD (${numValue}) must be greater than EMA_FAST_PERIOD (${fast}).`,
          }, 400);
        }
      }

      // RSI: oversold < overbought
      if (key === 'RSI_OVERSOLD') {
        const ob = getLiveSetting ? await getLiveSetting('RSI_OVERBOUGHT', 70) : 70;
        if (numValue >= ob) {
          return json(res, {
            error: `RSI_OVERSOLD (${numValue}) must be less than RSI_OVERBOUGHT (${ob})`,
          }, 400);
        }
      }
      if (key === 'RSI_OVERBOUGHT') {
        const os = getLiveSetting ? await getLiveSetting('RSI_OVERSOLD', 30) : 30;
        if (numValue <= os) {
          return json(res, {
            error: `RSI_OVERBOUGHT (${numValue}) must be greater than RSI_OVERSOLD (${os})`,
          }, 400);
        }
      }

      // Kill switch drawdown >= max daily loss
      if (key === 'KILL_SWITCH_DRAWDOWN_PCT') {
        const maxLoss = getLiveSetting
          ? await getLiveSetting('MAX_DAILY_LOSS_PCT', config.MAX_DAILY_LOSS_PCT)
          : config.MAX_DAILY_LOSS_PCT;
        if (numValue < maxLoss) {
          return json(res, {
            error: `KILL_SWITCH_DRAWDOWN_PCT (${numValue}) must be >= MAX_DAILY_LOSS_PCT (${maxLoss})`,
          }, 400);
        }
      }
      if (key === 'MAX_DAILY_LOSS_PCT') {
        const ks = getLiveSetting
          ? await getLiveSetting('KILL_SWITCH_DRAWDOWN_PCT', config.KILL_SWITCH_DRAWDOWN_PCT)
          : config.KILL_SWITCH_DRAWDOWN_PCT;
        if (numValue > ks) {
          return json(res, {
            error: `MAX_DAILY_LOSS_PCT (${numValue}) must be <= KILL_SWITCH_DRAWDOWN_PCT (${ks})`,
          }, 400);
        }
      }

      // Stop loss < trailing stop (otherwise trailing never triggers before hard stop)
      if (key === 'STOP_LOSS_PCT') {
        const trail = getLiveSetting
          ? await getLiveSetting('TRAILING_STOP_PCT', config.TRAILING_STOP_PCT ?? 1.5)
          : (config.TRAILING_STOP_PCT ?? 1.5);
        if (numValue >= trail) {
          return json(res, {
            error: `STOP_LOSS_PCT (${numValue}) must be less than TRAILING_STOP_PCT (${trail})`,
          }, 400);
        }
      }
      if (key === 'TRAILING_STOP_PCT') {
        const stop = getLiveSetting
          ? await getLiveSetting('STOP_LOSS_PCT', config.STOP_LOSS_PCT ?? 1.0)
          : (config.STOP_LOSS_PCT ?? 1.0);
        if (numValue <= stop) {
          return json(res, {
            error: `TRAILING_STOP_PCT (${numValue}) must be greater than STOP_LOSS_PCT (${stop})`,
          }, 400);
        }
      }

      if (key === 'PARTIAL_EXIT_PCT') {
        if (numValue >= 100) {
          return json(res, {
            error: `PARTIAL_EXIT_PCT (${numValue}) must be less than 100 — use PROFIT_TARGET for full exits`,
          }, 400);
        }
      }

      if (key === 'RISK_REWARD_RATIO') {
        const stopPct = getLiveSetting
          ? await getLiveSetting('STOP_LOSS_PCT', config.STOP_LOSS_PCT ?? 1.0)
          : (config.STOP_LOSS_PCT ?? 1.0);
        if (numValue < 1) {
          return json(res, {
            error: `RISK_REWARD_RATIO (${numValue}) must be >= 1 (target must be at least as large as the stop)`,
          }, 400);
        }
      }

      // ── Apply ──────────────────────────────────────────────────────────────
      await setLiveSetting(key, numValue);
      log.info({ key, value: numValue, label: schema.label }, '⚙️  Live setting updated');

      if (telegram?.enabled) {
        telegram.sendRaw(
          `⚙️ <b>Parameter Updated</b>\n\n` +
          `<b>${schema.label}</b>\n` +
          `New value: <code>${numValue}</code>  (default: <code>${schema.default}</code>)\n` +
          `<i>${schema.description}</i>\n\n` +
          `Takes effect on next scan cycle.`
        ).catch(() => { });
      }

      json(res, { success: true, action: 'set', key, value: numValue, label: schema.label });
    } catch (err) {
      log.error({ err }, 'Error in POST /api/live-settings');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleLiveSettingsSchema(req, res) {
    try {
      json(res, {
        schema: LIVE_SETTINGS_SCHEMA,
        categories: {
          risk: 'Risk Management',
          ema: 'EMA Crossover Strategy',
          rsi: 'RSI Mean Reversion Strategy',
          vwap: 'VWAP Momentum Strategy',
          breakout: 'Breakout Volume Strategy',
          exits: 'Exit Strategies',
          consensus: 'Signal Consensus',
        },
      });
    } catch (err) {
      log.error({ err }, 'Error in /api/live-settings/schema');
      json(res, { error: err.message }, 500);
    }
  }

  async function handlePositionExit(req, res) {
    if (!checkAuth(req, res)) return;
    try {
      const body = await parseBody(req);
      const { symbol } = body;

      if (!symbol || typeof symbol !== 'string') {
        return json(res, { error: 'symbol is required' }, 400);
      }

      const pos = engine._filledPositions?.get(symbol.toUpperCase());
      if (!pos) {
        return json(res, { error: `No open position found for ${symbol}` }, 404);
      }

      // Get latest price from broker; fall back to entry price
      let exitPrice = pos.entryPrice;
      try {
        if (broker?.getLTP) {
          const ltp = await broker.getLTP([`NSE:${symbol.toUpperCase()}`]);
          exitPrice = ltp?.[`NSE:${symbol.toUpperCase()}`]?.last_price || exitPrice;
        }
      } catch { /* use entry price as fallback */ }

      const reason = 'MANUAL_EXIT';
      log.warn({ symbol, exitPrice, operator: 'dashboard' }, '🔴 Manual exit triggered from dashboard');

      const result = await engine.forceExit(symbol.toUpperCase(), exitPrice, reason);

      if (telegram?.enabled) {
        const pnl = result?.pnl ?? 0;
        const pnlStr = pnl >= 0 ? `+₹${pnl.toFixed(2)}` : `-₹${Math.abs(pnl).toFixed(2)}`;
        telegram.sendRaw(
          `🔴 <b>Manual Exit — ${symbol.toUpperCase()}</b>\n\n` +
          `📌 Triggered from dashboard\n` +
          `📤 Exit price: ₹${exitPrice.toFixed(2)}\n` +
          `💰 P&amp;L: ${pnlStr}\n` +
          `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
        ).catch(() => { });
      }

      json(res, { success: result?.success ?? true, symbol, exitPrice, pnl: result?.pnl ?? null });
    } catch (err) {
      log.error({ err }, 'Error in POST /api/positions/exit');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleScreenerGet(req, res) {
    try {
      const params  = parseQuery(req.url);
      const refresh = params.refresh === '1';

      const { results, fromCache, scannedAt } = await getScreenerResults({
        broker,
        instrumentManager,
        forceRefresh: refresh,
      });

      // Apply optional query filters
      const minScore    = parseFloat(params.minScore)  || 0;
      const regime      = (params.regime || '').toUpperCase() || null;
      const minTurnover = parseFloat(params.minTurnover) || 0;
      const limit       = parseInt(params.limit) || 300;

      let filtered = results;
      if (minScore > 0)    filtered = filtered.filter(r => r.score >= minScore);
      if (regime)          filtered = filtered.filter(r => r.regime === regime);
      if (minTurnover > 0) filtered = filtered.filter(r => (r.breakdown?.liquidity?.turnoverCr ?? 0) >= minTurnover);

      json(res, {
        results:    filtered.slice(0, limit),
        total:      filtered.length,
        scanned:    results.length,
        fromCache,
        scannedAt:  scannedAt ?? null,
      });
    } catch (err) {
      log.error({ err }, 'Error in /api/screener');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleKillSwitchGet(req, res) {
    if (!checkAuth(req, res)) return;
    json(res, killSwitch.getStatus());
  }

  async function handleLivePriceGet(req, res) {
    try {
      const params = parseQuery(req.url);
      const symbol = params.symbol;
      if (!symbol) return json(res, { error: 'symbol is required' }, 400);

      let ltp = null;
      let source = 'none';

      // 1. Try broker LTP first (cheapest call, no rate-limit concern)
      if (broker?.getLTP) {
        try {
          const result = await broker.getLTP([`NSE:${symbol.toUpperCase()}`]);
          ltp = result?.[`NSE:${symbol.toUpperCase()}`]?.last_price ?? null;
          if (ltp != null) source = 'broker';
        } catch { /* fallthrough */ }
      }

      // 2. Try from live tick data (tickFeed last price cache)
      if (ltp == null && tickFeed?.getLastTick) {
        const tick = tickFeed.getLastTick(symbol.toUpperCase());
        if (tick?.last_price) { ltp = tick.last_price; source = 'tick'; }
      }

      if (ltp == null) return json(res, { error: 'Price unavailable' }, 503);

      json(res, { symbol: symbol.toUpperCase(), ltp, timestamp: new Date().toISOString(), source });
    } catch (err) {
      log.error({ err }, 'Error in /api/live-price');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleCandlesGet(req, res) {
    try {
      const params = parseQuery(req.url);
      const symbol = params.symbol;
      const interval = params.interval || '5minute';
      const days = parseInt(params.days) || 5;
      
      if (!symbol) {
        return json(res, { error: 'symbol is required' }, 400);
      }

      const endDateStr = params.endDate;
      const toDate = endDateStr ? new Date(endDateStr) : new Date();
      if (endDateStr && !toDate.toISOString().includes('T23')) {
          toDate.setHours(23, 59, 59, 999);
      }
      
      const fromDate = new Date(toDate);
      fromDate.setDate(toDate.getDate() - days);

      const fmt = d => d.toISOString().split('T')[0];

      // Use broker if available to fetch intraday data securely
      const instrumentToken = instrumentManager ? instrumentManager.getToken(symbol.toUpperCase()) : null;

      const candles = await fetchHistoricalData({
        broker,
        symbol: symbol.toUpperCase(),
        instrumentToken, 
        interval,
        from: fmt(fromDate),
        to: fmt(toDate),
      });

      if (!candles || candles.length === 0) {
        return json(res, { candles: [] });
      }

      // Format for TradingView lightweight charts: { time, open, high, low, close }
      // The time needs to be UNIX timestamp in seconds
      const formatted = candles.map(c => ({
        time: Math.floor(new Date(c.timestamp).getTime() / 1000),
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume
      }));

      // In lightweight-charts, time arrays MUST be strictly ascending with no duplicates.
      // fetchHistoricalData might return duplicates if fallback/Kite stitched poorly, so let's guarantee uniqueness/sorting.
      formatted.sort((a, b) => a.time - b.time);
      const unique = [];
      let lastTime = 0;
      for (const c of formatted) {
          if (c.time > lastTime) {
              unique.push(c);
              lastTime = c.time;
          }
      }

      json(res, { candles: unique, symbol, interval });
    } catch (err) {
      log.error({ err }, 'Error in /api/candles');
      json(res, { error: err.message }, 500);
    }
  }

  // ═══════════════════════════════════════════════════════
  // MAIN ROUTER
  // ═══════════════════════════════════════════════════════

  return async function handleRequest(req, res) {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, X-Api-Key',
      });
      return res.end();
    }

    const url = req.url.split('?')[0];

    try {
      if (req.method === 'GET') {
        switch (url) {
          case '/health': return handlePublicHealth(req, res);
          case '/api/health': return handleHealth(req, res);
          case '/api/summary': return handleSummary(req, res);
          case '/api/positions': return handlePositions(req, res);
          case '/api/trades': return handleTrades(req, res);
          case '/api/strategies/performance': return handleStrategiesPerformance(req, res);
          case '/api/strategies/signals': return handleStrategiesSignals(req, res);
          case '/api/settings': return handleSettingsGet(req, res);
          case '/api/holdings': return handleHoldings(req, res);
          case '/api/live-settings': return handleLiveSettingsGet(req, res);
          case '/api/live-settings/schema': return handleLiveSettingsSchema(req, res);
          case '/api/killswitch': return handleKillSwitchGet(req, res);
          case '/api/candles': return handleCandlesGet(req, res);
          case '/api/live-price': return handleLivePriceGet(req, res);
          case '/api/screener': return handleScreenerGet(req, res);

        }
      }

      if (req.method === 'POST') {
        switch (url) {
          case '/api/positions/exit': return handlePositionExit(req, res);
          case '/api/killswitch': return handleKillSwitch(req, res);
          case '/api/settings/mode': return handleSettingsMode(req, res);
          case '/api/settings/watchlist': return handleSettingsWatchlist(req, res);
          case '/api/live-settings': return handleLiveSettingsSet(req, res);
        }
      }

      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      log.error({ err, url }, 'Unhandled API error');
      json(res, { error: 'Internal server error' }, 500);
    }
  };


}