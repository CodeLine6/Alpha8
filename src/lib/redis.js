import Redis from 'ioredis';
import { createLogger } from './logger.js';
import { registerShutdown } from './shutdown.js';

const log = createLogger('redis');

/** @type {Redis | null} */
let redisClient = null;

/**
 * Initialize the Redis client with reconnect strategy and namespace prefix.
 * @param {string} url - Redis connection URL
 * @returns {Redis} The Redis client instance
 */
export function initRedis(url) {
  redisClient = new Redis(url, {
    keyPrefix: 'quant8:',
    maxRetriesPerRequest: 3,
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      log.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting...');
      return delay;
    },
    lazyConnect: true,
  });

  redisClient.on('connect', () => {
    log.info('Redis connected');
  });

  redisClient.on('error', (err) => {
    log.error({ err }, 'Redis connection error');
  });

  redisClient.on('close', () => {
    log.warn('Redis connection closed');
  });

  // Register for graceful shutdown
  registerShutdown('redis', async () => {
    if (redisClient) {
      await redisClient.quit();
      log.info('Redis client disconnected');
    }
  });

  return redisClient;
}

/**
 * Get the active Redis client.
 * @throws {Error} If client has not been initialized
 * @returns {Redis}
 */
export function getRedis() {
  if (!redisClient) {
    throw new Error('Redis client not initialized. Call initRedis() first.');
  }
  return redisClient;
}

/**
 * Check Redis connectivity.
 * @returns {Promise<boolean>} True if connection is healthy
 */
export async function checkRedisHealth() {
  try {
    const pong = await getRedis().ping();
    return pong === 'PONG';
  } catch (err) {
    log.error({ err }, 'Redis health check failed');
    return false;
  }
}

/**
 * Cache a value with optional TTL.
 * @param {string} key - Cache key (auto-prefixed with 'quant8:')
 * @param {any} value - Value to cache (will be JSON-stringified)
 * @param {number} [ttlSeconds] - Optional TTL in seconds
 */
export async function cacheSet(key, value, ttlSeconds) {
  const redis = getRedis();
  const serialized = JSON.stringify(value);
  if (ttlSeconds) {
    await redis.set(key, serialized, 'EX', ttlSeconds);
  } else {
    await redis.set(key, serialized);
  }
}

/**
 * Retrieve a cached value.
 * @param {string} key - Cache key (auto-prefixed with 'quant8:')
 * @returns {Promise<any | null>} Parsed value or null if not found
 */
export async function cacheGet(key) {
  const redis = getRedis();
  const data = await redis.get(key);
  return data ? JSON.parse(data) : null;
}
