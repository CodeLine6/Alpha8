import { config } from './config/env.js';
import { TIMEZONE, MARKET_HOLIDAYS_YEAR } from './config/constants.js';
import { createLogger } from './lib/logger.js';
import { initShutdownHandlers, registerShutdown } from './lib/shutdown.js';
import { initDatabase, checkDatabaseHealth, query } from './lib/db.js';
import { initRedis, checkRedisHealth, cacheGet, cacheSet, getRedis } from './lib/redis.js';
import axios from 'axios';
import { KillSwitch } from './risk/kill-switch.js';
import { RiskManager } from './risk/risk-manager.js';
import { calculatePositionSize } from './risk/position-sizer.js';
import { ExecutionEngine } from './engine/execution-engine.js';
import { SignalConsensus } from './engine/signal-consensus.js';
import { KiteClient } from './api/kite-client.js';
import { BrokerManager } from './api/broker-manager.js';
import { TelegramBot } from './notifications/index.js';
import { MarketScheduler } from './scheduler/index.js';
import { TickFeed, InstrumentManager, fetchHistoricalData, fetchRecentCandles } from './data/index.js';
import {
  EMACrossoverStrategy,
  RSIMeanReversionStrategy,
  VWAPMomentumStrategy,
  BreakoutVolumeStrategy,
} from './strategies/index.js';
import { createApiHandler } from './api/backend-api.js';
import { EnhancedSignalPipeline } from './intelligence/enhanced-pipeline.js';
import { SymbolScout } from './intelligence/symbol-scout.js';
import { ShadowRecorder } from './intelligence/shadow-recorder.js';
import { PositionStats } from './risk/position-stats.js';
import { HoldingsManager } from './data/holdings.js';
import { IntradayDecayManager } from './intelligence/intraday-decay.js';
import { PositionManager } from './risk/position-manager.js';

const log = createLogger('main');
const APP_VERSION = '1.0.0';

// Nifty 50 instrument token on Kite Connect (NSE index)
const NIFTY50_INSTRUMENT_TOKEN = 256265;

/**
 * Alpha8 — Automated Stock Trading Application
 * Entry point: initializes all services, wires the trading pipeline,
 * and starts the market-day scheduler.
 */
async function main() {
  // ─── Startup Banner ────────────────────────────────────
  log.info('═══════════════════════════════════════════════════');
  log.info(`  🚀 Alpha8 v${APP_VERSION}`);
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

  // ─── Initialize PositionStats (Feature 4) ─────────────
  const positionStats = redisHealthy ? new PositionStats({ redis: getRedis() }) : null;
  if (positionStats) {
    log.info('✅ Position stats initialized (Kelly inputs from signal_outcomes)');
  } else {
    log.warn('⚠️  Position stats disabled — Redis not available (using fixed Kelly inputs)');
  }

  // ─── Initialize Intraday Decay (Feature 7) ────────────
  const intradayDecay = redisHealthy ? new IntradayDecayManager({ redis: getRedis() }) : null;
  if (intradayDecay) {
    log.info('✅ Intraday decay initialized — strategy weights decay on repeated wrong signals');
  } else {
    log.warn('⚠️  Intraday decay disabled — Redis not available (Sunday weights used as-is)');
  }

  // ─── Holiday Year Validation ────────────────────────────
  const currentYear = new Date().getFullYear();
  if (MARKET_HOLIDAYS_YEAR !== currentYear) {
    log.warn({
      holidayYear: MARKET_HOLIDAYS_YEAR, currentYear,
    }, `⚠️  MARKET_HOLIDAYS is for ${MARKET_HOLIDAYS_YEAR} but current year is ${currentYear}! Update constants.js`);
  }

  // ─── Initialize Kill Switch ────────────────────────────
  let telegramRef = null;

  const killSwitch = new KillSwitch({
    cacheGet: redisHealthy ? cacheGet : async () => null,
    cacheSet: redisHealthy ? cacheSet : async () => { },
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

  // ─── Initialize Broker ────────────────────────────────
  let broker = null;
  let kiteClient = null;
  let accessToken = null;

  try {
    if (redisHealthy) {
      accessToken = await getRedis().get('kite:access_token');
    }

    if (accessToken && config.KITE_API_KEY && config.KITE_API_KEY !== 'dev_placeholder') {
      kiteClient = new KiteClient({
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
        kiteClient = null;
      }
    } else if (!accessToken) {
      log.warn('⚠️  No Kite access token in Redis — run: npm run login');
    } else {
      log.warn('⚠️  Kite API key is placeholder — broker not initialized');
    }
  } catch (err) {
    log.warn({ err: err.message }, '⚠️  Broker initialization failed');
  }

  // ─── Initialize Holdings Manager (Feature 5) ──────────
  const holdingsManager = broker
    ? new HoldingsManager({ broker, redis: getRedis(), capital: config.TRADING_CAPITAL })
    : null;
  if (holdingsManager) {
    log.info('✅ Holdings manager initialized');
  } else {
    log.warn('⚠️  Holdings manager disabled — no broker');
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
        ohlcvIntervalMs: 60000,
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
    cacheGet: redisHealthy ? cacheGet : null,
    cacheSet: redisHealthy ? cacheSet : null,
  });

  if (redisHealthy) {
    await riskManager.loadFromRedis();
  }
  log.info('✅ Risk manager initialized');

  // ─── Initialize Strategies + Consensus ─────────────────
  const consensus = new SignalConsensus({ minAgreement: 2 });
  consensus.addStrategy(new EMACrossoverStrategy());
  consensus.addStrategy(new RSIMeanReversionStrategy());
  consensus.addStrategy(new VWAPMomentumStrategy());
  consensus.addStrategy(new BreakoutVolumeStrategy());
  log.info(`✅ Signal consensus: ${consensus.strategies.length} strategies loaded`);

  // ─── Initialize Enhanced Signal Pipeline ───────────────
  let pipeline = null;
  if (redisHealthy) {
    pipeline = new EnhancedSignalPipeline({
      redis: getRedis(),
      broker,
      instrumentManager,
      anthropicApiKey: config.ANTHROPIC_API_KEY || null,
      trendEnabled: true,
      regimeEnabled: true,
      adaptiveEnabled: dbHealthy,
      newsEnabled: !!config.ANTHROPIC_API_KEY,
      intradayDecay,  // Feature 7: applies intraday decay before weightedConsensus
    });
    log.info({
      trend: true,
      regime: true,
      adaptive: dbHealthy,
      news: !!config.ANTHROPIC_API_KEY,
    }, '✅ Enhanced signal pipeline initialized');
  } else {
    log.warn('⚠️  Enhanced pipeline disabled — Redis not available');
  }

  // ─── Initialize Shadow Recorder ───────────────────────
  let shadowRecorder = null;
  if (dbHealthy) {
    shadowRecorder = new ShadowRecorder({ broker, intradayDecay });  // Feature 7: recordWrong() on 30min miss
    log.info('✅ Shadow recorder initialized');
  } else {
    log.warn('⚠️  Shadow recorder disabled — DB not available');
  }

  // ─── Initialize Telegram Bot ───────────────────────────
  const telegram = new TelegramBot({
    token: config.TELEGRAM_BOT_TOKEN,
    chatId: config.TELEGRAM_CHAT_ID,
  });
  telegramRef = telegram;

  // ─── Initialize Execution Engine ───────────────────────
  const engine = new ExecutionEngine({
    riskManager,
    killSwitch,
    consensus,
    pipeline,
    broker,
    paperMode: !config.LIVE_TRADING || !broker,
    shadowRecorder,
    holdingsManager,  // Feature 5: proactive exposure check
    telegram: telegramRef,  // Feature 9: conflict detection alerts
    redis: redisHealthy ? getRedis() : null,  // Feature 9: conflict rate limit
    config,           // Position manager: STOP_LOSS_PCT, TRAILING_STOP_PCT
  });

  if (telegramRef?.enabled && redisHealthy) {
    log.info('✅ Conflict detection active — Telegram alerts enabled');
  } else {
    log.warn('⚠️  Conflict detection disabled — requires Telegram + Redis');
  }

  const engineInit = await engine.initialize();
  log.info({ ready: engineInit.ready, paperMode: !config.LIVE_TRADING || !broker },
    '✅ Execution engine initialized');

  // ─── Bug Fix 2 & 3: Hydrate position state from DB ───────────────────────
  // Must complete before scheduler.start() so the engine knows what it owns
  // after a Render redeploy or mid-day restart.
  //
  // Throws if DB is unreachable — we do NOT proceed with empty position state
  // because that would allow phantom SELLs on symbols we actually hold.
  if (dbHealthy) {
    try {
      const hydratedCount = await engine.hydratePositions();

      // Bug Fix 3: Override Redis-restored openPositionCount with the
      // authoritative count from _filledPositions (DB-backed, not Redis).
      riskManager.syncPositionCount(hydratedCount);

      // Bug Fix 3: Override tradeCount=0 with the real count from today's trades.
      await riskManager.loadTradeCountFromDB(query);

      log.info({ positions: hydratedCount }, '✅ Position state hydrated and risk manager synced');
    } catch (err) {
      // DB unreachable during hydration — this is fatal. Do NOT start the scheduler
      // with empty position state as phantom SELLs would execute.
      log.fatal({ err: err.message },
        '❌ FATAL: Position hydration failed — scheduler will NOT start. Fix DB connectivity and restart.');
      process.exit(1);
    }
  } else {
    log.warn(
      '⚠️  DB unavailable — position hydration skipped. ' +
      'SELL guard is disabled for this session. Restart with DB connectivity to re-enable.'
    );
  }

  // ─── Initialize Position Manager ───────────────────────
  // Must be initialized AFTER engine.hydratePositions() because it references
  // engine._filledPositions directly. Requires broker for LTP price fetching.
  const positionManager = config.POSITION_MGMT_ENABLED
    ? new PositionManager({ engine, broker, config })
    : null;

  if (positionManager) {
    log.info({
      stopLossPct: config.STOP_LOSS_PCT,
      trailingStopPct: config.TRAILING_STOP_PCT,
      maxHoldMinutes: config.MAX_HOLD_MINUTES,
    },
      `✅ Position manager: Active\n` +
      `   Stop loss:      ${config.STOP_LOSS_PCT}% below entry\n` +
      `   Trailing stop:  ${config.TRAILING_STOP_PCT}% below peak\n` +
      `   Max hold:       ${config.MAX_HOLD_MINUTES} minutes (flat/losing positions only)`
    );
  } else {
    log.warn('⚠️  Position manager: DISABLED (POSITION_MGMT_ENABLED=false)');
  }


  if (telegram.enabled) {
    log.info('✅ Telegram bot initialized');

    // Start polling for secure remote commands
    telegram.startPolling();

    telegram.onCommand('/reset_kill_switch', async () => {
      log.warn('Received remote kill switch reset via Telegram');
      if (killSwitch.isEngaged()) {
        await killSwitch.reset('CONFIRM_RESET');
        telegram.sendRaw('✅ <b>Kill Switch Reset</b>\nTrading may resume.');
      } else {
        telegram.sendRaw('ℹ️ <b>Kill Switch</b> is not currently engaged.');
      }
    });
  } else {
    log.warn('⚠️  Telegram bot disabled — missing token or chatId');
  }

  // ─── Parse Pinned (config) Watchlist ───────────────────
  // These symbols are always traded regardless of scout scores.
  const pinnedSymbols = config.WATCHLIST
    .split(',')
    .map(s => s.trim())
    .filter(Boolean);

  log.info({ symbols: pinnedSymbols }, `📌 Pinned watchlist: ${pinnedSymbols.length} symbols`);

  // ─── Initialize Symbol Scout ───────────────────────────
  // Requires DB (reads/writes settings + symbol_scores tables).
  let scout = null;
  if (dbHealthy) {
    scout = new SymbolScout({
      broker,
      telegram,
      pinnedSymbols,
      maxDynamic: config.SCOUT_MAX_DYNAMIC ?? 10,
      excludeSymbols: config.SCOUT_EXCLUDE_SYMBOLS
        ? config.SCOUT_EXCLUDE_SYMBOLS.split(',').map(s => s.trim()).filter(Boolean)
        : [],
    });
    log.info({
      pinned: pinnedSymbols.length,
      maxDynamic: config.SCOUT_MAX_DYNAMIC ?? 10,
    }, '✅ Symbol scout initialized');

    // Register Telegram command to trigger scouting on demand
    if (telegram.enabled) {
      telegram.onCommand('/scout', async () => {
        log.info('Manual scout triggered via Telegram');

        if (!scout) {
          telegram.sendRaw('⚠️ <b>Scout not available</b>\nDB is offline — symbol scout requires database connectivity.');
          return;
        }

        telegram.sendRaw(
          `🔍 <b>Symbol Scout Starting</b>\n` +
          `Scanning ${pinnedSymbols.length > 0 ? `~85 symbols` : 'NSE universe'}...\n` +
          `<i>This takes ~30–60 seconds. Results will follow automatically.</i>`
        );

        scout.runNightly().catch(err => {
          log.error({ err: err.message }, 'Manual scout run failed');
          telegram.sendRaw(`❌ <b>Scout failed</b>\n${err.message}`);
        });
      });

      telegram.onCommand('/watchlist', async () => {
        try {
          const active = scout
            ? await scout.getActiveWatchlist()
            : [...pinnedSymbols];

          const pinned = active.filter(s => pinnedSymbols.includes(s));
          const dynamic = active.filter(s => !pinnedSymbols.includes(s));

          let msg = `📋 <b>Active Watchlist (${active.length} symbols)</b>\n\n`;
          msg += `📌 <b>Pinned (${pinned.length}):</b> ${pinned.join(', ') || '—'}\n`;
          msg += `🤖 <b>Dynamic (${dynamic.length}):</b> ${dynamic.join(', ') || '—'}\n`;
          msg += `\n<i>Run /scout to refresh the dynamic list.</i>`;

          telegram.sendRaw(msg);
        } catch (err) {
          telegram.sendRaw(`❌ <b>Watchlist error</b>\n${err.message}`);
        }
      });

      log.info('✅ Telegram /scout and /watchlist commands registered');
    }
  } else {
    log.warn('⚠️  Symbol scout disabled — DB not available (falling back to pinned watchlist only)');
  }


  // ─── Resolve Instrument Tokens ─────────────────────────
  // Pre-resolve for pinned symbols. Dynamic symbols are resolved lazily
  // inside getWatchlist() each scan cycle.
  let watchlistTokens = {};
  if (instrumentManager && pinnedSymbols.length > 0) {
    const resolved = instrumentManager.resolveSymbols(pinnedSymbols);
    watchlistTokens = resolved.symbolMap;
    log.info({ tokens: resolved.tokens.length }, '✅ Pinned watchlist tokens resolved');

    if (tickFeed) {
      tickFeed.symbolMap = resolved.symbolMap;
    }
  }

  // ─── Resubscribe Tick Feed After Watchlist Change ──────
  async function resubscribeTickFeed(symbols) {
    if (!tickFeed || !instrumentManager) return;
    try {
      const resolved = instrumentManager.resolveSymbols(symbols);
      tickFeed.symbolMap = resolved.symbolMap;
      if (resolved.tokens.length > 0) {
        tickFeed.subscribe(resolved.tokens, 'full');
        log.info({ tokens: resolved.tokens.length }, 'Tick feed resubscribed');
      }
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to resubscribe tick feed');
    }
  }

  // ─── Watchlist Provider ────────────────────────────────
  // Returns the current active watchlist = pinned + dynamic (from scout).
  // Called every scan cycle — always reflects the latest state.
  async function getWatchlist() {
    // Get active symbols: scout manages dynamic list, falls back to pinned only
    let activeSymbols;
    if (scout) {
      activeSymbols = await scout.getActiveWatchlist();
    } else {
      activeSymbols = pinnedSymbols;
    }

    const items = [];

    // Bug Fix 6: Batch query for all position stats outside the loop 
    // to avoid N sequential queries and heavily reduce DB latency on scans
    const statsMap = positionStats ? await positionStats.getStatsBatch(activeSymbols) : null;

    for (const symbol of activeSymbols) {
      try {
        const instrumentToken = instrumentManager?.getToken(symbol)
          ?? watchlistTokens[symbol]
          ?? null;

        let currentPrice = 0;
        if (tickFeed && instrumentToken) {
          const tick = tickFeed.getLatestTick(instrumentToken);
          if (tick) currentPrice = tick.lastPrice || tick.close || 0;
        }

        if (!currentPrice && broker) {
          try {
            const ltp = await broker.getLTP([`NSE:${symbol}`]);
            currentPrice = ltp?.[`NSE:${symbol}`]?.last_price || 0;
          } catch (ltpErr) {
            log.warn({ symbol, err: ltpErr.message }, 'LTP fetch failed — price unresolvable this cycle');
          }
        }

        // Task 4: Skip symbol if price cannot be determined.
        // A zero price would create orders with price=0 in the DB, which is misleading
        // and causes incorrect P&L calculations. Skip and retry next scan cycle.
        if (!currentPrice || currentPrice <= 0) {
          log.warn({ symbol }, 'Skipping symbol — could not resolve current price');
          continue;
        }

        let candles = [];
        if (broker && instrumentToken) {
          try {
            candles = await fetchRecentCandles({
              broker, instrumentToken, symbol,
              interval: '5minute', count: 100,
            });
          } catch (candleErr) {
            log.warn({ symbol, err: candleErr.message }, 'Candle fetch failed — strategy will receive empty candles');
          }
        }

        // Feature 4: Use real historical win-rate / avg P&L from signal_outcomes
        // instead of fixed defaults. Falls back to defaults if sample size < 10.
        const stats = statsMap?.get(symbol) ?? { winRate: 0.5, avgWin: 1000, avgLoss: 500 };

        const sizing = calculatePositionSize({
          capital: config.TRADING_CAPITAL,
          winRate: stats.winRate,
          avgWin: stats.avgWin,
          avgLoss: stats.avgLoss,
          entryPrice: currentPrice || 100,
          maxRiskPct: config.PER_TRADE_STOP_LOSS_PCT,
        });

        log.debug({
          symbol,
          winRate: stats.winRate,
          avgWin: stats.avgWin,
          avgLoss: stats.avgLoss,
          usingDefaults: stats.usingDefaults,
          sampleSize: stats.sampleSize,
          quantity: sizing.quantity,
        }, 'Position sizing (Kelly inputs)');

        items.push({ symbol, instrumentToken, candles, price: currentPrice, quantity: sizing.quantity || 1 });
      } catch (err) {
        log.warn({ symbol, err: err.message }, 'Failed to build watchlist item');
      }
    }

    return items;
  }

  // ─── Nifty 50 Daily Candles Provider ───────────────────
  async function getNiftyCandles() {
    if (!broker) return [];

    try {
      const to = new Date();
      const from = new Date();
      from.setDate(from.getDate() - 70);

      const fmt = d => d.toISOString().split('T')[0];

      const candles = await fetchHistoricalData({
        broker,
        instrumentToken: NIFTY50_INSTRUMENT_TOKEN,
        symbol: 'NIFTY 50',
        interval: 'day',
        from: fmt(from),
        to: fmt(to),
        cacheTTL: 6 * 3600,
      });

      log.info({ candles: candles.length }, 'Nifty 50 daily candles fetched for regime detector');
      return candles;
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to fetch Nifty 50 candles — regime detector will use cached data');
      return [];
    }
  }

  // ─── Open Positions Provider ───────────────────────────
  async function getOpenPositions() {
    if (!config.LIVE_TRADING) {
      // In PAPER mode, the broker doesn't know about our trades.
      // We must get them from the Execution Engine's memory.
      if (!engine || !engine._filledPositions) return [];

      const positions = [];
      for (const [symbol, posCtx] of engine._filledPositions.entries()) {
        positions.push({
          symbol: symbol,
          tradingsymbol: symbol,
          quantity: posCtx.quantity,
          average_price: posCtx.entryPrice,
        });
      }
      return positions;
    }

    // In LIVE mode, ALWAYS ask the broker for the absolute ground truth.
    if (!broker) return [];
    try {
      const positions = await broker.getPositions();
      return (positions?.net || positions || []).filter(
        p => (p.quantity || p.netQuantity || 0) !== 0
      );
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to fetch open positions');
      return [];
    }
  }

  // ─── Health Check Provider ─────────────────────────────
  async function healthCheck() {
    let dbOk = false, redisOk = false, brokerOk = false;
    try { dbOk = await checkDatabaseHealth(); } catch { /* */ }
    try { redisOk = await checkRedisHealth(); } catch { /* */ }
    try { brokerOk = broker ? await broker.isConnected() : false; } catch { /* */ }
    return { broker: brokerOk, redis: redisOk, db: dbOk };
  }

  // ─── Daily Report Provider ─────────────────────────────
  async function sendReport(summary) {
    if (!telegram.enabled) return;

    // Build watchlist change summary for report
    let watchlistLine = '';
    if (scout) {
      try {
        const active = await scout.getActiveWatchlist();
        const dynamic = active.filter(s => !pinnedSymbols.includes(s));
        watchlistLine = dynamic.length > 0
          ? `\n🔍 Scout Watchlist: ${dynamic.join(', ')}`
          : '';
      } catch { /* */ }
    }

    const msg =
      `📊 <b>Alpha8 Daily Report</b>\n` +
      `${summary.mode === 'PAPER' ? '🟢 Paper' : '🔴 Live'} Trading\n\n` +
      `💰 PnL: ₹${(summary.pnl || 0).toLocaleString('en-IN')}\n` +
      `📈 Trades: ${summary.trades || 0}\n` +
      `✅ Wins: ${summary.wins || 0}\n` +
      `❌ Losses: ${summary.losses || 0}\n` +
      `🔘 Open: ${summary.openPositions || 0}` +
      watchlistLine +
      `\n\n🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

    await telegram.sendRaw(msg);
  }

  // ─── Initialize Market Scheduler ───────────────────────
  const scheduler = new MarketScheduler({
    killSwitch,
    riskManager,
    engine,
    pipeline,
    scout,             // ← NEW: passes scout for nightly job
    shadowRecorder,
    intradayDecay,     // Feature 7: resetDay() at market open
    positionManager,   // Position management: stop/trail/time exits before each scan
    broker,
    dataFeed: tickFeed,
    getWatchlist,
    getNiftyCandles,
    getOpenPositions,
    sendReport,
    healthCheck,
  });

  scheduler.start();
  log.info('✅ Market scheduler started (8 daily jobs registered)');

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
        const result = await executeSquareOff({ broker, riskManager, engine, getOpenPositions, force: true });
        log.warn({ squaredOff: result.squaredOff, errors: result.errors.length }, 'Emergency square-off result');
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

  // ─── Subscribe Tick Feed to Pinned Watchlist ───────────
  if (tickFeed && instrumentManager) {
    const resolved = instrumentManager.resolveSymbols(pinnedSymbols);
    if (resolved.tokens.length > 0) {
      tickFeed.subscribe(resolved.tokens, 'full');
      log.info({ tokens: resolved.tokens.length }, '✅ Tick feed subscribed to pinned watchlist');
    }

    registerShutdown('tick-feed', async () => {
      tickFeed.stop();
      log.info('Tick feed stopped');
    });
  }

  // ─── Schedule Auto-Login Cron (8:00 AM IST) ────────────
  try {
    const { default: cron } = await import('node-cron');

    // ─── Keep-Awake Cron (Every 10 mins) ───────────────────
    cron.schedule('*/5 * * * *', async () => {
      const url = process.env.RENDER_EXTERNAL_URL || `http://localhost:${config.PORT}`;
      const pingUrl = url.endsWith('/') ? `${url}health` : `${url}/health`;
      log.info(`🔌 Pinging service to keep awake: ${pingUrl}`);
      try {
        await axios.get(pingUrl);
      } catch (err) {
        log.warn({ err: err.message }, '⚠️  Keep-awake ping failed');
      }
    });

    cron.schedule('0 8 * * 1-5', async () => {
      log.info('🔐 Running scheduled auto-login...');
      try {
        const { runAutoLogin } = await import('../scripts/auto-login.js');
        const loginResult = await runAutoLogin({ silent: false });

        if (loginResult.success && loginResult.accessToken) {
          const newToken = loginResult.accessToken;
          if (broker) {
            broker.primary.setAccessToken(newToken);
            log.info('✅ Broker access token refreshed');
          } else {
            try {
              kiteClient = new KiteClient({
                apiKey: config.KITE_API_KEY,
                apiSecret: config.KITE_API_SECRET,
                accessToken: newToken,
              });
              broker = new BrokerManager(kiteClient);
              engine.broker = broker;
              engine.paperMode = !config.LIVE_TRADING;
              scheduler.broker = broker;
              if (scout) scout.broker = broker;   // ← give scout live broker too
              log.info('✅ Broker initialized from scheduled auto-login');
            } catch (initErr) {
              log.error({ err: initErr.message }, 'Failed to init broker after login');
            }
          }
        } else {
          throw new Error(loginResult.error || 'Token not returned');
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
    killSwitch, riskManager, engine, config, broker, telegram, scout, holdingsManager,
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

  // ─── Send Startup Telegram ────────────────────────────
  if (telegram.enabled) {
    let activeWatchlist = pinnedSymbols;
    if (scout) {
      try { activeWatchlist = await scout.getActiveWatchlist(); } catch { /* */ }
    }

    telegram.sendRaw(
      `🚀 <b>Alpha8 Started</b>\n` +
      `📊 Mode: ${config.LIVE_TRADING ? '🔴 LIVE' : '🟢 PAPER'}\n` +
      `🔌 Broker: ${broker ? '✅ Connected' : '❌ Not connected'}\n` +
      `📈 Strategies: ${consensus.strategies.length}\n` +
      `🧠 Pipeline: ${pipeline ? '✅ Active' : '❌ Disabled'}\n` +
      `🔍 Scout: ${scout ? '✅ Active (nightly @ 8 PM)' : '❌ Disabled'}\n` +
      `📌 Pinned: ${pinnedSymbols.join(', ')}\n` +
      `📋 Active watchlist (${activeWatchlist.length}): ${activeWatchlist.join(', ')}\n` +
      `💰 Capital: ₹${config.TRADING_CAPITAL.toLocaleString('en-IN')}\n` +
      `🔬 Shadow: ${shadowRecorder ? '✅ Active' : '❌ Disabled'}\n` +
      `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`
    ).catch(err => log.error({ err: err.message }, 'Failed to send Telegram startup message'));
  }

  // ─── Ready ─────────────────────────────────────────────
  let activeWatchlist = pinnedSymbols;
  if (scout) {
    try { activeWatchlist = await scout.getActiveWatchlist(); } catch { /* */ }
  }

  log.info('');
  log.info('═══════════════════════════════════════════════════');
  log.info('  🎯 Alpha8 initialized successfully');
  log.info(`  📡 API: http://localhost:${config.PORT}`);
  log.info(`  📊 Mode: ${config.LIVE_TRADING && broker ? 'LIVE' : 'PAPER'}`);
  log.info(`  🔌 Broker: ${broker ? 'Connected' : 'Not connected (run: npm run login)'}`);
  log.info(`  📈 Strategies: ${consensus.strategies.length}`);
  log.info(`  🧠 Pipeline: ${pipeline ? 'Active (trend + regime + adaptive + news)' : 'Disabled (Redis unavailable)'}`);
  log.info(`  🔍 Scout: ${scout ? `Active — nightly scan @ 8 PM IST (${activeWatchlist.length - pinnedSymbols.length} dynamic symbols)` : 'Disabled (DB unavailable)'}`);
  log.info(`  📌 Pinned: ${pinnedSymbols.join(', ')}`);
  log.info(`  📋 Active watchlist (${activeWatchlist.length}): ${activeWatchlist.join(', ')}`);
  log.info(`  ⏰ Scheduler: 8 jobs (8:55 Sun + 9:00–15:35 IST Mon-Fri + 20:00 Mon-Fri scout)`);
  log.info(`  🔬 Shadow: ${shadowRecorder ? '✅ Active' : '❌ Disabled'}`);
  log.info(`  🔐 Auto-login: 8:00 AM IST daily`);
  log.info('═══════════════════════════════════════════════════');
}

// ─── Run ─────────────────────────────────────────────────
main().catch((err) => {
  log.fatal({ err }, 'Fatal error during startup');
  process.exit(1);
});