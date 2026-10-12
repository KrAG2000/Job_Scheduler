const http = require('http');
const client = require('prom-client');
const logger = require('./logger');

const register = client.register;
let defaultsStarted = false;

const startDefaultMetrics = () => {
  if (defaultsStarted) return;
  defaultsStarted = true;
  client.collectDefaultMetrics({ register });
};

const metric = (Type, name, help, labelNames = [], extra = {}) =>
  register.getSingleMetric(name) || new Type({ name, help, labelNames, ...extra });

const LATENCY_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300];

const m = {
  // API
  httpRequests: metric(client.Counter, 'http_requests_total', 'HTTP requests', ['service', 'method', 'route', 'status']),
  httpDuration: metric(client.Histogram, 'http_request_duration_seconds', 'HTTP latency', ['service', 'method', 'route'], { buckets: LATENCY_BUCKETS }),
  jobsCreated: metric(client.Counter, 'jobs_created_total', 'Jobs accepted', ['queue', 'type']),
  jobsRejected: metric(client.Counter, 'jobs_rejected_total', 'Jobs rejected before enqueue', ['reason']),

  // Worker
  jobsProcessed: metric(client.Counter, 'jobs_processed_total', 'Job attempts by outcome', ['queue', 'type', 'outcome']),
  jobDuration: metric(client.Histogram, 'job_duration_seconds', 'Handler execution time', ['queue', 'type'], { buckets: LATENCY_BUCKETS }),
  jobQueueLatency: metric(client.Histogram, 'job_queue_latency_seconds', 'Time from enqueue to start', ['queue', 'lane'], { buckets: LATENCY_BUCKETS }),
  jobsInFlight: metric(client.Gauge, 'worker_jobs_in_flight', 'Jobs currently executing'),
  jobsReclaimed: metric(client.Counter, 'jobs_reclaimed_total', 'Messages taken over from dead/slow consumers', ['queue']),
  jobsSkipped: metric(client.Counter, 'jobs_skipped_total', 'Deliveries skipped (duplicate, cancelled, finished)', ['queue', 'reason']),
  jobsPromoted: metric(client.Counter, 'jobs_promoted_total', 'Retries moved from delayed set to stream', ['queue']),
  leaseLost: metric(client.Counter, 'job_lease_lost_total', 'Jobs whose lease was lost mid-execution', ['queue']),

  // Scheduler
  outboxRelayed: metric(client.Counter, 'outbox_relayed_total', 'Outbox rows published to Redis'),
  cronFired: metric(client.Counter, 'cron_fired_total', 'Cron schedule executions', ['schedule']),
  sweeperRequeued: metric(client.Counter, 'sweeper_requeued_total', 'Stuck jobs re-published', ['status']),
  streamTrimmed: metric(client.Counter, 'stream_entries_trimmed_total', 'Acked stream entries removed'),
};

// Serve /metrics for processes without an HTTP server of their own (worker, scheduler).
const startMetricsServer = (port, { onHealth } = {}) => {
  const server = http.createServer(async (req, res) => {
    if (req.url === '/metrics') {
      try {
        res.setHeader('Content-Type', register.contentType);
        res.end(await register.metrics());
      } catch (err) {
        res.statusCode = 500;
        res.end(err.message);
      }
      return;
    }
    if (req.url === '/healthz') {
      const healthy = onHealth ? await onHealth().catch(() => false) : true;
      res.statusCode = healthy ? 200 : 503;
      res.end(healthy ? 'ok' : 'unhealthy');
      return;
    }
    res.statusCode = 404;
    res.end();
  });
  server.listen(port, () => logger.info({ port }, 'metrics server listening'));
  return server;
};

module.exports = { client, register, metrics: m, startDefaultMetrics, startMetricsServer };
