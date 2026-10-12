require('dotenv').config();
process.env.SERVICE_NAME ||= 'api';

const { config, db, logger, QueueManager, closeRedis, metrics } = require('@scheduler/core');
const createApp = require('./app');
const Backpressure = require('./backpressure');

const main = async () => {
  metrics.startDefaultMetrics();
  await db.migrate();

  const queueManager = new QueueManager();
  const backpressure = new Backpressure({ queueManager });
  backpressure.start();

  if (config.api.apiKeys.length === 0) logger.warn('API_KEYS not set: authentication is DISABLED');

  const app = createApp({ queueManager, backpressure });
  const server = app.listen(config.api.port, () => logger.info({ port: config.api.port }, 'API listening'));

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    backpressure.stop();
    server.close(async () => {
      await Promise.allSettled([db.pool.end(), closeRedis()]);
      process.exit(0);
    });
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((err) => {
  logger.fatal({ err }, 'API failed to start');
  process.exit(1);
});
