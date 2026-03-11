import { createLogger } from '../lib/logger.js';
import { query, checkDatabaseHealth } from '../lib/db.js';
import { checkRedisHealth, cacheGet, cacheSet } from '../lib/redis.js';

const log = createLogger('backend-api');

/**
 * Create the API request handler for the backend HTTP server.
 * 
 * @param {Object} deps - Injected module instances
 * @param {import('../risk/kill-switch.js').KillSwitch} deps.killSwitch
 * @param {import('../risk/risk-manager.js').RiskManager} deps.riskManager
 * @param {import('../engine/execution-engine.js').ExecutionEngine} deps.engine
 * @param {Object} deps.config - Validated env config
 * @param {Object} [deps.broker] - BrokerManager (null in paper mode)
 * @returns {Function} HTTP request handler
 */
export function createApiHandler(deps) {
  const { killSwitch, riskManager, engine, config, broker, telegram, holdingsManager } = deps;
  const API_KEY = process.env.API_SECRET_KEY || '';

  /** Check API key for protected endpoints */
  function checkAuth(req, res) {
    if (!API_KEY) return true; // No key configured = open access (dev mode)
    const provided = req.headers['x-api-key'] || '';
    if (provided !== API_KEY) {
      json(res, { error: 'Unauthorized' }, 401);
      return false;
    }
    return true;
  }

  /** Parse JSON body from request */
  function parseBody(req) {
    return new Promise((resolve, reject) => {
      let data = '';
      req.on('data', (chunk) => { data += chunk; });
      req.on('end', () => {
        try {
          resolve(data ? JSON.parse(data) : {});
        } catch (e) {
          reject(new Error('Invalid JSON body'));
        }
      });
      req.on('error', reject);
    });
  }

  /** Send JSON response */
  function json(res, data, status = 200) {
    res.writeHead(status, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end(JSON.stringify(data));
  }

  /** Parse query params from URL */
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
      const engineStatus = engine.getStatus();
      const ksStatus = killSwitch.getStatus();

      // Try to get today's summary from DB
      let dbSummary = null;
      try {
        const today = new Date().toISOString().split('T')[0];
        const result = await query(
          'SELECT * FROM daily_summary WHERE trade_date = $1',
          [today]
        );
        dbSummary = result.rows[0] || null;
      } catch { /* DB may not have today's entry yet */ }

      // Count today's trades from DB
      let tradeStats = { count: 0, wins: 0, losses: 0, filled: 0, rejected: 0 };
      try {
        const today = new Date().toISOString().split('T')[0];
        const result = await query(`
          SELECT 
            COUNT(*) as count,
            COUNT(*) FILTER (WHERE pnl > 0) as wins,
            COUNT(*) FILTER (WHERE pnl < 0) as losses,
            COUNT(*) FILTER (WHERE status = 'FILLED') as filled,
            COUNT(*) FILTER (WHERE status = 'REJECTED') as rejected,
            COALESCE(SUM(pnl), 0) as total_pnl
          FROM trades 
          WHERE created_at::date = $1
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

      const summary = {
        pnl: dbSummary ? parseFloat(dbSummary.pnl) : tradeStats.totalPnl || 0,
        pnlPct: dbSummary ? parseFloat(dbSummary.pnl_pct) :
          (tradeStats.totalPnl / config.TRADING_CAPITAL * 100) || 0,
        tradeCount: dbSummary ? dbSummary.trade_count : tradeStats.count,
        winCount: dbSummary ? dbSummary.win_count : tradeStats.wins,
        lossCount: dbSummary ? dbSummary.loss_count : tradeStats.losses,
        filled: dbSummary ? dbSummary.filled : tradeStats.filled,
        rejected: dbSummary ? dbSummary.rejected : tradeStats.rejected,
        drawdownPct: riskStatus.drawdownPct || 0,
        capital: config.TRADING_CAPITAL,
        capitalDeployed: riskStatus.dailyPnl ? Math.abs(riskStatus.dailyPnl) : 0,
        paperMode: !config.LIVE_TRADING,
        killSwitchEngaged: ksStatus.engaged,
        killSwitchReason: ksStatus.reason,
        bestTrade: dbSummary?.best_trade || null,
        worstTrade: dbSummary?.worst_trade || null,
      };

      json(res, summary);
    } catch (err) {
      log.error({ err }, 'Error in /api/summary');
      json(res, { error: err.message }, 500);
    }
  }

  async function handlePositions(req, res) {
    try {
      // First try DB, then fall back to engine's active orders
      let positions = [];
      try {
        const result = await query('SELECT * FROM positions ORDER BY opened_at DESC');
        positions = result.rows.map((p) => ({
          symbol: p.symbol,
          side: p.side,
          quantity: p.quantity,
          avgPrice: parseFloat(p.avg_price),
          currentPrice: parseFloat(p.current_price || p.avg_price),
          stopLoss: p.stop_loss ? parseFloat(p.stop_loss) : null,
          product: p.product,
          strategy: p.strategy,
        }));
      } catch {
        // Fall back to engine active orders
        const active = engine.getActiveOrders();
        positions = active.map((o) => ({
          symbol: o.symbol,
          side: o.side,
          quantity: o.quantity,
          avgPrice: o.price,
          currentPrice: o.filledPrice || o.price,
          stopLoss: null,
          product: o.product || 'MIS',
          strategy: o.strategy,
        }));
      }

      json(res, { positions });
    } catch (err) {
      log.error({ err }, 'Error in /api/positions');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleHealth(req, res) {
    try {
      let dbOk = false;
      let redisOk = false;
      let brokerOk = false;

      try { dbOk = await checkDatabaseHealth(); } catch { /* */ }
      try { redisOk = await checkRedisHealth(); } catch { /* */ }
      try { brokerOk = broker ? await broker.isConnected() : false; } catch { /* */ }

      json(res, {
        broker: brokerOk,
        redis: redisOk,
        db: dbOk,
        dataFeed: brokerOk, // Data feed status mirrors broker
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

      if (params.startDate) {
        conditions.push(`created_at >= $${paramIdx++}`);
        values.push(params.startDate);
      }
      if (params.endDate) {
        conditions.push(`created_at <= $${paramIdx++}::date + interval '1 day'`);
        values.push(params.endDate);
      }
      if (params.strategy) {
        conditions.push(`strategy = $${paramIdx++}`);
        values.push(params.strategy);
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

      const trades = result.rows.map((t) => ({
        date: new Date(t.created_at).toLocaleDateString('en-IN'),
        symbol: t.symbol,
        side: t.side,
        quantity: t.quantity,
        price: parseFloat(t.price),
        pnl: parseFloat(t.pnl),
        strategy: t.strategy,
        status: t.status,
        orderId: t.order_id,
      }));

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
          strategy,
          COUNT(*) as trade_count,
          COUNT(*) FILTER (WHERE pnl > 0) as wins,
          COUNT(*) FILTER (WHERE pnl <= 0) as losses,
          ROUND(AVG(pnl / NULLIF(price * quantity, 0) * 100)::numeric, 2) as avg_return,
          COALESCE(SUM(pnl), 0) as total_pnl,
          ROUND((COUNT(*) FILTER (WHERE pnl > 0)::numeric / NULLIF(COUNT(*)::numeric, 0) * 100), 1) as win_rate
        FROM trades
        WHERE strategy IS NOT NULL
        GROUP BY strategy
        ORDER BY total_pnl DESC
      `);

      const strategies = result.rows.map((r) => ({
        name: r.strategy.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()),
        winRate: parseFloat(r.win_rate) || 0,
        avgReturn: parseFloat(r.avg_return) || 0,
        totalPnl: parseFloat(r.total_pnl) || 0,
        sharpe: null, // TODO: compute from daily returns
        maxDrawdown: null, // TODO: compute from equity curve
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

      const signals = result.rows.map((s) => ({
        timestamp: new Date(s.created_at).toLocaleTimeString('en-IN', {
          hour: '2-digit', minute: '2-digit', hour12: false,
        }),
        strategy: s.strategy,
        symbol: s.symbol,
        signal: s.signal,
        confidence: s.confidence,
        actedOn: s.acted_on,
      }));

      json(res, { signals });
    } catch (err) {
      log.error({ err }, 'Error in /api/strategies/signals');
      json(res, { error: err.message }, 500);
    }
  }

  async function handleSettingsGet(req, res) {
    try {
      // Get watchlist from DB
      let watchlist = [];
      try {
        const result = await query(
          "SELECT value FROM settings WHERE key = 'watchlist'"
        );
        watchlist = result.rows[0] ? JSON.parse(result.rows[0].value) : [];
      } catch { /* */ }

      // Get Telegram stats from bot instance
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

      json(res, {
        paperMode: !config.LIVE_TRADING,
        capital: config.TRADING_CAPITAL,
        maxDailyLossPct: config.MAX_DAILY_LOSS_PCT,
        perTradeStopLossPct: config.PER_TRADE_STOP_LOSS_PCT,
        maxPositionCount: config.MAX_POSITION_COUNT,
        killSwitchDrawdownPct: config.KILL_SWITCH_DRAWDOWN_PCT,
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
        const result = await killSwitch.reset('CONFIRM_RESET'); // C4: added await
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
      // NOTE: Mode changes require env var update + restart.
      // For now, store preference in Redis for display.
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

      // Get current watchlist
      let watchlist = [];
      try {
        const result = await query(
          "SELECT value FROM settings WHERE key = 'watchlist'"
        );
        watchlist = result.rows[0] ? JSON.parse(result.rows[0].value) : [];
      } catch { /* */ }

      if (body.action === 'add' && body.symbol) {
        if (!watchlist.includes(body.symbol)) {
          watchlist.push(body.symbol);
        }
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
  // MAIN ROUTER
  // ═══════════════════════════════════════════════════════

  return async function handleRequest(req, res) {
    // CORS preflight
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
      });
      return res.end();
    }

    const url = req.url.split('?')[0]; // Path without query string

    try {
      // GET routes
      if (req.method === 'GET') {
        switch (url) {
          case '/health':
          case '/api/health':
            return handleHealth(req, res);
          case '/api/summary':
            return handleSummary(req, res);
          case '/api/positions':
            return handlePositions(req, res);
          case '/api/trades':
            return handleTrades(req, res);
          case '/api/strategies/performance':
            return handleStrategiesPerformance(req, res);
          case '/api/strategies/signals':
            return handleStrategiesSignals(req, res);
          case '/api/settings':
            return handleSettingsGet(req, res);
          case '/api/holdings':
            return handleHoldings(req, res);
        }
      }

      // POST routes
      if (req.method === 'POST') {
        switch (url) {
          case '/api/killswitch':
            return handleKillSwitch(req, res);
          case '/api/settings/mode':
            return handleSettingsMode(req, res);
          case '/api/settings/watchlist':
            return handleSettingsWatchlist(req, res);
        }
      }

      // 404
      json(res, { error: 'Not found' }, 404);
    } catch (err) {
      log.error({ err, url }, 'Unhandled API error');
      json(res, { error: 'Internal server error' }, 500);
    }
  };
}
