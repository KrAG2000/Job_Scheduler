const pino = require('pino');

const logger = pino({
  level: process.env.LOG_LEVEL || 'info',
  base: { service: process.env.SERVICE_NAME || 'scheduler', pid: process.pid },
  timestamp: pino.stdTimeFunctions.isoTime,
});

module.exports = logger;
