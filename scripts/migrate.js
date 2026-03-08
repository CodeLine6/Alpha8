/**
 * Database migration script for Quant8.
 * Creates all required tables and indexes. Idempotent — safe to re-run.
 *
 * Usage: node scripts/migrate.js
 */

import { config as dotenvConfig } from 'dotenv';
import pg from 'pg';

dotenvConfig();

const { Pool } = pg;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
});

const MIGRATIONS = [
  // ─── Trades Table ───────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS trades (
    id            SERIAL PRIMARY KEY,
    symbol        VARCHAR(20) NOT NULL,
    exchange      VARCHAR(5) NOT NULL DEFAULT 'NSE',
    entry_price   DECIMAL(12, 2) NOT NULL,
    exit_price    DECIMAL(12, 2),
    quantity      INTEGER NOT NULL,
    side          VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
    order_type    VARCHAR(10) NOT NULL DEFAULT 'MARKET',
    strategy      VARCHAR(30) NOT NULL,
    pnl           DECIMAL(12, 2) DEFAULT 0,
    fees          DECIMAL(10, 2) DEFAULT 0,
    status        VARCHAR(15) NOT NULL DEFAULT 'OPEN',
    paper_trade   BOOLEAN NOT NULL DEFAULT true,
    entry_time    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    exit_time     TIMESTAMPTZ,
    created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  // ─── Positions Table ────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS positions (
    id              SERIAL PRIMARY KEY,
    symbol          VARCHAR(20) NOT NULL,
    exchange        VARCHAR(5) NOT NULL DEFAULT 'NSE',
    quantity        INTEGER NOT NULL DEFAULT 0,
    avg_price       DECIMAL(12, 2) NOT NULL,
    current_price   DECIMAL(12, 2),
    unrealized_pnl  DECIMAL(12, 2) DEFAULT 0,
    strategy        VARCHAR(30) NOT NULL,
    paper_trade     BOOLEAN NOT NULL DEFAULT true,
    opened_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  // ─── Signals Table ──────────────────────────────────────
  `CREATE TABLE IF NOT EXISTS signals (
    id          SERIAL PRIMARY KEY,
    symbol      VARCHAR(20) NOT NULL,
    exchange    VARCHAR(5) NOT NULL DEFAULT 'NSE',
    strategy    VARCHAR(30) NOT NULL,
    signal      VARCHAR(4) NOT NULL CHECK (signal IN ('BUY', 'SELL', 'HOLD')),
    confidence  INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
    reason      TEXT,
    acted_on    BOOLEAN NOT NULL DEFAULT false,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  // ─── Daily Summary Table ────────────────────────────────
  `CREATE TABLE IF NOT EXISTS daily_summary (
    id                SERIAL PRIMARY KEY,
    date              DATE NOT NULL UNIQUE,
    total_pnl         DECIMAL(12, 2) NOT NULL DEFAULT 0,
    win_count         INTEGER NOT NULL DEFAULT 0,
    loss_count        INTEGER NOT NULL DEFAULT 0,
    total_trades      INTEGER NOT NULL DEFAULT 0,
    capital_deployed  DECIMAL(14, 2) NOT NULL DEFAULT 0,
    max_drawdown_pct  DECIMAL(6, 2) DEFAULT 0,
    paper_trading     BOOLEAN NOT NULL DEFAULT true,
    created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );`,

  // ─── Indexes ────────────────────────────────────────────
  `CREATE INDEX IF NOT EXISTS idx_trades_symbol_entry
     ON trades(symbol, entry_time);`,

  `CREATE INDEX IF NOT EXISTS idx_trades_strategy
     ON trades(strategy);`,

  `CREATE INDEX IF NOT EXISTS idx_trades_status
     ON trades(status);`,

  `CREATE INDEX IF NOT EXISTS idx_positions_symbol
     ON positions(symbol);`,

  `CREATE INDEX IF NOT EXISTS idx_signals_symbol_acted
     ON signals(symbol, acted_on);`,

  `CREATE INDEX IF NOT EXISTS idx_signals_strategy
     ON signals(strategy, created_at);`,

  `CREATE INDEX IF NOT EXISTS idx_daily_summary_date
     ON daily_summary(date);`,

  `CREATE TABLE IF NOT EXISTS signal_outcomes (
    id          SERIAL PRIMARY KEY,
    strategy    VARCHAR(50)  NOT NULL,
    signal      VARCHAR(10)  NOT NULL,
    symbol      VARCHAR(20)  NOT NULL,
    outcome     VARCHAR(10)  NOT NULL,
    pnl         DECIMAL(12,2),
    recorded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );`,

  `CREATE INDEX IF NOT EXISTS idx_signal_outcomes_strategy
  ON signal_outcomes(strategy, recorded_at);`
];

async function migrate() {
  console.log('🗄️  Quant8 Database Migration');
  console.log('─'.repeat(50));

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    for (const sql of MIGRATIONS) {
      const tableName = sql.match(/(?:TABLE|INDEX)\s+(?:IF NOT EXISTS\s+)?(\w+)/i)?.[1] || 'unknown';
      process.stdout.write(`  ▸ ${tableName}... `);
      await client.query(sql);
      console.log('✅');
    }

    await client.query('COMMIT');
    console.log('─'.repeat(50));
    console.log('✅ All migrations applied successfully.');
  } catch (err) {
    await client.query('ROLLBACK');
    console.error('❌ Migration failed:', err.message);
    process.exit(1);
  } finally {
    client.release();
    await pool.end();
  }
}

migrate();
