require('dotenv').config();
process.env.SERVICE_NAME ||= 'worker';

const { config, db, logger, Worker, closeRedis, getRedis, metrics } = require('@scheduler/core');
const handlers = require('./handlers');

const main = async () => {
  metrics.startDefaultMetrics();
  await db.migrate();

  const worker = new Worker({ handlers });
  await worker.start();

  const server = metrics.startMetricsServer(config.worker.metricsPort, {
    onHealth: async () => {
      await getRedis().ping();
      return worker.running;
    },
  });

  let stopping = false;
  const shutdown = async (signal) => {
    if (stopping) return;
    stopping = true;
    logger.info({ signal }, 'draining in-flight jobs');
    await worker.stop();
    server.close();
    await Promise.allSettled([db.pool.end(), closeRedis()]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((err) => {
  logger.fatal({ err }, 'worker failed to start');
  process.exit(1);
});
