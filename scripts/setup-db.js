/**
 * Unified Database Setup for Alpha8
 *
 * Replaces init-db.js, migrate.js, and schema.sql.
 * Creates all tables and indexes matching EXACTLY what the app uses.
 * Safe to re-run (idempotent — all CREATE statements use IF NOT EXISTS).
 *
 * Usage: npm run db:init
 *        node scripts/setup-db.js
 */

import pg from 'pg';
import { config as dotenvConfig } from 'dotenv';
import path from 'path';
import { fileURLToPath } from 'url';

dotenvConfig({ path: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../.env') });

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://alpha8:alpha8_dev@localhost:5432/alpha8';

const { Client } = pg;

const MIGRATIONS = [

  // ─── 1. TRADES ──────────────────────────────────────────────────────────────
  // Writers : execution-engine.js, square-off-job.js
  // Readers : backend-api.js
  // Key constraint: order_id UNIQUE NOT NULL — app uses ON CONFLICT (order_id) DO NOTHING
  `CREATE TABLE IF NOT EXISTS trades (
    id         SERIAL PRIMARY KEY,
    order_id   VARCHAR(100) UNIQUE NOT NULL,
    broker_id  VARCHAR(100),
    symbol     VARCHAR(20)  NOT NULL,
    side       VARCHAR(4)   NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity   INTEGER      NOT NULL,
    price      NUMERIC(12,2) NOT NULL,
    pnl        NUMERIC(12,2) DEFAULT 0,
    strategy   VARCHAR(1111),
    status     VARCHAR(20)  NOT NULL DEFAULT 'PENDING',
    paper_mode BOOLEAN      NOT NULL DEFAULT true,
    metadata   JSONB        DEFAULT '{}',
    created_at TIMESTAMPTZ  DEFAULT NOW(),
    filled_at  TIMESTAMPTZ
  );`,

  `CREATE INDEX IF NOT EXISTS idx_trades_symbol     ON trades(symbol);`,
  `CREATE INDEX IF NOT EXISTS idx_trades_strategy   ON trades(strategy);`,
  `CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);`,
  `CREATE INDEX IF NOT EXISTS idx_trades_status     ON trades(status);`,

  // ─── 2. POSITIONS ────────────────────────────────────────────────────────────
  // Writers : nothing in current codebase (populated externally / future)
  // Readers : backend-api.js — reads avg_price, current_price, stop_loss, product, strategy
  // NO UNIQUE on symbol — multiple position rows per symbol must be allowed
  `CREATE TABLE IF NOT EXISTS positions (
    id            SERIAL PRIMARY KEY,
    symbol        VARCHAR(20)  NOT NULL,
    side          VARCHAR(4)   NOT NULL CHECK (side IN ('BUY', 'SELL')),
    quantity      INTEGER      NOT NULL,
    avg_price     NUMERIC(12,2) NOT NULL,
    current_price NUMERIC(12,2),
    stop_loss     NUMERIC(12,2),
    product       VARCHAR(10)  DEFAULT 'MIS',
    strategy      VARCHAR(50),
    paper_trade   BOOLEAN      NOT NULL DEFAULT true,
    opened_at     TIMESTAMPTZ  DEFAULT NOW(),
    updated_at    TIMESTAMPTZ  DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_positions_symbol    ON positions(symbol);`,
  `CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at);`,

  // ─── 3. SIGNALS ──────────────────────────────────────────────────────────────
  // Writers : execution-engine.js — INSERT (symbol, strategy, signal, confidence, acted_on, reason, created_at)
  //           execution-engine.js — UPDATE signals SET acted_on = true
  // Readers : backend-api.js — reads strategy, symbol, signal, confidence, acted_on, created_at
  `CREATE TABLE IF NOT EXISTS signals (
    id         SERIAL PRIMARY KEY,
    symbol     VARCHAR(20) NOT NULL,
    strategy   VARCHAR(50) NOT NULL,
    signal     VARCHAR(10) NOT NULL CHECK (signal IN ('BUY', 'SELL', 'HOLD')),
    confidence INTEGER     NOT NULL CHECK (confidence BETWEEN 0 AND 100),
    acted_on   BOOLEAN     NOT NULL DEFAULT false,
    reason     TEXT,
    price      NUMERIC(12,2),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_signals_symbol     ON signals(symbol);`,
  `CREATE INDEX IF NOT EXISTS idx_signals_strategy   ON signals(strategy);`,
  `CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);`,

  // ─── 4. DAILY SUMMARY ────────────────────────────────────────────────────────
  // Writers : nothing in current codebase (populated externally / future)
  // Readers : backend-api.js — reads pnl, pnl_pct, trade_count, win_count, loss_count,
  //                             filled, rejected, best_trade, worst_trade
  // best_trade / worst_trade are NUMERIC — backend does parseFloat(dbSummary.best_trade)
  `CREATE TABLE IF NOT EXISTS daily_summary (
    id          SERIAL PRIMARY KEY,
    trade_date  DATE         NOT NULL UNIQUE,
    pnl         NUMERIC(12,2) DEFAULT 0,
    pnl_pct     NUMERIC(6,2)  DEFAULT 0,
    trade_count INTEGER      DEFAULT 0,
    win_count   INTEGER      DEFAULT 0,
    loss_count  INTEGER      DEFAULT 0,
    filled      INTEGER      DEFAULT 0,
    rejected    INTEGER      DEFAULT 0,
    best_trade  NUMERIC(12,2),
    worst_trade NUMERIC(12,2),
    created_at  TIMESTAMPTZ  DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_summary(trade_date);`,

  // ─── 5. SETTINGS ─────────────────────────────────────────────────────────────
  // Writers : backend-api.js        — stores watchlist as JSON.stringify(array)
  //           symbol-scout.js       — stores dynamic_watchlist as JSON.stringify(array)
  // Readers : backend-api.js, symbol-scout.js — both do JSON.parse(result.rows[0].value)
  // value MUST be TEXT — app serialises/deserialises manually with JSON.stringify/parse.
  // JSONB would auto-deserialise on read, breaking JSON.parse() calls.
  `CREATE TABLE IF NOT EXISTS settings (
    key        VARCHAR(100) PRIMARY KEY,
    value      TEXT         NOT NULL,
    updated_at TIMESTAMPTZ  DEFAULT NOW()
  );`,

  // ─── 6. SIGNAL OUTCOMES ──────────────────────────────────────────────────────
  // Writers : adaptive-weights.js — INSERT (strategy, signal, symbol, outcome, pnl, recorded_at)
  // Readers : adaptive-weights.js — SELECT per strategy for weight calculation
  //           symbol-scout.js     — SELECT per symbol for track record scoring + consecutive losses
  `CREATE TABLE IF NOT EXISTS signal_outcomes (
    id          SERIAL PRIMARY KEY,
    strategy    VARCHAR(50)  NOT NULL,
    signal      VARCHAR(10)  NOT NULL,
    symbol      VARCHAR(20)  NOT NULL,
    outcome     VARCHAR(10)  NOT NULL CHECK (outcome IN ('WIN', 'LOSS')),
    pnl         NUMERIC(12,2),
    recorded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_signal_outcomes_strategy ON signal_outcomes(strategy, recorded_at);`,
  `CREATE INDEX IF NOT EXISTS idx_signal_outcomes_symbol   ON signal_outcomes(symbol, recorded_at);`,

  // ─── 7. SYMBOL SCORES ────────────────────────────────────────────────────────
  // Writers : symbol-scout.js — INSERT nightly score snapshot per symbol
  // Readers : symbol-scout.js — SELECT latest scan for dashboard display
  `CREATE TABLE IF NOT EXISTS symbol_scores (
    id         SERIAL PRIMARY KEY,
    symbol     VARCHAR(20) NOT NULL,
    score      INTEGER     NOT NULL CHECK (score BETWEEN 0 AND 100),
    breakdown  JSONB       NOT NULL,
    scanned_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_symbol_scores_symbol     ON symbol_scores(symbol, scanned_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_symbol_scores_scanned_at ON symbol_scores(scanned_at DESC);`,

  // ─── 8. WATCHLIST LOG ────────────────────────────────────────────────────────
  // Writers : symbol-scout.js — INSERT on every add/remove
  // Readers : dashboard (audit trail of scout decisions)
  `CREATE TABLE IF NOT EXISTS watchlist_log (
    id        SERIAL PRIMARY KEY,
    symbol    VARCHAR(20) NOT NULL,
    action    VARCHAR(10) NOT NULL CHECK (action IN ('ADDED', 'REMOVED', 'PINNED')),
    reason    TEXT,
    score     INTEGER,
    logged_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_watchlist_log_symbol    ON watchlist_log(symbol, logged_at DESC);`,
  `CREATE INDEX IF NOT EXISTS idx_watchlist_log_logged_at ON watchlist_log(logged_at DESC);`,
  // ─── 9. SHADOW SIGNALS ───────────────────────────────────────────────────────
  // Writers : shadow-recorder.js  — INSERT on every scan cycle (fire-and-forget)
  //           shadow-recorder.js  — UPDATE price_after_* columns every 30min background job
  // Readers : shadow-recorder.js  — getStrategyAccuracy() for unbiased weight calculation
  //           adaptive-weights.js — future: replace signal_outcomes read with this
  //
  // PURPOSE: Records ALL individual strategy signals (not just consensus trades) so
  //          adaptive weights can be calculated without selection bias. A strategy that
  //          fires solo at 93% confidence is evaluated here even if no trade executed.
  //
  // KEY DESIGN:
  //   - price_at_signal REQUIRED (NOT NULL) — zero-price rows are not inserted
  //   - price_after_* filled asynchronously by background job via broker LTP
  //   - was_correct_* computed at fill time: BUY→ price_after > price_at_signal
  //   - consensus_reached: did this scan produce ANY consensus signal?
  //   - acted_on: did a trade actually FILL (passed all 6 gates)?
  //   - regime: market state at signal time (TRENDING/SIDEWAYS/VOLATILE/UNKNOWN)
  `CREATE TABLE IF NOT EXISTS shadow_signals (
    id                  SERIAL PRIMARY KEY,
    symbol              VARCHAR(20)   NOT NULL,
    strategy            VARCHAR(50)   NOT NULL,
    direction           VARCHAR(10)   NOT NULL CHECK (direction IN ('BUY', 'SELL')),
    confidence          DECIMAL(5,2)  NOT NULL,
    price_at_signal     DECIMAL(10,2) NOT NULL,
    price_after_15min   DECIMAL(10,2) DEFAULT NULL,
    price_after_30min   DECIMAL(10,2) DEFAULT NULL,
    price_after_60min   DECIMAL(10,2) DEFAULT NULL,
    price_eod           DECIMAL(10,2) DEFAULT NULL,
    was_correct_15min   BOOLEAN       DEFAULT NULL,
    was_correct_30min   BOOLEAN       DEFAULT NULL,
    was_correct_60min   BOOLEAN       DEFAULT NULL,
    consensus_reached   BOOLEAN       NOT NULL DEFAULT FALSE,
    acted_on            BOOLEAN       NOT NULL DEFAULT FALSE,
    regime              VARCHAR(20)   DEFAULT NULL,
    created_at          TIMESTAMPTZ   NOT NULL DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_shadow_symbol_strategy
     ON shadow_signals(symbol, strategy, created_at DESC);`,

  `CREATE INDEX IF NOT EXISTS idx_shadow_created_at
     ON shadow_signals(created_at DESC);`,

  `CREATE INDEX IF NOT EXISTS idx_shadow_needs_fill
     ON shadow_signals(created_at)
     WHERE price_after_30min IS NULL;`,

  `CREATE INDEX IF NOT EXISTS idx_shadow_strategy_accuracy
     ON shadow_signals(strategy, was_correct_30min, created_at DESC);`,
];

// ─── Seed data ──────────────────────────────────────────────────────────────
// Inserted once. ON CONFLICT DO NOTHING means re-runs are safe.
const SEEDS = [
  // Default pinned watchlist — overridden by WATCHLIST in .env at runtime,
  // but stored here so the settings table is never empty on first boot.
  `INSERT INTO settings (key, value, updated_at)
   VALUES ('watchlist', '["RELIANCE","INFY","TCS","HDFCBANK","SBIN"]', NOW())
   ON CONFLICT (key) DO NOTHING;`,

  // Empty dynamic watchlist — scout fills this on its first nightly run.
  `INSERT INTO settings (key, value, updated_at)
   VALUES ('dynamic_watchlist', '[]', NOW())
   ON CONFLICT (key) DO NOTHING;`,
];

// ─── Runner ─────────────────────────────────────────────────────────────────
async function setup() {
  console.log('🗄️  Alpha8 Database Setup');
  console.log('─'.repeat(55));
  console.log(`   Connecting to: ${DATABASE_URL.replace(/:\/\/.*@/, '://<credentials>@')}`);
  console.log('─'.repeat(55));

  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL\n');

    await client.query('BEGIN');

    for (const sql of MIGRATIONS) {
      const isTable = sql.trimStart().startsWith('CREATE TABLE');
      const isIndex = sql.trimStart().startsWith('CREATE INDEX');

      if (isTable) {
        const name = sql.match(/CREATE TABLE\s+(?:IF NOT EXISTS\s+)?(\w+)/i)?.[1] ?? 'unknown';
        process.stdout.write(`  ▸ table: ${name.padEnd(22)} `);
      } else if (isIndex) {
        const name = sql.match(/CREATE INDEX\s+(?:IF NOT EXISTS\s+)?(\w+)/i)?.[1] ?? 'unknown';
        process.stdout.write(`    index: ${name.padEnd(22)} `);
      }

      await client.query(sql);
      console.log('✅');
    }

    console.log('\n  Seeding defaults...');
    for (const sql of SEEDS) {
      await client.query(sql);
    }
    console.log('  ✅ Default settings seeded\n');

    await client.query('COMMIT');

    console.log('─'.repeat(55));
    console.log('🎉 Database ready — all tables and indexes created.');
    console.log('─'.repeat(55));
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('\n❌ Setup failed:', err.message);
    console.error('   All changes have been rolled back.');
    process.exit(1);
  } finally {
    await client.end();
  }
}

setup();