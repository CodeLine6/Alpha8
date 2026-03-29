import pino from 'pino';

/**
 * Root application logger using Pino.
 * Uses JSON format in production; pretty-prints in development.
 * In simulator mode (SIM_URL set), also writes JSON logs to logs/sim-YYYY-MM-DD.log.
 *
 * Usage:
 *   import { createLogger } from './logger.js';
 *   const log = createLogger('risk');
 *   log.info({ event: 'stop_loss_triggered' }, 'Position closed');
 *
 * @module logger
 */

const isProduction = process.env.NODE_ENV === 'production';
const isSimMode = !!process.env.SIM_URL;

function buildTransport() {
  const prettyTarget = {
    target: 'pino-pretty',
    options: {
      colorize: true,
      translateTime: 'SYS:yyyy-mm-dd HH:MM:ss.l',
      ignore: 'pid,hostname',
    },
  };

  if (isSimMode) {
    const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
    return pino.transport({
      targets: [
        prettyTarget,
        {
          target: 'pino/file',
          options: { destination: `logs/sim-${date}.log`, mkdir: true },
        },
      ],
    });
  }

  if (!isProduction) {
    return pino.transport(prettyTarget);
  }

  return undefined; // production: default pino JSON to stdout
}

/** Root Pino logger instance */
const rootLogger = pino(
  {
    level: process.env.LOG_LEVEL || (isProduction ? 'info' : 'debug'),
    base: {
      app: 'alpha8',
      env: process.env.NODE_ENV || 'development',
    },
  },
  buildTransport(),
);

/**
 * Create a child logger scoped to a specific module.
 * @param {string} moduleName - Name of the module (e.g. 'risk', 'execution', 'strategy')
 * @returns {pino.Logger} Scoped child logger
 */
export function createLogger(moduleName) {
  return rootLogger.child({ module: moduleName });
}

export { rootLogger as logger };
