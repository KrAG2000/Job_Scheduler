// Each test here reproduces one failure mode the original implementation got wrong.
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const { fork } = require('child_process');
const {
  core, setup, reset, teardown, sleep, waitFor, waitForStatus, spec, executions,
  fastWorkerOptions, fastSchedulerOptions,
} = require('./helpers');
const handlers = require('../../apps/worker/src/handlers');

const { jobs, Worker, Scheduler, QueueManager, getRedis, db, config } = core;

const cleanups = [];
test.before(setup);
test.beforeEach(reset);
test.afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});
test.after(teardown);

const startScheduler = async (options = {}) => {
  const s = new Scheduler({ options: { ...fastSchedulerOptions, ...options } });
  await s.start();
  cleanups.push(() => s.stop());
  return s;
};
const startWorker = async (options = {}, extra = {}) => {
  const w = new Worker({ handlers, concurrency: 4, options: { ...fastWorkerOptions, ...options }, ...extra });
  await w.start();
  cleanups.push(() => w.stop());
  return w;
};

test('worker killed with SIGKILL mid-job: another worker reclaims and finishes it', async () => {
  await startScheduler();
  const child = fork(path.join(__dirname, 'fixtures/worker-proc.js'), [config.keyPrefix], {
    env: process.env, stdio: 'ignore',
  });
  cleanups.push(() => child.kill('SIGKILL'));
  await new Promise((resolve) => child.once('message', resolve));

  const { job } = await jobs.createJob(spec({ payload: { durationMs: 30000, record: true } }));
  await waitForStatus(job.id, 'RUNNING');
  child.kill('SIGKILL');

  // Survivor reclaims once the message has been idle for visibilityTimeoutMs.
  await startWorker({ visibilityTimeoutMs: 500 }, {});
  await db.pool.query("UPDATE jobs SET payload = '{\"durationMs\": 10, \"record\": true}' WHERE id = $1", [job.id]);
  const done = await waitForStatus(job.id, 'SUCCEEDED', { timeout: 15000 });
  assert.equal(done.attempts, 2);
  assert.deepEqual(await executions(job.id), [1, 2]);
});

test('fencing: a worker that lost its lease cannot overwrite the new attempt', async () => {
  await startScheduler();
  // Worker A never heartbeats in time (simulates a long GC pause / network partition).
  const a = await startWorker({ heartbeatMs: 60000, visibilityTimeoutMs: 60000, reclaimIntervalMs: 60000 });
  const { job } = await jobs.createJob(spec({ payload: { durationMs: 1500, record: true } }));
  await waitForStatus(job.id, 'RUNNING');

  // Worker B considers A's message abandoned after 300ms and takes over.
  await startWorker({ visibilityTimeoutMs: 300 });
  const done = await waitForStatus(job.id, 'SUCCEEDED', { timeout: 15000 });
  await waitFor(() => a.inFlight.size === 0, { message: 'worker A finished' });

  assert.equal(done.attempts, 2);
  assert.deepEqual(done.result, { ok: true, attempt: 2 }, 'result must come from the attempt holding the lease');
  assert.equal((await jobs.getJob(job.id)).result.attempt, 2);
  const stats = await new QueueManager().streamStats();
  assert.equal(stats.reduce((n, s) => n + s.pending, 0), 0);
});

test('duplicate deliveries of the same job execute it once', async () => {
  const { job } = await jobs.createJob(spec({ payload: { durationMs: 200, record: true } }));
  await db.pool.query('DELETE FROM outbox');
  const qm = new QueueManager();
  await qm.ensureGroups();
  // Same job published three times (e.g. relay retried after a failed commit).
  await qm.publish([job, job, job]);
  await startWorker();
  await waitForStatus(job.id, 'SUCCEEDED');
  await sleep(300);
  assert.deepEqual(await executions(job.id), [1]);
});

test('concurrent promoters re-enqueue a due retry exactly once', async () => {
  const qm = new QueueManager();
  await qm.ensureGroups();
  const k = qm.keysFor({ id: 'job-1', queue: 'default', priority: 'normal' });
  await getRedis().zadd(k.delayed, Date.now() - 1, 'job-1');
  await Promise.all(Array.from({ length: 20 }, () => qm.promoteDue(k)));
  assert.equal(await getRedis().xlen(k.stream), 1);
  assert.equal(await getRedis().zcard(k.delayed), 0);
});

test('relay: concurrent schedulers publish each outbox row exactly once', async () => {
  const created = await jobs.createJobs(Array.from({ length: 300 }, () => spec()));
  const schedulers = [0, 1, 2].map(() => new Scheduler({ options: { relayBatchSize: 50 } }));
  await schedulers[0].queue.ensureGroups();
  const drain = async (s) => { while (await s.relayOnce()); };
  await Promise.all(schedulers.map(drain));

  const qm = new QueueManager();
  const ids = [];
  for (const s of qm.streams) {
    for (const [, fields] of await getRedis().xrange(s.stream, '-', '+')) ids.push(fields[1]);
  }
  assert.equal(ids.length, 300);
  assert.equal(new Set(ids).size, 300);
  assert.deepEqual(new Set(ids), new Set(created.map((c) => c.job.id)));
});

test('relay: Redis failure rolls back, nothing is lost', async () => {
  const { job } = await jobs.createJob(spec());
  const s = new Scheduler();
  const original = s.queue.publish.bind(s.queue);
  s.queue.publish = async () => { throw new Error('redis down'); };
  await assert.rejects(s.relayOnce(), /redis down/);
  assert.equal((await jobs.outboxBacklog()).ready, 1, 'outbox row must survive');
  s.queue.publish = original;
  await s.relayOnce();
  assert.equal((await jobs.outboxBacklog()).ready, 0);
  assert.equal((await jobs.getJob(job.id)).status, 'QUEUED');
});

test('cron: three schedulers racing still create one job per tick', async () => {
  await db.pool.query(
    `INSERT INTO cron_schedules (name, cron, type, next_run_at) VALUES ('race', '0 0 * * *', 'demo', now() - interval '1 second')`,
  );
  const schedulers = [0, 1, 2].map(() => new Scheduler());
  await Promise.all(Array.from({ length: 30 }, (_, i) => schedulers[i % 3].cronOnce()));
  const { rows } = await db.pool.query("SELECT count(*)::int AS n FROM jobs WHERE schedule_name = 'race'");
  assert.equal(rows[0].n, 1);
  const s = (await jobs.listSchedules())[0];
  assert.ok(new Date(s.nextRunAt) > new Date(), 'next run moved into the future');
});

test('sweeper recovers jobs Redis lost (data loss / failover)', async () => {
  await startWorker();
  const { job } = await jobs.createJob(spec({ payload: { record: true } }));
  // Simulate: relayed to Redis, then Redis lost the data.
  await db.pool.query('DELETE FROM outbox');
  await db.pool.query("UPDATE jobs SET updated_at = now() - interval '1 hour' WHERE id = $1", [job.id]);

  const s = new Scheduler({ options: { stuckAfterMs: 60000 } });
  await s.sweepOnce();
  await s.relayOnce();
  await waitForStatus(job.id, 'SUCCEEDED');

  // A RUNNING job whose owner vanished is moved back to QUEUED and re-run.
  const { job: j2 } = await jobs.createJob(spec());
  await db.pool.query('DELETE FROM outbox');
  await db.pool.query(
    "UPDATE jobs SET status = 'RUNNING', attempts = 1, updated_at = now() - interval '1 hour' WHERE id = $1",
    [j2.id],
  );
  await s.sweepOnce();
  await s.relayOnce();
  const done = await waitForStatus(j2.id, 'SUCCEEDED');
  assert.equal(done.attempts, 2);
});

test('trim removes acked entries but never undelivered ones', async () => {
  await startScheduler();
  const w = await startWorker();
  const created = await jobs.createJobs(Array.from({ length: 20 }, () => spec({ payload: { durationMs: 1 } })));
  await Promise.all(created.map((c) => waitForStatus(c.job.id, 'SUCCEEDED')));
  await w.stop();

  // 5 more that no worker has read yet.
  const pending = await jobs.createJobs(Array.from({ length: 5 }, () => spec()));
  await waitFor(async () => (await jobs.outboxBacklog()).ready === 0, { message: 'relay' });

  const qm = new QueueManager();
  const before = (await qm.streamStats()).reduce((n, s) => n + s.lag, 0);
  assert.equal(before, 5);
  const trimmed = await qm.trim({ approximate: false });
  assert.ok(trimmed >= 20 - qm.streams.length, `trimmed ${trimmed}`);
  let total = 0;
  for (const s of qm.streams) total += await getRedis().xlen(s.stream);
  // Each stream may keep its last-delivered entry as the boundary.
  assert.ok(total <= 5 + qm.streams.length, `expected only undelivered (+ boundary) entries, got ${total}`);
  assert.equal((await qm.streamStats()).reduce((n, s) => n + s.lag, 0), 5, 'undelivered entries survive');

  await startWorker();
  await Promise.all(pending.map((c) => waitForStatus(c.job.id, 'SUCCEEDED')));
});

test('poison message that crashes every worker ends up DEAD instead of looping forever', async () => {
  const { job } = await jobs.createJob(spec({ maxAttempts: 2 }));
  // Simulate two crashed attempts: attempts already at max and status RUNNING.
  await db.pool.query("UPDATE jobs SET status = 'RUNNING', attempts = 2 WHERE id = $1", [job.id]);
  await db.pool.query('DELETE FROM outbox');
  const qm = new QueueManager();
  await qm.ensureGroups();
  await qm.publish([job]);
  const k = qm.keysFor(job);
  await getRedis().xreadgroup('GROUP', config.group, 'ghost', 'COUNT', 1, 'STREAMS', k.stream, '>');

  await startWorker({ visibilityTimeoutMs: 100 });
  const dead = await waitForStatus(job.id, 'DEAD');
  assert.match(dead.lastError, /Exceeded max attempts/);
});
