const { randomUUID } = require('crypto');
const config = require('./config');
const db = require('./db');
const { getRedis } = require('./redis-client');
const { STATES } = require('./job-states');
const { validateCron, nextRun } = require('./cron');
const { ValidationError } = require('./errors');

const toApi = (row) => row && {
  id: row.id,
  type: row.type,
  queue: row.queue,
  priority: row.priority,
  status: row.status,
  payload: row.payload,
  result: row.result,
  attempts: row.attempts,
  maxAttempts: row.max_attempts,
  timeoutMs: row.timeout_ms,
  runAt: row.run_at,
  lastError: row.last_error,
  idempotencyKey: row.idempotency_key,
  scheduleName: row.schedule_name,
  lockedBy: row.locked_by,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  startedAt: row.started_at,
  finishedAt: row.finished_at,
};

// After a commit, tell the scheduler's relay there is new outbox work so it publishes
// within milliseconds instead of on its next poll. It's only a hint (the relay still
// polls), so it goes over Redis pub/sub: Postgres NOTIFY would be transactional but takes
// a global lock at commit, which serialised job creation and cut ingest throughput ~3x.
// Signals are coalesced to at most one per event-loop turn per process.
const OUTBOX_CHANNEL = `${config.keyPrefix}:outbox`;
let signalScheduled = false;
const signalOutbox = () => {
  if (signalScheduled) return;
  signalScheduled = true;
  setImmediate(() => {
    signalScheduled = false;
    const redis = getRedis();
    // Skip while disconnected: ioredis would otherwise buffer every signal in memory.
    if (redis.status === 'ready') redis.publish(OUTBOX_CHANNEL, '1').catch(() => {});
  });
};

/**
 * Insert a job and its outbox row using the caller's transaction. Nothing touches
 * Redis here: the relay publishes the outbox row once this transaction commits, so a
 * job is never half-created (row in Postgres but missing from the queue, or vice versa).
 */
const insertJob = async (client, spec) => {
  const id = randomUUID();
  // "Now" comes from Postgres, not this process, so app-server clock skew can't make an
  // immediate job look future-dated.
  const runAt = spec.runAt || null;
  const { rows } = await client.query(
    `INSERT INTO jobs (id, type, payload, queue, priority, idempotency_key, max_attempts,
                       timeout_ms, run_at, schedule_name, status)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, COALESCE($9::timestamptz, now()), $10,
             CASE WHEN $9::timestamptz > now() THEN 'SCHEDULED' ELSE 'QUEUED' END)
     ON CONFLICT (idempotency_key) WHERE idempotency_key IS NOT NULL DO NOTHING
     RETURNING *`,
    [id, spec.type, JSON.stringify(spec.payload), spec.queue, spec.priority,
      spec.idempotencyKey || null, spec.maxAttempts, spec.timeoutMs, runAt, spec.scheduleName || null],
  );

  if (rows.length === 0) {
    const existing = await client.query('SELECT * FROM jobs WHERE idempotency_key = $1', [spec.idempotencyKey]);
    return { job: existing.rows[0], created: false };
  }

  await client.query('INSERT INTO outbox (job_id, available_at) VALUES ($1, $2)', [id, rows[0].run_at]);
  return { job: rows[0], created: true };
};

const createJob = async (spec) => {
  const res = await db.withTransaction((client) => insertJob(client, spec));
  if (res.created) signalOutbox();
  return { job: toApi(res.job), created: res.created };
};

// All-or-nothing bulk enqueue in a single transaction.
const createJobs = async (specs) => {
  const results = await db.withTransaction(async (client) => {
    const out = [];
    for (const spec of specs) out.push(await insertJob(client, spec));
    return out;
  });
  signalOutbox();
  return results.map((r) => ({ job: toApi(r.job), created: r.created }));
};

const getJob = async (id) => {
  const { rows } = await db.pool.query('SELECT * FROM jobs WHERE id = $1', [id]);
  return toApi(rows[0]);
};

const encodeCursor = (row) => Buffer.from(`${row.created_at.toISOString()}|${row.id}`).toString('base64url');
const decodeCursor = (cursor) => {
  const [createdAt, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  if (!id || Number.isNaN(new Date(createdAt).getTime())) throw new ValidationError('Invalid cursor');
  return { createdAt, id };
};

// Keyset pagination (newest first): stable and O(limit) regardless of page depth,
// unlike OFFSET which rescans every skipped row.
const listJobs = async ({ status, queue, type, limit = 50, cursor } = {}) => {
  const where = [];
  const params = [];
  const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };

  if (status) add('status = ?', status);
  if (queue) add('queue = ?', queue);
  if (type) add('type = ?', type);
  if (cursor) {
    const c = decodeCursor(cursor);
    params.push(c.createdAt, c.id);
    where.push(`(created_at, id) < ($${params.length - 1}, $${params.length})`);
  }
  params.push(Math.min(Math.max(limit, 1), 100));

  const { rows } = await db.pool.query(
    `SELECT * FROM jobs ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY created_at DESC, id DESC LIMIT $${params.length}`,
    params,
  );
  const last = rows[rows.length - 1];
  return {
    jobs: rows.map(toApi),
    nextCursor: rows.length === params[params.length - 1] && last ? encodeCursor(last) : null,
  };
};

/**
 * Cancel a non-terminal job. A queued/delayed copy may still be in Redis; workers check
 * the status in Postgres before running and skip it. A RUNNING job is aborted
 * cooperatively at its next heartbeat.
 * Returns { job, cancelled }: job null = not found.
 */
const cancelJob = async (id) => db.withTransaction(async (client) => {
  const { rows } = await client.query(
    `UPDATE jobs SET status = 'CANCELLED', finished_at = now(), updated_at = now(), locked_by = NULL
     WHERE id = $1 AND status IN ('SCHEDULED', 'QUEUED', 'RETRYING', 'RUNNING') RETURNING *`,
    [id],
  );
  if (rows.length === 0) {
    const existing = await client.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return { job: toApi(existing.rows[0]), cancelled: false };
  }
  await client.query('DELETE FROM outbox WHERE job_id = $1', [id]);
  return { job: toApi(rows[0]), cancelled: true };
});

const REPLAY_SET = `status = 'QUEUED', attempts = 0, run_at = now(), result = NULL,
  finished_at = NULL, started_at = NULL, locked_by = NULL, updated_at = now()`;

// Re-run a DEAD or CANCELLED job from scratch.
const replayJob = async (id) => {
  const res = await replayJobTx(id);
  if (res.replayed) signalOutbox();
  return res;
};
const replayJobTx = (id) => db.withTransaction(async (client) => {
  const { rows } = await client.query(
    `UPDATE jobs SET ${REPLAY_SET} WHERE id = $1 AND status IN ('DEAD', 'CANCELLED') RETURNING *`,
    [id],
  );
  if (rows.length === 0) {
    const existing = await client.query('SELECT * FROM jobs WHERE id = $1', [id]);
    return { job: toApi(existing.rows[0]), replayed: false };
  }
  await client.query('INSERT INTO outbox (job_id) VALUES ($1)', [id]);
  return { job: toApi(rows[0]), replayed: true };
});

// Bulk DLQ replay, e.g. after fixing the bug that killed a batch of jobs.
const replayDead = async ({ queue, type, limit = 100 } = {}) => {
  const { rows } = await db.pool.query(
    `WITH picked AS (
       SELECT id FROM jobs
       WHERE status = 'DEAD' AND ($1::text IS NULL OR queue = $1) AND ($2::text IS NULL OR type = $2)
       ORDER BY finished_at LIMIT $3 FOR UPDATE SKIP LOCKED
     ), replayed AS (
       UPDATE jobs SET ${REPLAY_SET} WHERE id IN (SELECT id FROM picked) RETURNING id
     )
     INSERT INTO outbox (job_id) SELECT id FROM replayed RETURNING job_id`,
    [queue || null, type || null, Math.min(limit, 1000)],
  );
  if (rows.length) signalOutbox();
  return rows.map((r) => r.job_id);
};

const countByStatus = async () => {
  const { rows } = await db.pool.query(
    `SELECT queue, status, count(*)::int AS count FROM jobs GROUP BY queue, status`,
  );
  return rows;
};

const outboxBacklog = async () => {
  const { rows } = await db.pool.query(
    `SELECT count(*) FILTER (WHERE available_at <= now())::int AS ready,
            count(*) FILTER (WHERE available_at > now())::int AS scheduled
     FROM outbox`,
  );
  return rows[0];
};

// ---- Cron schedules ----

const scheduleToApi = (row) => row && {
  name: row.name,
  cron: row.cron,
  timezone: row.timezone,
  type: row.type,
  payload: row.payload,
  queue: row.queue,
  priority: row.priority,
  maxAttempts: row.max_attempts,
  timeoutMs: row.timeout_ms,
  enabled: row.enabled,
  nextRunAt: row.next_run_at,
  lastRunAt: row.last_run_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
};

const upsertSchedule = async (spec) => {
  const next = validateCron(spec.cron, spec.timezone);
  const { rows } = await db.pool.query(
    `INSERT INTO cron_schedules (name, cron, timezone, type, payload, queue, priority,
                                 max_attempts, timeout_ms, enabled, next_run_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     ON CONFLICT (name) DO UPDATE SET
       cron = EXCLUDED.cron, timezone = EXCLUDED.timezone, type = EXCLUDED.type,
       payload = EXCLUDED.payload, queue = EXCLUDED.queue, priority = EXCLUDED.priority,
       max_attempts = EXCLUDED.max_attempts, timeout_ms = EXCLUDED.timeout_ms,
       enabled = EXCLUDED.enabled, next_run_at = EXCLUDED.next_run_at, updated_at = now()
     RETURNING *`,
    [spec.name, spec.cron, spec.timezone, spec.type, JSON.stringify(spec.payload), spec.queue,
      spec.priority, spec.maxAttempts, spec.timeoutMs, spec.enabled, next],
  );
  return scheduleToApi(rows[0]);
};

const listSchedules = async () => {
  const { rows } = await db.pool.query('SELECT * FROM cron_schedules ORDER BY name');
  return rows.map(scheduleToApi);
};

const deleteSchedule = async (name) => {
  const { rowCount } = await db.pool.query('DELETE FROM cron_schedules WHERE name = $1', [name]);
  return rowCount > 0;
};

module.exports = {
  OUTBOX_CHANNEL,
  STATES,
  toApi,
  insertJob,
  createJob,
  createJobs,
  getJob,
  listJobs,
  cancelJob,
  replayJob,
  replayDead,
  countByStatus,
  outboxBacklog,
  upsertSchedule,
  listSchedules,
  deleteSchedule,
  nextRun,
  scheduleToApi,
};
