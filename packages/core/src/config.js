// Central configuration. Every service reads from here so that the API, workers and
// scheduler agree on queue names, partition counts and key layout.
const int = (value, fallback) => (value === undefined || value === '' ? fallback : parseInt(value, 10));
const list = (value, fallback) => (value ? value.split(',').map((s) => s.trim()).filter(Boolean) : fallback);

const env = process.env;

module.exports = {
  keyPrefix: env.KEY_PREFIX || 'sched',
  // Each (queue, priority lane) is split into N Redis Streams so load can spread across
  // Redis Cluster shards. Changing this is safe: workers read every partition.
  partitions: int(env.QUEUE_PARTITIONS, 4),
  queues: list(env.QUEUES, ['default', 'analytics']),
  lanes: ['high', 'normal', 'low'],
  group: env.CONSUMER_GROUP || 'workers',

  redis: {
    url: env.REDIS_URL,
    host: env.REDIS_HOST || 'localhost',
    port: int(env.REDIS_PORT, 6379),
    // HA mode: "host1:26379,host2:26379" + master name
    sentinels: list(env.REDIS_SENTINELS, []).map((s) => {
      const [host, port] = s.split(':');
      return { host, port: int(port, 26379) };
    }),
    masterName: env.REDIS_MASTER_NAME || 'mymaster',
  },

  db: {
    connectionString: env.DATABASE_URL,
    host: env.DB_HOST || 'localhost',
    port: int(env.DB_PORT, 5432),
    user: env.DB_USER || 'user',
    password: env.DB_PASSWORD || 'password',
    database: env.DB_NAME || 'scheduler',
    max: int(env.PG_POOL_MAX, 10),
  },

  jobDefaults: {
    maxAttempts: int(env.JOB_MAX_ATTEMPTS, 4), // 1 try + 3 retries
    timeoutMs: int(env.JOB_TIMEOUT_MS, 30000),
  },

  retry: {
    baseMs: int(env.RETRY_BASE_MS, 1000),
    maxMs: int(env.RETRY_MAX_MS, 5 * 60 * 1000),
  },

  worker: {
    queues: list(env.WORKER_QUEUES, null), // null = all queues
    concurrency: int(env.WORKER_CONCURRENCY, 10),
    // A delivered-but-unacked message whose owner has not heartbeated for this long is
    // considered abandoned and is reclaimed by another worker (visibility timeout).
    visibilityTimeoutMs: int(env.VISIBILITY_TIMEOUT_MS, 30000),
    heartbeatMs: int(env.HEARTBEAT_MS, 10000),
    reclaimIntervalMs: int(env.RECLAIM_INTERVAL_MS, 5000),
    promoteIntervalMs: int(env.PROMOTE_INTERVAL_MS, 500),
    pollMinMs: int(env.POLL_MIN_MS, 5),
    pollMaxMs: int(env.POLL_MAX_MS, 250),
    shutdownTimeoutMs: int(env.SHUTDOWN_TIMEOUT_MS, 25000),
    metricsPort: int(env.METRICS_PORT, 9100),
  },

  scheduler: {
    relayIntervalMs: int(env.RELAY_INTERVAL_MS, 200),
    relayBatchSize: int(env.RELAY_BATCH_SIZE, 500),
    cronIntervalMs: int(env.CRON_INTERVAL_MS, 1000),
    sweepIntervalMs: int(env.SWEEP_INTERVAL_MS, 60000),
    // Jobs that sit in QUEUED/RETRYING/RUNNING without progress for this long are
    // re-published from Postgres (covers Redis data loss).
    stuckAfterMs: int(env.STUCK_AFTER_MS, 10 * 60 * 1000),
    maintenanceIntervalMs: int(env.MAINTENANCE_INTERVAL_MS, 30000),
    consumerIdleCleanupMs: int(env.CONSUMER_IDLE_CLEANUP_MS, 60 * 60 * 1000),
    dlqMaxLen: int(env.DLQ_MAX_LEN, 10000),
    metricsPort: int(env.METRICS_PORT, 9101),
  },

  api: {
    port: int(env.API_PORT, 3000),
    apiKeys: list(env.API_KEYS, []),
    bodyLimit: env.BODY_LIMIT || '256kb',
    // Token bucket per API key (or per IP when auth is disabled)
    rateLimitCapacity: int(env.RATE_LIMIT_CAPACITY, 200),
    rateLimitRefillPerSec: int(env.RATE_LIMIT_REFILL_PER_SEC, 100),
    // Reject new jobs for a queue once this many messages are waiting in it
    maxBacklog: int(env.MAX_QUEUE_BACKLOG, 100000),
    trustProxy: env.TRUST_PROXY || false,
  },
};
