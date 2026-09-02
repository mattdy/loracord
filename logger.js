'use strict';

const pino = require('pino');

const LEVELS = ['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent'];

const requested = process.env.LOG_LEVEL?.toLowerCase();
const level = LEVELS.includes(requested) ? requested : 'info';

// Pretty output for local development; raw JSON lines in production so the
// Docker json-file driver (and anything downstream) gets structured records.
function prettyAvailable() {
  if (process.env.NODE_ENV === 'production') return false;
  try {
    require.resolve('pino-pretty');
    return true;
  } catch {
    return false;
  }
}

const logger = pino({
  level,
  // Single-process container — pid/hostname are just noise
  base: undefined,
  transport: prettyAvailable()
    ? {
        target: 'pino-pretty',
        options: {
          translateTime: 'SYS:yyyy-mm-dd HH:MM:ss',
          ignore: 'component',
          messageFormat: '[{component}] {msg}',
          colorize: true,
        },
      }
    : undefined,
});

module.exports = logger;
