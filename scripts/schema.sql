-- Alpha8 Database Schema
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

-- ─── Signal Outcomes Table ────────────────────────────
-- Used by AdaptiveWeightManager to track per-strategy accuracy.
-- Each row = one signal's real-world outcome after the trade closed.
CREATE TABLE IF NOT EXISTS signal_outcomes (
  id          SERIAL PRIMARY KEY,
  strategy    VARCHAR(50)  NOT NULL,
  signal      VARCHAR(10)  NOT NULL,
  symbol      VARCHAR(20)  NOT NULL,
  outcome     VARCHAR(10)  NOT NULL CHECK (outcome IN ('WIN', 'LOSS')),
  pnl         DECIMAL(12, 2),
  recorded_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_signal_outcomes_strategy
  ON signal_outcomes(strategy, recorded_at);
CREATE INDEX IF NOT EXISTS idx_signal_outcomes_symbol
  ON signal_outcomes(symbol, recorded_at);

-- ─── Symbol Scores Table ──────────────────────────────
-- Stores the nightly scout scores for all scanned symbols.
-- Each nightly run inserts a fresh snapshot — last N days queryable.
-- The dashboard reads latest scores to show why symbols were added/removed.
CREATE TABLE IF NOT EXISTS symbol_scores (
  id          SERIAL PRIMARY KEY,
  symbol      VARCHAR(32)  NOT NULL,
  score       INTEGER      NOT NULL CHECK (score >= 0 AND score <= 100),
  breakdown   JSONB,       -- { liquidity, trend, volatility, momentum, trackRecord }
  scanned_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_symbol_scores_symbol
  ON symbol_scores(symbol, scanned_at DESC);
CREATE INDEX IF NOT EXISTS idx_symbol_scores_scanned_at
  ON symbol_scores(scanned_at DESC);

-- Auto-purge: keep only last 30 days of scores (run via pg_cron or manually)
-- DELETE FROM symbol_scores WHERE scanned_at < NOW() - INTERVAL '30 days';

-- ─── Watchlist Log Table ──────────────────────────────
-- Audit trail of every add/remove made by the symbol scout.
-- Lets you review why a symbol was added or dropped on any given day.
CREATE TABLE IF NOT EXISTS watchlist_log (
  id          SERIAL PRIMARY KEY,
  symbol      VARCHAR(32)  NOT NULL,
  action      VARCHAR(10)  NOT NULL CHECK (action IN ('ADDED', 'REMOVED', 'PINNED')),
  reason      TEXT,
  score       INTEGER,
  logged_at   TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_watchlist_log_symbol
  ON watchlist_log(symbol, logged_at DESC);
CREATE INDEX IF NOT EXISTS idx_watchlist_log_logged_at
  ON watchlist_log(logged_at DESC);

-- ─── Seed: initial dynamic watchlist ─────────────────
-- On first run the dynamic list is empty — the scout fills it that night.
-- This insert is a no-op on subsequent runs (ON CONFLICT DO NOTHING).
INSERT INTO settings (key, value, updated_at)
VALUES ('dynamic_watchlist', '[]', NOW())
ON CONFLICT (key) DO NOTHING;