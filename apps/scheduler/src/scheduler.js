require('dotenv').config();
process.env.SERVICE_NAME ||= 'scheduler';

const { config, db, logger, Scheduler, QueueManager, closeRedis, metrics, jobs } = require('@scheduler/core');

const { client, register } = metrics;

// Queue depth gauges are computed when Prometheus scrapes, from Redis and Postgres.
const registerQueueGauges = (queueManager) => {
  const labelNames = ['queue', 'lane'];
  const gauges = {
    lag: new client.Gauge({ name: 'queue_lag', help: 'Messages not yet delivered', labelNames }),
    pending: new client.Gauge({ name: 'queue_pending', help: 'Delivered, not yet acked', labelNames }),
    delayed: new client.Gauge({ name: 'queue_delayed', help: 'Waiting for retry backoff', labelNames }),
    dlq: new client.Gauge({ name: 'queue_dlq_length', help: 'Entries in dead letter streams', labelNames }),
  };
  const outboxGauge = new client.Gauge({ name: 'outbox_backlog', help: 'Outbox rows', labelNames: ['state'] });

  // Collect everything in one gauge's collect() so a scrape hits Redis once.
  gauges.lag.collect = async () => {
    const totals = {};
    for (const s of await queueManager.streamStats()) {
      const k = `${s.queue}|${s.lane}`;
      totals[k] ||= { queue: s.queue, lane: s.lane, lag: 0, pending: 0, delayed: 0, dlq: 0 };
      for (const f of ['lag', 'pending', 'delayed', 'dlq']) totals[k][f] += s[f];
    }
    for (const t of Object.values(totals)) {
      for (const f of ['lag', 'pending', 'delayed', 'dlq']) gauges[f].set({ queue: t.queue, lane: t.lane }, t[f]);
    }
    const outbox = await jobs.outboxBacklog();
    outboxGauge.set({ state: 'ready' }, outbox.ready);
    outboxGauge.set({ state: 'scheduled' }, outbox.scheduled);
  };
  return register;
};

const main = async () => {
  metrics.startDefaultMetrics();
  await db.migrate();

  const queueManager = new QueueManager();
  const scheduler = new Scheduler({ queueManager });
  await scheduler.start();
  registerQueueGauges(queueManager);
  const server = metrics.startMetricsServer(config.scheduler.metricsPort);

  const shutdown = async (signal) => {
    logger.info({ signal }, 'shutting down');
    await scheduler.stop();
    server.close();
    await Promise.allSettled([db.pool.end(), closeRedis()]);
    process.exit(0);
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((err) => {
  logger.fatal({ err }, 'scheduler failed to start');
  process.exit(1);
});
