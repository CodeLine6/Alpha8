-- Quant8 Database Schema
-- Run this against your PostgreSQL database to create required tables.
-- Usage: psql $DATABASE_URL -f scripts/schema.sql

-- ─── Trades Table ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS trades (
  id            SERIAL PRIMARY KEY,
  order_id      VARCHAR(64) UNIQUE NOT NULL,
  symbol        VARCHAR(32) NOT NULL,
  side          VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity      INTEGER NOT NULL CHECK (quantity > 0),
  price         DECIMAL(12, 2) NOT NULL DEFAULT 0,
  pnl           DECIMAL(12, 2) DEFAULT 0,
  strategy      VARCHAR(64),
  status        VARCHAR(16) NOT NULL DEFAULT 'PENDING',
  broker_id     VARCHAR(64),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);

-- ─── Positions Table ──────────────────────────────────
CREATE TABLE IF NOT EXISTS positions (
  id            SERIAL PRIMARY KEY,
  symbol        VARCHAR(32) NOT NULL,
  side          VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
  quantity      INTEGER NOT NULL,
  avg_price     DECIMAL(12, 2) NOT NULL,
  current_price DECIMAL(12, 2),
  stop_loss     DECIMAL(12, 2),
  product       VARCHAR(8) DEFAULT 'MIS',
  strategy      VARCHAR(64),
  exchange      VARCHAR(8) DEFAULT 'NSE',
  opened_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  closed_at     TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
CREATE INDEX IF NOT EXISTS idx_positions_opened_at ON positions(opened_at);

-- ─── Signals Table ────────────────────────────────────
CREATE TABLE IF NOT EXISTS signals (
  id            SERIAL PRIMARY KEY,
  symbol        VARCHAR(32) NOT NULL,
  strategy      VARCHAR(64),
  signal        VARCHAR(4) NOT NULL CHECK (signal IN ('BUY', 'SELL', 'HOLD')),
  confidence    INTEGER CHECK (confidence >= 0 AND confidence <= 100),
  acted_on      BOOLEAN DEFAULT FALSE,
  reason        TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);

-- ─── Daily Summary Table ──────────────────────────────
CREATE TABLE IF NOT EXISTS daily_summary (
  id            SERIAL PRIMARY KEY,
  trade_date    DATE UNIQUE NOT NULL,
  pnl           DECIMAL(12, 2) DEFAULT 0,
  pnl_pct       DECIMAL(8, 4) DEFAULT 0,
  trade_count   INTEGER DEFAULT 0,
  win_count     INTEGER DEFAULT 0,
  loss_count    INTEGER DEFAULT 0,
  filled        INTEGER DEFAULT 0,
  rejected      INTEGER DEFAULT 0,
  best_trade    DECIMAL(12, 2),
  worst_trade   DECIMAL(12, 2),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Settings Table ───────────────────────────────────
CREATE TABLE IF NOT EXISTS settings (
  key           VARCHAR(64) PRIMARY KEY,
  value         TEXT NOT NULL,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
