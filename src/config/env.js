import { config as dotenvConfig } from 'dotenv';
import { z } from 'zod';

// Load .env before validation
dotenvConfig();

/**
 * Zod schema for all environment variables.
 * Fails fast at startup if any required variable is missing or invalid.
 */
const envSchema = z.object({
  // ─── Application ──────────────────────────────────────
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  PORT: z.coerce.number().int().positive().default(3000),

  // ─── Zerodha Kite Connect ────────────────────────────
  KITE_API_KEY: z.string().min(1, 'KITE_API_KEY is required'),
  KITE_API_SECRET: z.string().min(1, 'KITE_API_SECRET is required'),

  // ─── Zerodha Auto-Login ──────────────────────────────
  ZERODHA_USER_ID: z.string().optional().default(''),
  ZERODHA_PASSWORD: z.string().optional().default(''),
  ZERODHA_TOTP_SECRET: z.string().optional().default(''),

  // ─── AngelOne Smart API (optional fallback) ──────────
  ANGEL_API_KEY: z.string().optional().default(''),
  ANGEL_CLIENT_ID: z.string().optional().default(''),
  ANGEL_PASSWORD: z.string().optional().default(''),
  ANGEL_TOTP_SECRET: z.string().optional().default(''),

  // ─── Database ────────────────────────────────────────
  DATABASE_URL: z
    .string()
    .url('DATABASE_URL must be a valid PostgreSQL connection string'),

  // ─── Redis ───────────────────────────────────────────
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),

  // ─── Telegram Notifications ─────────────────────────
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),

  // ─── Trading Configuration ──────────────────────────
  TRADING_CAPITAL: z.coerce.number().positive().default(100000),
  LIVE_TRADING: z
    .string()
    .transform((val) => val === 'true')
    .default('false'),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().max(100).default(2),
  MAX_POSITION_COUNT: z.coerce.number().int().positive().default(5),
  PER_TRADE_STOP_LOSS_PCT: z.coerce.number().positive().max(100).default(1),
  KILL_SWITCH_DRAWDOWN_PCT: z.coerce.number().positive().max(100).default(5),
  MAX_CAPITAL_EXPOSURE_PCT: z.coerce.number().positive().max(100).default(100),
  MAX_POSITION_VALUE_PCT: z.coerce.number().positive().max(100).default(100),

  // ─── Position Management ─────────────────────────────
  STOP_LOSS_PCT: z.coerce.number().positive().max(100).default(1),
  TRAILING_STOP_PCT: z.coerce.number().positive().max(100).default(1.0),
  MAX_HOLD_MINUTES: z.coerce.number().int().positive().default(90),
  POSITION_MGMT_ENABLED: z
    .string()
    .transform((v) => v !== 'false')
    .default('true'),

  // ─── Watchlist ────────────────────────────────────────
  WATCHLIST: z.string().optional().default('RELIANCE,TCS,INFY,HDFCBANK,ICICIBANK'),

  // ─── API Authentication ───────────────────────────────
  API_SECRET_KEY: z.string().optional().default(''),

  // ─── News Sentiment Filter ────────────────────────────
  // Optional — leave empty to disable news sentiment gate.
  // Get your key from Google AI Studio
  GEMINI_API_KEY: z.string().optional().default(''),
}).refine(
  (data) => data.KILL_SWITCH_DRAWDOWN_PCT >= data.MAX_DAILY_LOSS_PCT, {
  message: 'KILL_SWITCH_DRAWDOWN_PCT must be >= MAX_DAILY_LOSS_PCT',
  path: ['KILL_SWITCH_DRAWDOWN_PCT'],
}
).refine(
  (data) => data.PER_TRADE_STOP_LOSS_PCT <= data.MAX_DAILY_LOSS_PCT, {
  message: 'PER_TRADE_STOP_LOSS_PCT should be <= MAX_DAILY_LOSS_PCT',
  path: ['PER_TRADE_STOP_LOSS_PCT'],
}
);

/**
 * Validated and typed configuration object.
 * @type {z.infer<typeof envSchema>}
 */
let config;

try {
  config = envSchema.parse(process.env);
} catch (error) {
  console.error('❌ Environment validation failed:');
  if (error instanceof z.ZodError) {
    error.issues.forEach((issue) => {
      console.error(`   • ${issue.path.join('.')}: ${issue.message}`);
    });
  }
  process.exit(1);
}

export { config };