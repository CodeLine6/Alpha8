import pg from 'pg';
import { createLogger } from './logger.js';
import { registerShutdown } from './shutdown.js';

const { Pool } = pg;
const log = createLogger('database');

/** @type {pg.Pool | null} */
let pool = null;

/**
 * Initialize the PostgreSQL connection pool.
 * @param {string} connectionString - PostgreSQL connection URL
 * @returns {pg.Pool} The connection pool instance
 */
export function initDatabase(connectionString) {
  pool = new Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30000,
    connectionTimeoutMillis: 5000,
  });

  pool.on('error', (err) => {
    log.error({ err }, 'Unexpected database pool error');
  });

  // Register for graceful shutdown
  registerShutdown('database', async () => {
    if (pool) {
      await pool.end();
      log.info('Database pool closed');
    }
  });

  log.info('PostgreSQL connection pool initialized');
  return pool;
}

/**
 * Get the active database pool.
 * @throws {Error} If pool has not been initialized
 * @returns {pg.Pool}
 */
export function getPool() {
  if (!pool) {
    throw new Error('Database pool not initialized. Call initDatabase() first.');
  }
  return pool;
}

/**
 * Execute a query against the database.
 * @param {string} text - SQL query text
 * @param {any[]} [params] - Query parameters
 * @returns {Promise<pg.QueryResult>}
 */
export async function query(text, params) {
  const start = Date.now();
  const result = await getPool().query(text, params);
  const duration = Date.now() - start;
  log.debug({ query: text, duration, rows: result.rowCount }, 'Query executed');
  return result;
}

/**
 * Check database connectivity.
 * @returns {Promise<boolean>} True if connection is healthy
 */
export async function checkDatabaseHealth() {
  try {
    await getPool().query('SELECT 1');
    return true;
  } catch (err) {
    log.error({ err }, 'Database health check failed');
    return false;
  }
}
