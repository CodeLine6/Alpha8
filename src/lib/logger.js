import pino from 'pino';

/**
 * Root application logger using Pino.
 * Uses JSON format in production; pretty-prints in development.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('risk');
 *   log.info({ event: 'stop_loss_triggered' }, 'Position closed');
 *
 * @module logger
 */

const isProduction = process.env.NODE_ENV === 'production';

/** Root Pino logger instance */
const rootLogger = pino({
  level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
  ...(isProduction
    ? {}
    : {
        transport: {
          target: 'pino-pretty',
          options: {
            colorize: true,
            translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
            ignore: 'pid,hostname',
          },
        },
      }),
  base: {
    app: 'quant8',
    env: process.env.NODE_ENV || 'development',
  },
});

/**
 * Create a child logger scoped to a specific module.
 * @param {string} moduleName - Name of the module (e.g. 'risk', 'execution', 'strategy')
 * @returns {pino.Logger} Scoped child logger
 */
export function createLogger(moduleName) {
  return rootLogger.child({ module: moduleName });
}

export { rootLogger as logger };
