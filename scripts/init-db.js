import pg from 'pg';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig();

const DATABASE_URL =
  process.env.DATABASE_URL || 'postgresql://quant8:quant8_dev@localhost:5432/quant8';

const { Client } = pg;

async function initDB() {
  const client = new Client({ connectionString: DATABASE_URL });

  try {
    await client.connect();
    console.log('✅ Connected to PostgreSQL');

    // ─── Trades table ─────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS trades (
        id            SERIAL PRIMARY KEY,
        symbol        VARCHAR(20) NOT NULL,
        side          VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
        quantity      INTEGER NOT NULL,
        price         NUMERIC(12,2) NOT NULL,
        pnl           NUMERIC(12,2) DEFAULT 0,
        strategy      VARCHAR(50),
        status        VARCHAR(20) NOT NULL DEFAULT 'PENDING',
        order_id      VARCHAR(100),
        broker_id     VARCHAR(100),
        paper_mode    BOOLEAN DEFAULT true,
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        filled_at     TIMESTAMPTZ,
        metadata      JSONB DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(symbol);
      CREATE INDEX IF NOT EXISTS idx_trades_strategy ON trades(strategy);
      CREATE INDEX IF NOT EXISTS idx_trades_created_at ON trades(created_at);
      CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
    `);
    console.log('✅ trades table ready');

    // ─── Positions table ──────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS positions (
        id            SERIAL PRIMARY KEY,
        symbol        VARCHAR(20) NOT NULL UNIQUE,
        side          VARCHAR(4) NOT NULL CHECK (side IN ('BUY', 'SELL')),
        quantity      INTEGER NOT NULL,
        avg_price     NUMERIC(12,2) NOT NULL,
        current_price NUMERIC(12,2),
        stop_loss     NUMERIC(12,2),
        product       VARCHAR(10) DEFAULT 'MIS',
        strategy      VARCHAR(50),
        opened_at     TIMESTAMPTZ DEFAULT NOW(),
        updated_at    TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_positions_symbol ON positions(symbol);
    `);
    console.log('✅ positions table ready');

    // ─── Signals table ────────────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS signals (
        id            SERIAL PRIMARY KEY,
        strategy      VARCHAR(50) NOT NULL,
        symbol        VARCHAR(20) NOT NULL,
        signal        VARCHAR(10) NOT NULL CHECK (signal IN ('BUY', 'SELL', 'HOLD')),
        confidence    INTEGER CHECK (confidence BETWEEN 0 AND 100),
        acted_on      BOOLEAN DEFAULT false,
        price         NUMERIC(12,2),
        created_at    TIMESTAMPTZ DEFAULT NOW(),
        metadata      JSONB DEFAULT '{}'
      );

      CREATE INDEX IF NOT EXISTS idx_signals_strategy ON signals(strategy);
      CREATE INDEX IF NOT EXISTS idx_signals_symbol ON signals(symbol);
      CREATE INDEX IF NOT EXISTS idx_signals_created_at ON signals(created_at);
    `);
    console.log('✅ signals table ready');

    // ─── Daily Summary table ──────────────────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS daily_summary (
        id              SERIAL PRIMARY KEY,
        trade_date      DATE NOT NULL UNIQUE,
        pnl             NUMERIC(12,2) DEFAULT 0,
        pnl_pct         NUMERIC(6,2) DEFAULT 0,
        trade_count     INTEGER DEFAULT 0,
        win_count       INTEGER DEFAULT 0,
        loss_count      INTEGER DEFAULT 0,
        filled          INTEGER DEFAULT 0,
        rejected        INTEGER DEFAULT 0,
        max_drawdown    NUMERIC(6,2) DEFAULT 0,
        capital         NUMERIC(14,2) DEFAULT 100000,
        best_trade      JSONB DEFAULT '{}',
        worst_trade     JSONB DEFAULT '{}',
        created_at      TIMESTAMPTZ DEFAULT NOW()
      );

      CREATE INDEX IF NOT EXISTS idx_daily_summary_date ON daily_summary(trade_date);
    `);
    console.log('✅ daily_summary table ready');

    // ─── Settings table (key-value store) ─────────────
    await client.query(`
      CREATE TABLE IF NOT EXISTS settings (
        key     VARCHAR(100) PRIMARY KEY,
        value   JSONB NOT NULL,
        updated_at TIMESTAMPTZ DEFAULT NOW()
      );

      -- Seed default watchlist if not present
      INSERT INTO settings (key, value) 
      VALUES ('watchlist', '["RELIANCE", "INFY", "TCS", "HDFCBANK", "SBIN"]')
      ON CONFLICT (key) DO NOTHING;
    `);
    console.log('✅ settings table ready');

    console.log('\n🎉 Database initialized successfully!');
  } catch (err) {
    console.error('❌ Database initialization failed:', err.message);
    process.exit(1);
  } finally {
    await client.end();
  }
}

initDB();
