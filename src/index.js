import { config } from './config/env.js';
import { TIMEZONE, MARKET_HOLIDAYS_YEAR, REGIME_INTRADAY_CANDLES } from './config/constants.js';
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
  ORBStrategy,
  BAVIStrategy,
} from './strategies/index.js';
import { TickClassifier }    from './data/tick-classifier.js';
import { RollingTickBuffer } from './data/rolling-tick-buffer.js';
import { createApiHandler } from './api/backend-api.js';
import { EnhancedSignalPipeline } from './intelligence/enhanced-pipeline.js';
import { SymbolScout } from './intelligence/symbol-scout.js';
import { ShadowRecorder } from './intelligence/shadow-recorder.js';
import { PositionStats } from './risk/position-stats.js';
import { HoldingsManager } from './data/holdings.js';
import { IntradayDecayManager } from './intelligence/intraday-decay.js';
import { PositionManager } from './risk/position-manager.js';
import { getAllLiveSettings, getLiveSetting, resetLiveSetting, setLiveSetting } from './lib/settings-store.js';
import { decryptToken } from './lib/crypto-utils.js';
import { runAutoLogin } from '../scripts/auto-login.js';

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
      const raw = await getRedis().get('kite:access_token');
      accessToken = raw ? decryptToken(raw) : null;
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

  // ─── Tick Classification Singletons ────────────────────
  // TickClassifier applies Lee-Ready rule to each raw tick.
  // RollingTickBuffer stores the last 200 classified ticks per symbol.
  // Both are reset at market open each day.
  const tickClassifier = new TickClassifier();
  const rollingTickBuf = new RollingTickBuffer({ windowSize: 200 });

  // Wire tick classification into the tick feed (if available)
  if (tickFeed) {
    tickFeed.on('ticks', (ticks) => {
      for (const tick of ticks) {
        // Reverse-lookup tradingsymbol from instrument_token via tickFeed.symbolMap
        // symbolMap is { tradingsymbol: instrument_token_string }
        const token = tick.instrument_token?.toString() ?? tick.symbol;
        const symbol = tickFeed.symbolMap
          ? Object.keys(tickFeed.symbolMap).find(s => tickFeed.symbolMap[s] === token)
          : token;
        if (!symbol) continue;
        const classified = tickClassifier.classify(symbol, tick);
        rollingTickBuf.push(symbol, classified);
      }
    });
    log.info('✅ Tick classifier + rolling buffer wired into tick feed');
  }

  // ─── Initialize Risk Manager ───────────────────────────
  const riskManager = new RiskManager({
    capital: config.TRADING_CAPITAL,
    killSwitch,
    maxDailyLossPct: config.MAX_DAILY_LOSS_PCT,
    perTradeStopLossPct: config.PER_TRADE_STOP_LOSS_PCT,
    maxPositionCount: config.MAX_POSITION_COUNT,
    killSwitchDrawdownPct: config.KILL_SWITCH_DRAWDOWN_PCT,
    maxCapitalExposurePct: config.MAX_CAPITAL_EXPOSURE_PCT,
    maxPositionPct: config.MAX_POSITION_VALUE_PCT,
    cacheGet: redisHealthy ? cacheGet : null,
    cacheSet: redisHealthy ? cacheSet : null,
    getLiveSetting,
  });

  if (redisHealthy) {
    await riskManager.loadFromRedis();
  }
  log.info('✅ Risk manager initialized');

  // ─── Initialize Strategies + Consensus ─────────────────
  let superConvictionEnabled = false;
  if (redisHealthy) {
    try {
      const val = await getRedis().get('super_conviction_enabled');
      superConvictionEnabled = (val === 'true');
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to read super_conviction_enabled from Redis');
    }
  }

  const consensus = new SignalConsensus({
    minAgreement: 2,
    superConvictionEnabled,
    getLiveSetting: redisHealthy ? getLiveSetting : null
  });
  if (redisHealthy) {
    await consensus.refreshParams().catch(err => log.warn({ err: err.message }, 'Initial consensus param refresh failed'));
  }

  // ── Active consensus strategies (v1.1: ORB + BAVI replace EMA + RSI) ────────
  // EMA and RSI files are NOT deleted — they may be re-enabled later.
  // rsiStrategy is kept alive as a long-exit helper (RSI_OVERBOUGHT_EXIT).

  // Instantiate all strategies
  const orbStrategy  = new ORBStrategy({ getLiveSetting: redisHealthy ? getLiveSetting : null });
  const baviStrategy = new BAVIStrategy({ getLiveSetting: redisHealthy ? getLiveSetting : null });
  const rsiStrategy  = new RSIMeanReversionStrategy();  // exit helper only — NOT added to consensus
  // (EMACrossoverStrategy is NOT instantiated — file retained but not used)

  /**
   * BAVIAdapter wraps BAVIStrategy so the consensus engine can call it with
   * the standard analyze(candles) signature, while internally passing the
   * RollingTickBuffer and current symbol.
   *
   * IMPORTANT: baviAdapter.setSymbol(symbol) MUST be called before each
   * consensus.evaluate(candles) call. The scheduler does this in _strategyScan.
   */
  class BAVIAdapter {
    constructor(baviStrategy, tickBuffer) {
      this.name       = 'BAVI';
      this.minCandles = baviStrategy.minCandles;
      this._strategy  = baviStrategy;
      this._tickBuf   = tickBuffer;
      this._symbol    = null;
    }
    setSymbol(symbol) { this._symbol = symbol; return this; }
    analyze(candles, symbol = null)  { return this._strategy.analyze(candles, this._tickBuf, symbol || this._symbol); }
    async refreshParams() { return this._strategy.refreshParams(); }
  }
  const baviAdapter = new BAVIAdapter(baviStrategy, rollingTickBuf);

  // Register active strategies with consensus engine
  consensus.addStrategy(orbStrategy);
  consensus.addStrategy(baviAdapter);
  consensus.addStrategy(new VWAPMomentumStrategy());
  consensus.addStrategy(new BreakoutVolumeStrategy());
  log.info(`✅ Signal consensus: ${consensus.strategies.length} strategies loaded — ORB, BAVI, VWAP, Breakout (Super Conviction: ${superConvictionEnabled ? 'ON' : 'OFF'})`);
  log.info('ℹ️  RSI retained as long-exit helper (RSI_OVERBOUGHT_EXIT) — NOT in consensus voting');

  // ─── Initialize Enhanced Signal Pipeline ───────────────
  let pipeline = null;
  if (redisHealthy) {
    pipeline = new EnhancedSignalPipeline({
      redis: getRedis(),
      broker,
      instrumentManager,
      geminiApiKey: config.GEMINI_API_KEY || null,
      trendEnabled: true,
      regimeEnabled: true,
      adaptiveEnabled: dbHealthy,
      newsEnabled: !!config.GEMINI_API_KEY,
      intradayDecay,  // Feature 7: applies intraday decay before weightedConsensus
    });
    log.info({
      trend: true,
      regime: true,
      adaptive: dbHealthy,
      news: !!config.GEMINI_API_KEY,
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
    ? new PositionManager({
      engine,
      broker,
      config,
      getLiveSetting: redisHealthy ? getLiveSetting : null,  // ← add this
    })
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
    engine.positionManager = positionManager;
    engine._fetchCandles = async (symbol, limit) => {
      if (!broker) return [];
      const instrumentToken = instrumentManager?.getToken(symbol) ?? null;
      return fetchRecentCandles({
        broker,
        instrumentToken,
        symbol,
        interval: '5minute',
        count: limit,
      }).catch(() => []);
    };

  } else {
    log.warn('⚠️  Position manager: DISABLED (POSITION_MGMT_ENABLED=false)');
  }


  if (telegram.enabled) {
    log.info('✅ Telegram bot initialized');

    // Register command menu with Telegram
    telegram.setCommands([
      { command: 'status', description: 'View current system and PnL status' },
      { command: 'watchlist', description: 'View the active trading watchlist' },
      { command: 'scout', description: 'Trigger a manual symbol scout scan' },
      { command: 'login', description: 'Manually trigger Zerodha login flow' },
      { command: 'params', description: 'View current live risk parameters' },
      { command: 'set', description: 'Set a live risk parameter (e.g. /set STOP_LOSS_PCT 0.8)' },
      { command: 'reset', description: 'Reset a live parameter to default' },
      { command: 'conviction', description: 'Toggle Super Conviction Bypass (on/off)' },
      { command: 'reset_kill_switch', description: 'Reset the system kill switch' },
      { command: 'market_open', description: 'Manually trigger market-open routines' },
      { command: 'help', description: 'Show available commands' },
    ]);

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

    let _loginInProgress = false;
    telegram.onCommand('/login', async () => {
      if (_loginInProgress) {
        telegram.sendRaw('⏳ <b>Login already in progress</b>\nPlease wait for the current authentication to finish.');
        return;
      }
      _loginInProgress = true;
      log.info('Manual login triggered via Telegram');
      telegram.sendRaw('🔐 <b>Manual Login Triggered</b>\nAttempting Zerodha authentication...');

      try {
        const result = await runAutoLogin({ silent: true });
        if (result.success && result.accessToken) {
          // Update local state so the running process picks up the new token immediately
          accessToken = result.accessToken;
          kiteClient = new KiteClient({
            apiKey: config.KITE_API_KEY,
            apiSecret: config.KITE_API_SECRET,
            accessToken,
          });
          broker = new BrokerManager(kiteClient);

          // Update dependent components
          if (engine) engine.broker = broker;
          if (scout) scout.broker = broker;
          if (holdingsManager) holdingsManager.broker = broker;
          if (positionManager) positionManager.broker = broker;
          if (instrumentManager) instrumentManager.broker = broker;

          log.info('Broker and dependent components updated with new access token');
        } else if (!result.success) {
          // runAutoLogin already sends a failure alert via Telegram
          log.warn({ err: result.error }, 'Manual login failed');
        }
      } catch (err) {
        log.error({ err: err.message }, 'Manual login command failed');
        telegram.sendRaw(`❌ <b>Login command error</b>\n${err.message}`);
      } finally {
        _loginInProgress = false;
      }
    });


    telegram.onCommand('/set', async (text) => {
      // Usage: /set STOP_LOSS_PCT 0.8
      const parts = text.trim().split(/\s+/);
      if (parts.length !== 3) {
        telegram.sendRaw('Usage: <code>/set PARAM_KEY value</code>\nExample: <code>/set STOP_LOSS_PCT 0.8</code>');
        return;
      }
      const [, key, value] = parts;
      try {
        await setLiveSetting(key, value);
        telegram.sendRaw(`✅ <b>${key}</b> set to <code>${value}</code>\nTakes effect on next scan cycle.`);
      } catch (err) {
        telegram.sendRaw(`❌ Error: ${err.message}`);
      }
    });

    telegram.onCommand('/params', async () => {
      const live = await getAllLiveSettings();
      const keys = Object.keys(live);
      if (keys.length === 0) {
        telegram.sendRaw('ℹ️ No live overrides active — all params using .env defaults.');
        return;
      }
      const lines = keys.map(k => `<b>${k}</b>: <code>${live[k]}</code>`).join('\n');
      telegram.sendRaw(`📋 <b>Active Parameter Overrides</b>\n\n${lines}`);
    });

    telegram.onCommand('/reset', async (text) => {
      const key = text.replace('/reset', '').trim();
      if (!key) {
        telegram.sendRaw('Usage: <code>/reset PARAM_KEY</code>');
        return;
      }
      await resetLiveSetting(key);
      telegram.sendRaw(`✅ <b>${key}</b> reset to .env default.`);
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

        scout.runNightly()
          .then(async () => {
            telegram.sendRaw('✅ <b>Scout Complete</b>\nReconciling active symbols with data feed...');
            const active = await scout.getActiveWatchlist();
            await resubscribeTickFeed(active);
            telegram.sendRaw(`✅ <b>Reconciliation Complete</b>\nNow tracking ${active.length} active symbols.`);
          })
          .catch(err => {
            log.error({ err: err.message }, 'Manual scout run failed');
            telegram.sendRaw(`❌ <b>Scout failed</b>\n${err.message}`);
          });
      });

      telegram.onCommand('/watchlist', async () => {
        try {
          // DB-pinned = symbols saved via dashboard (settings key 'watchlist')
          let dbPinned = [];
          try {
            const r = await import('./lib/db.js').then(m => m.query(
              "SELECT value FROM settings WHERE key = 'watchlist'"
            ));
            dbPinned = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
          } catch { /* DB unavailable */ }

          // All pinned = env-var + dashboard-pinned (deduplicated)
          const allPinned = [...new Set([...pinnedSymbols, ...dbPinned])];

          const active = scout
            ? await scout.getActiveWatchlist()
            : [...allPinned];

          const pinned  = active.filter(s => allPinned.includes(s));
          const dynamic = active.filter(s => !allPinned.includes(s));

          let msg = `📋 <b>Active Watchlist (${active.length} symbols)</b>\n\n`;
          msg += `📌 <b>Pinned (${pinned.length}):</b> ${pinned.join(', ') || '—'}\n`;
          msg += `🤖 <b>Dynamic (${dynamic.length}):</b> ${dynamic.join(', ') || '—'}\n`;
          msg += `\n<i>Run /scout to refresh the dynamic list.</i>`;

          telegram.sendRaw(msg);
        } catch (err) {
          telegram.sendRaw(`❌ <b>Watchlist error</b>\n${err.message}`);
        }
      });

      telegram.onCommand('/conviction', async (text) => {
        const args = text.toLowerCase().replace('/conviction', '').trim();
        const turnOn = args === 'on';
        const turnOff = args === 'off';

        if (!turnOn && !turnOff) {
          telegram.sendRaw(`ℹ️ <b>Super Conviction Bypass is currently ${consensus.superConvictionEnabled ? 'ON' : 'OFF'}</b>\n\nUse <code>/conviction on</code> or <code>/conviction off</code> to toggle.`);
          return;
        }

        consensus.superConvictionEnabled = turnOn;
        if (redisHealthy) {
          try {
            await getRedis().set('super_conviction_enabled', turnOn ? 'true' : 'false');
          } catch (e) {
            log.warn('Could not save super conviction flag to Redis');
          }
        }

        log.info({ superConvictionEnabled: turnOn }, 'Super Conviction Bypass toggled via Telegram');
        telegram.sendRaw(`⚡ <b>Super Conviction Bypass is now ${turnOn ? 'ON' : 'OFF'}</b>\n\n${turnOn ? 'Signals with 80+ confidence will bypass cross-group consensus checks.' : 'Strict cross-group consensus logic is fully enforced.'}`);
      });

      log.info('✅ Telegram /scout, /watchlist, and /conviction commands registered');
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
      activeSymbols = [...pinnedSymbols];
    }

    // Also include DB-pinned symbols (saved via dashboard) — deduplicated.
    // These are stored under settings key 'watchlist', separate from the
    // scout's 'dynamic_watchlist'. Without this, dashboard-pinned symbols
    // are displayed but never actually scanned for signals.
    try {
      const r = await query("SELECT value FROM settings WHERE key = 'watchlist'");
      const dbPinned = r.rows[0] ? JSON.parse(r.rows[0].value) : [];
      if (dbPinned.length > 0) {
        activeSymbols = [...new Set([...activeSymbols, ...dbPinned])];
      }
    } catch { /* DB unavailable — continue with existing list */ }

    // S4 FIX: Cap watchlist size to maintain scan performance.
    // 50 symbols take ~5-7 seconds to scan. 200+ would block the event loop too long.
    const MAX_WATCHLIST_SIZE = 50;
    if (activeSymbols.length > MAX_WATCHLIST_SIZE) {
      log.warn({ count: activeSymbols.length, cap: MAX_WATCHLIST_SIZE },
        'Watchlist size exceeds limit — capping to mantain scan performance');
      activeSymbols = activeSymbols.slice(0, MAX_WATCHLIST_SIZE);
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
            currentPrice = ltp?.[`NSE:${symbol}`]?.last_price ?? 0;
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
          capital: riskManager.capital,
          winRate: stats.winRate,
          avgWin: stats.avgWin,
          avgLoss: stats.avgLoss,
          entryPrice: currentPrice || 100,
          symbol,
          maxRiskPct: riskManager.perTradeStopLossPct,
          maxPositionPct: riskManager.maxPositionPct,
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

        // L2 FIX: respect Kelly's "no trade" signal.
        if (sizing.kellyNegative) {
          log.debug({ symbol, kellyPct: sizing.kellyPct },
            'Skipping symbol — Kelly indicates negative edge');
          continue;
        }

        // S1 FIX: guard against NaN quantity.
        if (!Number.isFinite(sizing.quantity) || sizing.quantity <= 0) {
          log.debug({ symbol, quantity: sizing.quantity }, 'Skipping symbol — quantity is zero or invalid');
          continue;
        }

        const finalQuantity = sizing.quantity;

        items.push({ symbol, instrumentToken, candles, price: currentPrice, quantity: finalQuantity });
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

  // ─── Nifty 50 Intraday Candles Provider ──────────────────
  // Fetches 60 five-minute candles for Layer 2 ADX in the intraday regime detector.
  // Short cache (60 s) so each scan cycle sees a fresh slice of the session.
  async function fetchNiftyIntraday() {
    if (!broker) return [];
    try {
      return await fetchRecentCandles({
        broker,
        instrumentToken: NIFTY50_INSTRUMENT_TOKEN,
        symbol: 'NIFTY 50',
        interval: '5minute',
        count: REGIME_INTRADAY_CANDLES,
      });
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to fetch Nifty intraday candles — regime will use cache');
      return [];
    }
  }

  // ─── Nifty 50 Today's OHLC Provider ──────────────────────
  // Returns today's intraday high/low for Layer 1 range-ratio calculation.
  // Uses broker.getQuote() which returns live intraday OHLC (ohlc.high / ohlc.low).
  async function fetchNiftyOHLC() {
    if (!broker) return null;
    try {
      const quote = await broker.getQuote(['NSE:NIFTY 50']);
      const q = quote?.['NSE:NIFTY 50'];
      if (!q) return null;
      const high = q.ohlc?.high ?? q.high ?? null;
      const low  = q.ohlc?.low  ?? q.low  ?? null;
      if (high == null || low == null) return null;
      return { high, low };
    } catch (err) {
      log.warn({ err: err.message }, 'Failed to fetch Nifty OHLC — Layer 1 range-ratio skipped this cycle');
      return null;
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
        let lastPrice = posCtx.price || posCtx.entryPrice;

        // Try to get a fresh price if broker is connected
        if (broker) {
          try {
            const ltp = await broker.getLTP(`NSE:${symbol}`);
            if (ltp && ltp.last_price) {
              lastPrice = ltp.last_price;
            }
          } catch (e) {
            log.warn({ symbol, err: e.message }, 'Failed to fetch fresh LTP for paper position');
          }
        }

        positions.push({
          symbol: symbol,
          tradingsymbol: symbol,
          quantity: posCtx.quantity,
          average_price: posCtx.entryPrice,
          last_price: lastPrice,
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

    const roiLine = summary.totalCashRequired > 0
      ? `\n📈 Daily ROI: ${summary.dailyRoi >= 0 ? '+' : ''}${summary.dailyRoi?.toFixed(2)}%` +
        ` on ₹${(summary.totalCashRequired || 0).toLocaleString('en-IN')} cash used` +
        `\n🏔️  Peak deployed: ₹${(summary.peakDeployment || 0).toLocaleString('en-IN')}`
      : '';

    const msg =
      `📊 <b>Alpha8 Daily Report</b>\n` +
      `${summary.mode === 'PAPER' ? '🟢 Paper' : '🔴 Live'} Trading\n\n` +
      `💰 PnL: ₹${(summary.pnl || 0).toLocaleString('en-IN')}\n` +
      `📈 Trades: ${summary.trades || 0}\n` +
      `✅ Wins: ${summary.wins || 0}\n` +
      `❌ Losses: ${summary.losses || 0}\n` +
      `🔘 Open: ${summary.openPositions || 0}` +
      roiLine +
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
    scout,             // ← passes scout for nightly job
    shadowRecorder,
    intradayDecay,     // Feature 7: resetDay() at market open
    positionManager,   // Position management: stop/trail/time exits before each scan
    broker,
    dataFeed: tickFeed,
    telegram,          // For strategy promotion alerts (Task 7)
    getWatchlist,
    getNiftyCandles,
    getOpenPositions,
    sendReport,
    healthCheck,
    // Intraday regime data providers
    fetchNiftyIntraday,
    fetchNiftyOHLC,
    // ORB/BAVI integration (Task 6 & 5)
    baviAdapter,       // setSymbol() called per scan before consensus.evaluate()
    rsiStrategy,       // Long-exit helper: RSI_OVERBOUGHT_EXIT in latestSignals
    tickClassifier,    // Reset at market open each day
    rollingTickBuf,    // Reset at market open each day
  });

  scheduler.start();
  log.info('✅ Market scheduler started (8 daily jobs registered)');

  // ─── Manual Control Commands ───────────────────────────
  if (telegram.enabled) {
    telegram.onCommand('/status', async () => {
      try {
        const sStatus = scheduler.getStatus();
        const rStatus = riskManager.getStatus();
        const eStatus = engine.getStatus();

        let liveCap = config.TRADING_CAPITAL;
        if (redisHealthy && typeof getLiveSetting === 'function') {
          try { liveCap = await getLiveSetting('TRADING_CAPITAL', config.TRADING_CAPITAL); } catch { /* */ }
        }

        const msg =
          `🖥️ <b>System Status</b>\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🛰️ <b>Scanning:</b> ${sStatus.scanning ? '🟢 ACTIVE' : '⚪ INACTIVE'}\n` +
          `💰 <b>Capital:</b> ₹${Number(liveCap).toLocaleString('en-IN')}\n` +
          `📊 <b>PnL:</b> ₹${rStatus.dailyPnL.toLocaleString('en-IN')}\n` +
          `📉 <b>Drawdown:</b> ${rStatus.drawdownPct.toFixed(2)}%\n` +
          `📦 <b>Positions:</b> ${eStatus.openPositions}\n` +
          `⚡ <b>Kill Switch:</b> ${rStatus.killSwitch.engaged ? '🔴 ENGAGED' : '🟢 NORMAL'}\n` +
          `━━━━━━━━━━━━━━━━━━━━\n` +
          `🕐 ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}`;

        telegram.sendRaw(msg);
      } catch (err) {
        telegram.sendRaw(`❌ <b>Status Error:</b> ${err.message}`);
      }
    });

    telegram.onCommand('/market_open', async () => {
      log.info('Manual market open triggered via Telegram');
      telegram.sendRaw('⏳ <b>Manual Market Open</b>\nInitializing market-day routines...');

      try {
        const result = await scheduler._marketOpen();
        if (result.scanning) {
          telegram.sendRaw('✅ <b>Market Open Complete</b>\nStrategy scanning is now ACTIVE.');
        } else {
          telegram.sendRaw('⚠️ <b>Market Open Partial</b>\nRoutines completed but focus scanning state is unclear.');
        }
      } catch (err) {
        log.error({ err: err.message }, 'Manual market open failed');
        telegram.sendRaw(`❌ <b>Market Open Failed:</b> ${err.message}`);
      }
    });

    telegram.onCommand('/help', async () => {
      const msg =
        `📋 <b>Available Commands</b>\n\n` +
        `/status - View current system and PnL status\n` +
        `/watchlist - View active watchlist symbols\n` +
        `/scout - Manual symbol scout scan\n` +
        `/params - View current live risk parameters\n` +
        `/set <code>KEY value</code> - Set risk parameter\n` +
        `/reset <code>KEY</code> - Reset parameter to default\n` +
        `/conviction <code>on/off</code> - Toggle Super Conviction\n` +
        `/reset_kill_switch - Reset the kill switch\n` +
        `/market_open - Trigger market routines\n` +
        `/help - Show this help message` +
        `/login - Login to Zerodha`;
      telegram.sendRaw(msg);
    });

    log.info('✅ Telegram /status, /market_open and /help commands registered');
  }

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
        const result = await executeSquareOff({ broker, riskManager, engine, getOpenPositions });
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
    getLiveSetting: redisHealthy ? getLiveSetting : null,
    setLiveSetting: redisHealthy ? setLiveSetting : null,
    getAllLiveSettings: redisHealthy ? getAllLiveSettings : null,
    resetLiveSetting: redisHealthy ? resetLiveSetting : null,
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

    let liveCapital = config.TRADING_CAPITAL;
    if (redisHealthy && typeof getLiveSetting === 'function') {
      try { liveCapital = await getLiveSetting('TRADING_CAPITAL', config.TRADING_CAPITAL); } catch { /* */ }
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
      `💰 Capital: ₹${Number(liveCapital).toLocaleString('en-IN')}\n` +
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