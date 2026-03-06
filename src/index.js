import { config } from './config/env.js';
import { TIMEZONE, MARKET_HOLIDAYS_YEAR } from './config/constants.js';
import { createLogger } from './lib/logger.js';
import { initShutdownHandlers, registerShutdown } from './lib/shutdown.js';
import { initDatabase, checkDatabaseHealth, query } from './lib/db.js';
import { initRedis, checkRedisHealth, cacheGet, cacheSet, getRedis } from './lib/redis.js';
import { KillSwitch } from './risk/kill-switch.js';
import { RiskManager } from './risk/risk-manager.js';
import { calculatePositionSize } from './risk/position-sizer.js';
import { ExecutionEngine } from './engine/execution-engine.js';
import { SignalConsensus } from './engine/signal-consensus.js';
import { KiteClient } from './api/kite-client.js';
import { BrokerManager } from './api/broker-manager.js';
import { TelegramBot } from './notifications/index.js';
import { MarketScheduler } from './scheduler/index.js';
import { TickFeed, InstrumentManager, fetchRecentCandles } from './data/index.js';
import {
  EMACrossoverStrategy,
  RSIMeanReversionStrategy,
  VWAPMomentumStrategy,
  BreakoutVolumeStrategy,
} from './strategies/index.js';
import { createApiHandler } from './api/backend-api.js';

const log = createLogger('main');
const APP_VERSION = '1.0.0';

/**
 * Quant8 — Automated Stock Trading Application
 * Entry point: initializes all services, wires the trading pipeline,
 * and starts the market-day scheduler.
 */
async function main() {
  // ─── Startup Banner ────────────────────────────────────
  log.info('═══════════════════════════════════════════════════');
  log.info(`  🚀 Quant8 v${APP_VERSION}`);
  log.info(`  📊 Mode: ${config.LIVE_TRADING ? '🔴 LIVE TRADING' : '🟢 PAPER TRADING'}`);
  log.info(`  💰 Capital: ₹${config.TRADING_CAPITAL.toLocaleString('en-IN')}`);
  log.info(`  🌍 Timezone: ${TIMEZONE}`);
  log.info(`  🖥️  Environment: ${config.NODE_ENV}`);
  log.info('═══════════════════════════════════════════════════');

  if (config.LIVE_TRADING) {
    log.warn('');
    log.warn('  ⚠️  ⚠️  ⚠️  LIVE TRADING MODE IS ACTIVE ⚠️  ⚠️  ⚠️');
    log.warn('  Real money will be used for all orders!');
    log.warn('');
  } else {
    log.info('');
    log.info('  ⚠️  PAPER TRADING MODE — No real orders will be placed');
    log.info('  Set LIVE_TRADING=true in .env to enable live trading');
    log.info('');
  }

  // ─── Initialize Shutdown Handlers ──────────────────────
  initShutdownHandlers();
  log.info('Shutdown handlers initialized');

  // ─── Initialize Database ──────────────────────────────
  let dbHealthy = false;
  try {
    initDatabase(config.DATABASE_URL);
    dbHealthy = await checkDatabaseHealth();
    if (dbHealthy) {
      log.info('✅ Database connection verified');
    } else {
      log.warn('⚠️  Database is not reachable — some features may not work');
    }
  } catch (err) {
    log.warn({ err }, '⚠️  Database initialization failed — running without DB');
  }

  // ─── Initialize Redis ─────────────────────────────────
  let redisHealthy = false;
  try {
    const redis = initRedis(config.REDIS_URL);
    await redis.connect();
    redisHealthy = await checkRedisHealth();
    if (redisHealthy) {
      log.info('✅ Redis connection verified');
    } else {
      log.warn('⚠️  Redis is not reachable — caching disabled');
    }
  } catch (err) {
    log.warn({ err }, '⚠️  Redis initialization failed — running without cache');
  }

  // ─── H6/L2: Holiday Year Validation ────────────────────
  const currentYear = new Date().getFullYear();
  if (MARKET_HOLIDAYS_YEAR !== currentYear) {
    log.warn({
      holidayYear: MARKET_HOLIDAYS_YEAR,
      currentYear,
    }, `⚠️  MARKET_HOLIDAYS is for ${MARKET_HOLIDAYS_YEAR} but current year is ${currentYear}! Update constants.js`);
  }

  // ─── Initialize Kill Switch ────────────────────────────
  // Note: telegram ref is set later (Telegram initializes after kill switch)
  let telegramRef = null;

  const killSwitch = new KillSwitch({
    cacheGet: redisHealthy ? cacheGet : async () => null,
    cacheSet: redisHealthy ? cacheSet : async () => {},
    onEngage: async ({ reason, drawdownPct, engagedAt }) => {
      if (telegramRef?.enabled) {
        telegramRef.sendRaw(
          `🛑 <b>KILL SWITCH ENGAGED</b>\n\n` +
          `⚠️ Reason: ${reason}\n` +
          `📉 Drawdown: ${drawdownPct?.toFixed(2) || 0}%\n` +
          `🕐 ${engagedAt || new Date().toISOString()}\n\n` +
          `ALL TRADING IS HALTED. Manual reset required.`
        );
      }
    },
  });

  if (redisHealthy) {
    await killSwitch.loadFromRedis();
    const integrity = await killSwitch.verifyIntegrity();
    log.info({ integrity }, 'Kill switch integrity check complete');
  }

  if (killSwitch.isEngaged()) {
    log.warn('🛑 Kill switch is currently ENGAGED — all trading blocked');
  } else {
    log.info('✅ Kill switch: Normal');
  }

  // ─── Initialize Broker (from Redis access token) ───────
  let broker = null;
  let accessToken = null;

  try {
    if (redisHealthy) {
      // Read raw string (not JSON) — auto-login stores token as plain string
      accessToken = await getRedis().get('kite:access_token');
    }

    if (accessToken && config.KITE_API_KEY && config.KITE_API_KEY !== 'dev_placeholder') {
      const kiteClient = new KiteClient({
        apiKey: config.KITE_API_KEY,
        apiSecret: config.KITE_API_SECRET,
        accessToken,
      });

      broker = new BrokerManager(kiteClient);
      log.info('✅ Broker initialized (Kite Connect — token from Redis)');

      try {
        const profile = await kiteClient.getProfile();
        log.info({ user: profile.user_name, userId: profile.user_id }, '✅ Broker token verified');
      } catch (err) {
        log.warn({ err: err.message }, '⚠️  Broker token may be expired — run: npm run login');
        broker = null;
      }
    } else if (!accessToken) {
      log.warn('⚠️  No Kite access token in Redis — run: npm run login');
    } else {
      log.warn('⚠️  Kite API key is placeholder — broker not initialized');
    }
  } catch (err) {
    log.warn({ err: err.message }, '⚠️  Broker initialization failed');
  }

  // ─── Initialize Instrument Manager ─────────────────────
  let instrumentManager = null;
  if (broker) {
    try {
      instrumentManager = new InstrumentManager(broker);
      const count = await instrumentManager.load(['NSE']);
      log.info({ instruments: count }, '✅ Instrument manager loaded');
    } catch (err) {
      log.warn({ err: err.message }, '⚠️  Instrument loading failed — strategies will use fallback data');
      instrumentManager = null;
    }
  } else {
    log.info('ℹ️  Instrument manager skipped — no broker connection');
  }

  // ─── Initialize Tick Feed ──────────────────────────────
  let tickFeed = null;
  if (broker && accessToken) {
    try {
      tickFeed = new TickFeed({
        apiKey: config.KITE_API_KEY,
        accessToken,
        respectMarketHours: true,
        ohlcvIntervalMs: 60000, // 1-minute OHLCV candles
        symbolMap: {},
      });
      log.info('✅ Tick feed created (will connect at market open)');
    } catch (err) {
      log.warn({ err: err.message }, '⚠️  Tick feed creation failed');
    }
  } else {
    log.info('ℹ️  Tick feed skipped — no broker connection');
  }

  // ─── Initialize Risk Manager ───────────────────────────
  const riskManager = new RiskManager({
    capital: config.TRADING_CAPITAL,
    killSwitch,
    maxDailyLossPct: config.MAX_DAILY_LOSS_PCT,
    perTradeStopLossPct: config.PER_TRADE_STOP_LOSS_PCT,
    maxPositionCount: config.MAX_POSITION_COUNT,
    killSwitchDrawdownPct: config.KILL_SWITCH_DRAWDOWN_PCT,
    cacheGet: redisHealthy ? cacheGet : null,  // C2: Redis persistence
    cacheSet: redisHealthy ? cacheSet : null,
  });

  // C2: Restore daily state from Redis (survives restarts)
  if (redisHealthy) {
    await riskManager.loadFromRedis();
  }
  log.info('✅ Risk manager initialized');

  // ─── Initialize Strategies ─────────────────────────────
  const consensus = new SignalConsensus({ minAgreement: 2 });
  consensus.addStrategy(new EMACrossoverStrategy());
  consensus.addStrategy(new RSIMeanReversionStrategy());
  consensus.addStrategy(new VWAPMomentumStrategy());
  consensus.addStrategy(new BreakoutVolumeStrategy());
  log.info(`✅ Signal consensus: ${consensus.strategies.length} strategies loaded`);

  // ─── Initialize Execution Engine ───────────────────────
  const engine = new ExecutionEngine({
    riskManager,
    killSwitch,
    consensus,
    broker,
    paperMode: !config.LIVE_TRADING || !broker,
  });

  const engineInit = await engine.initialize();
  log.info({ ready: engineInit.ready, paperMode: !config.LIVE_TRADING || !broker },
    '✅ Execution engine initialized');

  // ─── Initialize Telegram Bot ───────────────────────────
  const telegram = new TelegramBot({
    token: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
  });
  telegramRef = telegram; // Wire deferred reference for kill switch notifications

  if (telegram.enabled) {
    log.info('✅ Telegram bot initialized');
    telegram.sendRaw(
      `🚀 <b>Quant8 Started</b>\n` +
      `📊 Mode: ${config.LIVE_TRADING ? '🔴 LIVE' : '🟢 PAPER'}\n` +
      `🔌 Broker: ${broker ? '✅ Connected' : '❌ Not connected'}\n` +
      `📈 Strategies: ${consensus.strategies.length}\n` +
      `📋 Watchlist: ${config.WATCHLIST}\n` +
      `💰 Capital: ₹${config.TRADING_CAPITAL.toLocaleString('en-IN')}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(err => log.error({ err: err.message }, 'Failed to send Telegram startup message'));
  } else {
    log.warn('⚠️  Telegram bot disabled — missing token or chatId');
  }

  // ─── Parse Watchlist ───────────────────────────────────
  const watchlistSymbols = config.WATCHLIST
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);

  log.info({ symbols: watchlistSymbols }, `📋 Watchlist: ${watchlistSymbols.length} symbols`);

  // Resolve symbols to instrument tokens (if instrument manager loaded)
  let watchlistTokens = {};
  if (instrumentManager) {
    const resolved = instrumentManager.resolveSymbols(watchlistSymbols);
    watchlistTokens = resolved.symbolMap;
    log.info({ tokens: resolved.tokens.length }, '✅ Watchlist tokens resolved');

    // Update tick feed's symbol map
    if (tickFeed) {
      tickFeed.symbolMap = resolved.symbolMap;
    }
  }

  // ─── Watchlist Provider (for MarketScheduler) ──────────
  async function getWatchlist() {
    const items = [];

    for (const symbol of watchlistSymbols) {
      try {
        // Get instrument token
        const instrumentToken = instrumentManager?.getToken(symbol);

        // Get current price (from tick feed or broker LTP)
        let currentPrice = 0;
        if (tickFeed && instrumentToken) {
          const tick = tickFeed.getLatestTick(instrumentToken);
          if (tick) currentPrice = tick.lastPrice || tick.close || 0;
        }

        if (!currentPrice && broker) {
          try {
            const ltp = await broker.getLTP([`NSE:${symbol}`]);
            currentPrice = ltp?.[`NSE:${symbol}`]?.last_price || 0;
          } catch { /* skip */ }
        }

        // Fetch recent candles for strategy analysis
        let candles = [];
        if (broker && instrumentToken) {
          try {
            candles = await fetchRecentCandles({
              broker,
              instrumentToken,
              symbol,
              interval: '5minute',
              count: 50,
            });
          } catch { /* skip — strategies will get empty candles */ }
        }

        // Calculate position size using Kelly Criterion
        const sizing = calculatePositionSize({
          capital: config.TRADING_CAPITAL,
          winRate: 0.5,     // Default — will improve with real trade history
          avgWin: 1000,
          avgLoss: 500,
          entryPrice: currentPrice || 100,
          maxRiskPct: config.PER_TRADE_STOP_LOSS_PCT,
        });

        items.push({
          symbol,
          instrumentToken,
          candles,
          price: currentPrice,
          quantity: sizing.quantity || 1,
        });
      } catch (err) {
        log.warn({ symbol, err: err.message }, 'Failed to build watchlist item');
      }
    }

    return items;
  }

  // ─── Open Positions Provider ───────────────────────────
  async function getOpenPositions() {
    if (!broker) return [];
    try {
      const positions = await broker.getPositions();
      return (positions?.net || positions || []).filter(
        (p) => (p.quantity || p.netQuantity || 0) !== 0
      );
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to fetch open positions');
      return [];
    }
  }

  // ─── Health Check Provider ─────────────────────
  async function healthCheck() {
    let dbOk = false;
    let redisOk = false;
    let brokerOk = false;

    try { dbOk = await checkDatabaseHealth(); } catch { /* */ }
    try { redisOk = await checkRedisHealth(); } catch { /* */ }
    try { brokerOk = broker ? await broker.isConnected() : false; } catch { /* */ }

    return { broker: brokerOk, redis: redisOk, db: dbOk };
  }

  // ─── Daily Report Provider ─────────────────────────────
  async function sendReport(summary) {
    if (!telegram.enabled) return;
    const msg =
      `📊 <b>Quant8 Daily Report</b>\n` +
      `${summary.mode === 'PAPER' ? '🟢 Paper' : '🔴 Live'} Trading\n\n` +
      `💰 PnL: ₹${(summary.pnl || 0).toLocaleString('en-IN')}\n` +
      `📈 Trades: ${summary.trades || 0}\n` +
      `✅ Wins: ${summary.wins || 0}\n` +
      `❌ Losses: ${summary.losses || 0}\n` +
      `🔘 Open: ${summary.openPositions || 0}\n\n` +
      `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;
    await telegram.sendRaw(msg);
  }

  // ─── Initialize Market Scheduler ───────────────────────
  const scheduler = new MarketScheduler({
    killSwitch,
    riskManager,
    engine,
    broker,
    dataFeed: tickFeed,
    getWatchlist,
    getOpenPositions,
    sendReport,
    healthCheck,
  });

  scheduler.start();
  log.info('✅ Market scheduler started (6 daily jobs registered)');

  registerShutdown('scheduler', async () => {
    scheduler.stop();
    log.info('Market scheduler stopped');
  });

  // ─── Emergency Square-Off on Shutdown ───────────────
  registerShutdown('emergency-squareoff', async () => {
    if (!broker) return;
    try {
      const positions = await getOpenPositions();
      if (positions.length > 0) {
        log.warn({ count: positions.length }, '⚠️ Emergency square-off: closing open positions before shutdown');
        const { executeSquareOff } = await import('./risk/square-off-job.js');
        // Force square-off regardless of time check
        const result = await executeSquareOff({ broker, riskManager, getOpenPositions, force: true });
        log.warn({ squaredOff: result.squaredOff, errors: result.errors.length },
          'Emergency square-off result');
        if (telegram.enabled) {
          telegram.sendRaw(
            `⚠️ <b>Emergency Shutdown</b>\nClosed ${result.squaredOff} position(s)\n` +
            `Errors: ${result.errors.length}\n` +
            `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
          );
        }
      }
    } catch (err) {
      log.error({ err: err.message }, 'Emergency square-off failed');
    }
  });

  // ─── Subscribe Tick Feed to Watchlist ──────────────────
  if (tickFeed && instrumentManager) {
    const resolved = instrumentManager.resolveSymbols(watchlistSymbols);
    if (resolved.tokens.length > 0) {
      tickFeed.subscribe(resolved.tokens, 'full');
      log.info({ tokens: resolved.tokens.length }, '✅ Tick feed subscribed to watchlist');
    }

    registerShutdown('tick-feed', async () => {
      tickFeed.stop();
      log.info('Tick feed stopped');
    });
  }

  // ─── Schedule Auto-Login Cron (8:00 AM IST) ────────────
  try {
    const { default: cron } = await import('node-cron');

    cron.schedule('0 8 * * 1-5', async () => {
      log.info('🔐 Running scheduled auto-login...');
      try {
        const { exec } = await import('node:child_process');
        const { promisify } = await import('node:util');
        const execAsync = promisify(exec);

        const { stdout, stderr } = await execAsync('node scripts/auto-login.js', {
          cwd: process.cwd(),
          timeout: 120000,
          env: process.env,
        });
        if (stdout) log.info({ stdout: stdout.slice(-500) }, 'Auto-login output');
        if (stderr) log.warn({ stderr: stderr.slice(-500) }, 'Auto-login stderr');

        // Refresh broker token
        const newToken = await getRedis().get('kite:access_token');
        if (newToken && broker) {
          broker.primary.setAccessToken(newToken);
          log.info('✅ Broker access token refreshed');
        } else if (newToken && !broker) {
          try {
            const kiteClient = new KiteClient({
              apiKey: config.KITE_API_KEY,
              apiSecret: config.KITE_API_SECRET,
              accessToken: newToken,
            });
            broker = new BrokerManager(kiteClient);
            engine.broker = broker;
            engine.paperMode = !config.LIVE_TRADING;
            scheduler.broker = broker;
            log.info('✅ Broker initialized from scheduled auto-login');
          } catch (initErr) {
            log.error({ err: initErr.message }, 'Failed to init broker after login');
          }
        }
      } catch (err) {
        log.error({ err: err.message }, '❌ Scheduled auto-login failed');
        if (telegram.enabled) {
          telegram.sendRaw(
            `🛑 <b>Scheduled Login Failed</b>\n❌ ${err.message}\n` +
            `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
          );
        }
      }
    }, { timezone: 'Asia/Kolkata' });

    log.info('⏰ Auto-login cron: 8:00 AM IST (Mon-Fri)');
  } catch (err) {
    log.warn({ err: err.message }, '⚠️  Cron scheduler not available');
  }

  // ─── Start REST API Server ─────────────────────────────
  const { createServer } = await import('node:http');
  const apiHandler = createApiHandler({
    killSwitch,
    riskManager,
    engine,
    config,
    broker,
    telegram,
  });

  const apiServer = createServer(apiHandler);

  apiServer.on('error', (err) => {
    log.error({ err }, 'API Server error (port in use?)');
    if (err.code === 'EADDRINUSE') {
      log.fatal(`Port ${config.PORT} is already in use. Please stop the conflicting process.`);
      process.exit(1);
    }
  });

  apiServer.listen(config.PORT, () => {
    log.info({ port: config.PORT }, `🌐 API server: http://localhost:${config.PORT}`);
  });

  registerShutdown('api-server', async () => {
    apiServer.close();
    log.info('API server closed');
  });

  // ─── Ready ─────────────────────────────────────────────
  log.info('');
  log.info('═══════════════════════════════════════════════════');
  log.info('  🎯 Quant8 initialized successfully');
  log.info(`  📡 API: http://localhost:${config.PORT}`);
  log.info(`  📊 Mode: ${config.LIVE_TRADING && broker ? 'LIVE' : 'PAPER'}`);
  log.info(`  🔌 Broker: ${broker ? 'Connected' : 'Not connected (run: npm run login)'}`);
  log.info(`  📈 Strategies: ${consensus.strategies.length}`);
  log.info(`  📋 Watchlist: ${watchlistSymbols.join(', ')}`);
  log.info(`  ⏰ Scheduler: 6 jobs (9:00-15:35 IST)`);
  log.info(`  🔐 Auto-login: 8:00 AM IST daily`);
  log.info('═══════════════════════════════════════════════════');
}

// ─── Run ─────────────────────────────────────────────────
main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});
