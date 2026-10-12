// Integration test harness. Needs Redis + Postgres; by default the ones from
// `docker compose up -d redis postgres`. Override with REDIS_PORT / DB_PORT etc.
// Uses a separate database (scheduler_test) and a unique Redis key prefix per file.
const { randomBytes } = require('crypto');
const { execFileSync } = require('child_process');

process.env.LOG_LEVEL ||= 'silent';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'scheduler_test';
process.env.KEY_PREFIX = `test-${randomBytes(4).toString('hex')}`;
process.env.QUEUE_PARTITIONS ||= '2';
process.env.RETRY_BASE_MS = '50';
process.env.RETRY_MAX_MS = '200';

const ensureDatabase = () => {
  // Run in a child process so the test can stay synchronous at require time.
  execFileSync(process.execPath, ['-e', `
    const { Client } = require('pg');
    const c = new Client({
      host: process.env.DB_HOST || 'localhost', port: process.env.DB_PORT || 5432,
      user: process.env.DB_USER || 'user', password: process.env.DB_PASSWORD || 'password',
      database: 'postgres',
    });
    c.connect()
      .then(() => c.query("SELECT 1 FROM pg_database WHERE datname = $1", [process.env.DB_NAME]))
      .then((r) => r.rowCount ? null : c.query('CREATE DATABASE "' + process.env.DB_NAME + '"'))
      .catch((e) => { if (!/already exists/.test(e.message)) { console.error(e.message); process.exit(1); } })
      .finally(() => c.end());
  `], { stdio: 'inherit' });
};
ensureDatabase();

const core = require('@scheduler/core');

const { db, getRedis, closeRedis, config } = core;

const setup = async () => {
  await db.migrate();
  await db.pool.query(`CREATE TABLE IF NOT EXISTS demo_executions (
    id BIGSERIAL PRIMARY KEY, job_id UUID NOT NULL, attempt INT NOT NULL, worker TEXT,
    at TIMESTAMPTZ NOT NULL DEFAULT now())`);
};

const reset = async () => {
  await db.pool.query('TRUNCATE jobs, outbox, cron_schedules, demo_executions CASCADE');
  const redis = getRedis();
  let cursor = '0';
  do {
    const [next, keys] = await redis.scan(cursor, 'MATCH', `${config.keyPrefix}:*`, 'COUNT', 1000);
    cursor = next;
    if (keys.length) await redis.del(...keys);
  } while (cursor !== '0');
};

const teardown = async () => {
  await reset();
  await db.pool.end();
  await closeRedis();
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const waitFor = async (fn, { timeout = 10000, interval = 50, message = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await fn();
    if (last) return last;
    await sleep(interval);
  }
  throw new Error(`Timed out waiting for ${message} (last: ${JSON.stringify(last)})`);
};

const jobStatus = async (id) => (await core.jobs.getJob(id))?.status;
const waitForStatus = (id, status, opts) =>
  waitFor(async () => ((await jobStatus(id)) === status ? core.jobs.getJob(id) : null),
    { message: `job ${id} -> ${status}`, ...opts });

const spec = (overrides = {}) => core.validateJob({ type: 'demo', payload: { durationMs: 10 }, ...overrides });

const executions = async (jobId) => {
  const { rows } = await db.pool.query('SELECT attempt FROM demo_executions WHERE job_id = $1 ORDER BY at', [jobId]);
  return rows.map((r) => r.attempt);
};

const fastWorkerOptions = {
  promoteIntervalMs: 50,
  reclaimIntervalMs: 200,
  pollMaxMs: 20,
  heartbeatMs: 200,
  visibilityTimeoutMs: 1000,
  shutdownTimeoutMs: 2000,
  retry: { baseMs: 50, maxMs: 200 },
};

const fastSchedulerOptions = {
  relayIntervalMs: 20,
  cronIntervalMs: 50,
  sweepIntervalMs: 100000,
  maintenanceIntervalMs: 100000,
};

module.exports = {
  core, setup, reset, teardown, sleep, waitFor, waitForStatus, jobStatus, spec, executions,
  fastWorkerOptions, fastSchedulerOptions,
};
