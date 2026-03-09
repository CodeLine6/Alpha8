/**
 * Unit tests for environment configuration validation.
 * Tests that Zod schema catches invalid env vars and applies defaults correctly.
 */

import { describe, test, expect, beforeEach, afterEach } from '@jest/globals';
import { z } from 'zod';

// We re-create the schema here to test in isolation without triggering process.exit
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  KITE_API_KEY: z.string().min(1, 'KITE_API_KEY is required'),
  KITE_API_SECRET: z.string().min(1, 'KITE_API_SECRET is required'),
  KITE_ACCESS_TOKEN: z.string().min(1, 'KITE_ACCESS_TOKEN is required'),
  ANGEL_API_KEY: z.string().optional().default(''),
  ANGEL_CLIENT_ID: z.string().optional().default(''),
  ANGEL_PASSWORD: z.string().optional().default(''),
  ANGEL_TOTP_SECRET: z.string().optional().default(''),
  DATABASE_URL: z.string().url('DATABASE_URL must be a valid PostgreSQL connection string'),
  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  TELEGRAM_BOT_TOKEN: z.string().optional().default(''),
  TELEGRAM_CHAT_ID: z.string().optional().default(''),
  TRADING_CAPITAL: z.coerce.number().positive().default(100000),
  LIVE_TRADING: z.string().transform((val) => val === 'true').default('false'),
  MAX_DAILY_LOSS_PCT: z.coerce.number().positive().max(100).default(2),
  MAX_POSITION_COUNT: z.coerce.number().int().positive().default(5),
  PER_TRADE_STOP_LOSS_PCT: z.coerce.number().positive().max(100).default(1),
  KILL_SWITCH_DRAWDOWN_PCT: z.coerce.number().positive().max(100).default(5),
});

const VALID_ENV = {
  KITE_API_KEY: 'test_api_key',
  KITE_API_SECRET: 'test_api_secret',
  KITE_ACCESS_TOKEN: 'test_access_token',
  DATABASE_URL: 'postgresql://user:pass@localhost:5432/alpha8',
  REDIS_URL: 'redis://localhost:6379',
};

describe('Environment Validation', () => {
  test('should parse valid environment with all required fields', () => {
    const result = envSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.KITE_API_KEY).toBe('test_api_key');
      expect(result.data.DATABASE_URL).toBe('postgresql://user:pass@localhost:5432/alpha8');
    }
  });

  test('should apply default values for optional fields', () => {
    const result = envSchema.safeParse(VALID_ENV);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.NODE_ENV).toBe('development');
      expect(result.data.PORT).toBe(3000);
      expect(result.data.TRADING_CAPITAL).toBe(100000);
      expect(result.data.LIVE_TRADING).toBe(false);
      expect(result.data.MAX_DAILY_LOSS_PCT).toBe(2);
      expect(result.data.MAX_POSITION_COUNT).toBe(5);
      expect(result.data.PER_TRADE_STOP_LOSS_PCT).toBe(1);
      expect(result.data.KILL_SWITCH_DRAWDOWN_PCT).toBe(5);
    }
  });

  test('should fail when KITE_API_KEY is missing', () => {
    const { KITE_API_KEY, ...envWithout } = VALID_ENV;
    const result = envSchema.safeParse(envWithout);
    expect(result.success).toBe(false);
  });

  test('should fail when DATABASE_URL is invalid', () => {
    const result = envSchema.safeParse({
      ...VALID_ENV,
      DATABASE_URL: 'not-a-url',
    });
    expect(result.success).toBe(false);
  });

  test('should fail when NODE_ENV is invalid', () => {
    const result = envSchema.safeParse({
      ...VALID_ENV,
      NODE_ENV: 'staging',
    });
    expect(result.success).toBe(false);
  });

  test('should coerce PORT from string to number', () => {
    const result = envSchema.safeParse({
      ...VALID_ENV,
      PORT: '8080',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.PORT).toBe(8080);
    }
  });

  test('should transform LIVE_TRADING string to boolean', () => {
    const resultTrue = envSchema.safeParse({ ...VALID_ENV, LIVE_TRADING: 'true' });
    expect(resultTrue.success).toBe(true);
    if (resultTrue.success) expect(resultTrue.data.LIVE_TRADING).toBe(true);

    const resultFalse = envSchema.safeParse({ ...VALID_ENV, LIVE_TRADING: 'false' });
    expect(resultFalse.success).toBe(true);
    if (resultFalse.success) expect(resultFalse.data.LIVE_TRADING).toBe(false);
  });

  test('should reject negative TRADING_CAPITAL', () => {
    const result = envSchema.safeParse({
      ...VALID_ENV,
      TRADING_CAPITAL: '-5000',
    });
    expect(result.success).toBe(false);
  });

  test('should reject MAX_DAILY_LOSS_PCT over 100', () => {
    const result = envSchema.safeParse({
      ...VALID_ENV,
      MAX_DAILY_LOSS_PCT: '150',
    });
    expect(result.success).toBe(false);
  });
});
