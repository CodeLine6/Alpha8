import { createLogger } from './logger.js';

const log = createLogger('shutdown');

/**
 * Graceful shutdown manager.
 * Modules register cleanup callbacks (e.g., close DB pool, flush logs).
 * On SIGTERM/SIGINT, all callbacks are executed in LIFO order before exit.
 *
 * Usage:
 *   import { registerShutdown } from './shutdown.js';
 *   registerShutdown('database', async () => { await pool.end(); });
 *
 * @module shutdown
 */

/** @type {Array<{ name: string, handler: () => Promise<void> }>} */
const shutdownHandlers = [];

/** @type {boolean} */
let isShuttingDown = false;

/**
 * Register a cleanup callback to run on shutdown.
 * @param {string} name - Human-readable name for logging (e.g. 'database', 'redis')
 * @param {() => Promise<void>} handler - Async cleanup function
 */
export function registerShutdown(name, handler) {
  shutdownHandlers.push({ name, handler });
  log.debug({ name }, 'Shutdown handler registered');
}

/**
 * Execute all shutdown handlers and exit.
 * @param {string} signal - The signal that triggered shutdown
 */
async function performShutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  log.info({ signal }, '🛑 Shutdown initiated');

  // Execute in reverse registration order (LIFO)
  const reversed = [...shutdownHandlers].reverse();

  for (const { name, handler } of reversed) {
    try {
      log.info({ name }, `Cleaning up: ${name}`);
      await handler();
      log.info({ name }, `✅ ${name} cleaned up`);
    } catch (err) {
      log.error({ name, err }, `❌ Failed to clean up: ${name}`);
    }
  }

  log.info('Shutdown complete. Goodbye.');
  process.exit(0);
}

/**
 * Initialize signal listeners. Call once at app startup.
 */
export function initShutdownHandlers() {
  process.on('SIGTERM', () => performShutdown('SIGTERM'));
  process.on('SIGINT', () => performShutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log.fatal({ err }, 'Uncaught exception — initiating shutdown');
    performShutdown('uncaughtException');
  });
  process.on('unhandledRejection', (reason) => {
    log.fatal({ reason }, 'Unhandled rejection — initiating shutdown');
    performShutdown('unhandledRejection');
  });
  log.debug('Shutdown signal listeners registered');
}
