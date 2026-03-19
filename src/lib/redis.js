import Redis from 'ioredis';
import { createLogger } from './logger.js';
import { registerShutdown } from './shutdown.js';
import { normalizeRedisUrl } from './redis-utils.js';

const log = createLogger('redis');

/** @type {Redis | null} */
let redisClient = null;

/**
 * BUG #21 FIX: Guard flag prevents registerShutdown() being pushed onto the
 * shutdownHandlers array a second time if initRedis() is ever called more than
 * once (e.g. in tests, or after a reconnection attempt). Without this guard,
 * each extra call adds another handler, and on process shutdown redisClient.quit()
 * is invoked multiple times on the same connection — the second call throws
 * "Connection is closed" and pollutes the shutdown log.
 */
let _shutdownRegistered = false;

/**
 * Initialize the Redis client with reconnect strategy and namespace prefix.
 * @param {string} url - Redis connection URL
 * @returns {Redis} The Redis client instance
 */
export function initRedis(url) {
  // Auto-upgrade Upstash connections to use TLS (rediss://)
  url = normalizeRedisUrl(url);

  const options = {
    keyPrefix: 'alpha8:',
    maxRetriesPerRequest: 3,
    family: 4, // Force IPv4 to prevent Render/Upstash disconnect loops
    retryStrategy(times) {
      const delay = Math.min(times * 200, 5000);
      log.warn({ attempt: times, delayMs: delay }, 'Redis reconnecting...');
      return delay;
    },
    lazyConnect: true,
  };

  redisClient = new Redis(url, options);

  redisClient.on('connect', () => {
    log.info('Redis connected');
  });

  redisClient.on('error', (err) => {
    log.error({ err }, 'Redis connection error');
  });

  redisClient.on('close', () => {
    log.warn('Redis connection closed');
  });

  // BUG #21 FIX: Only register the shutdown handler once, no matter how many
  // times initRedis() is called. Previously each call pushed a new handler onto
  // the array, causing quit() to be called twice on the same client on shutdown.
  if (!_shutdownRegistered) {
    registerShutdown('redis', async () => {
      if (redisClient) {
        await redisClient.quit();
        log.info('Redis client disconnected');
      }
    });
    _shutdownRegistered = true;
  }

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
 * @param {string} key - Cache key (auto-prefixed with 'alpha8:')
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
 *
 * BUG #7 FIX (from first review pass): wraps JSON.parse in try/catch so a
 * corrupted or partially-written Redis value never throws an uncaught
 * SyntaxError up through callers like killSwitch.loadFromRedis().
 *
 * @param {string} key - Cache key (auto-prefixed with 'alpha8:')
 * @returns {Promise<any | null>} Parsed value or null if not found / malformed
 */
export async function cacheGet(key) {
  const redis = getRedis();
  const data = await redis.get(key);
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch (err) {
    log.error({ key, err: err.message },
      'cacheGet: malformed JSON in Redis — returning null. Consider flushing this key.');
    return null;
  }
}