require('dotenv').config();
process.env.SERVICE_NAME ||= 'tracker-api';

const express = require('express');
const cors = require('cors');
const { config, db, logger, jobs, rateLimiter, closeRedis, metrics } = require('@scheduler/core');

const port = parseInt(process.env.TRACKER_PORT || '3001', 10);
const SITE_CACHE_TTL_MS = 60 * 1000;
const EVENT_TYPE_RE = /^[A-Za-z0-9_.:-]{1,50}$/;

const app = express();
app.set('trust proxy', config.api.trustProxy); // only trust X-Forwarded-For behind our own proxy
app.disable('x-powered-by');
app.use(cors());
app.use(express.json({ limit: '16kb' }));

// API key -> site id, with a TTL so revoked keys stop working within a minute.
const siteCache = new Map();

const validateApiKey = async (req, res, next) => {
  const apiKey = req.get('x-api-key');
  if (!apiKey) return res.status(401).json({ error: 'Missing API Key' });

  const cached = siteCache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    req.siteId = cached.siteId;
    return next();
  }

  try {
    const result = await db.pool.query('SELECT id FROM sites WHERE api_key = $1', [apiKey]);
    if (result.rows.length === 0) return res.status(401).json({ error: 'Invalid API Key' });
    req.siteId = result.rows[0].id;
    siteCache.set(apiKey, { siteId: req.siteId, expiresAt: Date.now() + SITE_CACHE_TTL_MS });
    return next();
  } catch (err) {
    logger.error({ err }, 'auth lookup failed');
    return res.status(500).json({ error: 'Internal Server Error' });
  }
};

const perSiteRateLimit = async (req, res, next) => {
  try {
    const { allowed, retryAfterMs } = await rateLimiter.consume(`site:${req.siteId}`);
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return res.status(429).json({ error: 'Rate limit exceeded' });
    }
  } catch (err) {
    logger.warn({ err }, 'rate limiter unavailable, allowing request');
  }
  return next();
};

app.get('/healthz', (req, res) => res.json({ status: 'ok' }));
app.get('/metrics', async (req, res) => {
  res.set('Content-Type', metrics.register.contentType);
  res.end(await metrics.register.metrics());
});

app.post('/track', validateApiKey, perSiteRateLimit, async (req, res) => {
  const { type, data, eventId } = req.body || {};
  if (typeof type !== 'string' || !EVENT_TYPE_RE.test(type)) {
    return res.status(400).json({ error: 'Missing or invalid event type' });
  }

  try {
    // Same durable path as every other job: Postgres row + outbox in one transaction.
    // The client-generated eventId makes browser retries idempotent.
    await jobs.createJob({
      type: 'process_analytics_event',
      queue: 'analytics',
      priority: 'low',
      maxAttempts: config.jobDefaults.maxAttempts,
      timeoutMs: 10000,
      idempotencyKey: typeof eventId === 'string' && eventId.length <= 100 ? `track:${req.siteId}:${eventId}` : undefined,
      payload: {
        siteId: req.siteId,
        eventType: type,
        data: data && typeof data === 'object' ? data : {},
        ipAddress: req.ip,
        userAgent: req.get('user-agent'),
        timestamp: new Date().toISOString(),
      },
    });
    metrics.metrics.jobsCreated.inc({ queue: 'analytics', type: 'process_analytics_event' });
    return res.status(202).json({ status: 'accepted' });
  } catch (err) {
    logger.error({ err }, 'failed to queue analytics event');
    return res.status(500).json({ error: 'Failed to queue event' });
  }
});

const main = async () => {
  metrics.startDefaultMetrics();
  await db.migrate();
  const server = app.listen(port, () => logger.info({ port }, 'tracker API listening'));
  const shutdown = () => server.close(async () => {
    await Promise.allSettled([db.pool.end(), closeRedis()]);
    process.exit(0);
  });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
};

main().catch((err) => {
  logger.fatal({ err }, 'tracker API failed to start');
  process.exit(1);
});
