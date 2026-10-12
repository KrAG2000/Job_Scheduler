const test = require('node:test');
const assert = require('node:assert/strict');
const {
  core, setup, reset, teardown, sleep, waitFor, waitForStatus, spec, executions,
  fastWorkerOptions, fastSchedulerOptions,
} = require('./helpers');
const handlers = require('../../apps/worker/src/handlers');

const { jobs, Worker, Scheduler, QueueManager, getRedis } = core;

let worker;
let scheduler;
const start = async ({ workerHandlers = handlers, concurrency = 4 } = {}) => {
  scheduler = new Scheduler({ options: fastSchedulerOptions });
  worker = new Worker({ handlers: workerHandlers, concurrency, options: fastWorkerOptions });
  await scheduler.start();
  await worker.start();
};
const stop = async () => {
  await worker?.stop();
  await scheduler?.stop();
  worker = undefined;
  scheduler = undefined;
};

test.before(setup);
test.beforeEach(reset);
test.afterEach(stop);
test.after(teardown);

test('job runs to SUCCEEDED and its message is acked', async () => {
  await start();
  const { job } = await jobs.createJob(spec({ payload: { durationMs: 10, record: true } }));
  const done = await waitForStatus(job.id, 'SUCCEEDED');
  assert.equal(done.attempts, 1);
  assert.deepEqual(done.result, { ok: true, attempt: 1 });
  assert.deepEqual(await executions(job.id), [1]);

  const stats = await new QueueManager().streamStats();
  assert.equal(stats.reduce((n, s) => n + s.pending + s.lag, 0), 0);
});

test('failed attempts retry with backoff until success', async () => {
  await start();
  const { job } = await jobs.createJob(spec({ payload: { durationMs: 1, failTimes: 2 } }));
  const done = await waitForStatus(job.id, 'SUCCEEDED');
  assert.equal(done.attempts, 3);
  assert.match(done.lastError, /attempt 2/);
});

test('retries exhausted -> DEAD + DLQ entry; replay re-runs it', async () => {
  let shouldFail = true;
  await start({
    workerHandlers: {
      flaky: async () => {
        if (shouldFail) throw new Error('boom');
        return 'fixed';
      },
    },
  });
  const { job } = await jobs.createJob(spec({ type: 'flaky', maxAttempts: 3 }));
  const dead = await waitForStatus(job.id, 'DEAD');
  assert.equal(dead.attempts, 3);
  assert.equal(dead.lastError, 'boom');

  const qm = new QueueManager();
  const k = qm.keysFor({ id: job.id, queue: 'default', priority: 'normal' });
  const dlq = await getRedis().xrange(k.dlq, '-', '+');
  assert.equal(dlq.length, 1);
  assert.equal(dlq[0][1][1], job.id);

  shouldFail = false;
  const { replayed } = await jobs.replayJob(job.id);
  assert.equal(replayed, true);
  const done = await waitForStatus(job.id, 'SUCCEEDED');
  assert.equal(done.result, 'fixed');
  assert.equal(done.attempts, 1);
});

test('NonRetryableError dead-letters on the first attempt', async () => {
  await start();
  const { job } = await jobs.createJob(spec({ payload: { fatal: true } }));
  const dead = await waitForStatus(job.id, 'DEAD');
  assert.equal(dead.attempts, 1);
});

test('handler exceeding timeoutMs is aborted and counted as a failure', async () => {
  let aborted = false;
  await start({
    workerHandlers: {
      slow: (job, ctx) => new Promise((resolve) => {
        ctx.signal.addEventListener('abort', () => { aborted = true; });
        setTimeout(resolve, 5000);
      }),
    },
  });
  const { job } = await jobs.createJob(spec({ type: 'slow', timeoutMs: 200, maxAttempts: 1 }));
  const dead = await waitForStatus(job.id, 'DEAD');
  assert.match(dead.lastError, /timed out after 200ms/);
  assert.equal(aborted, true);
});

test('scheduled job does not run before runAt', async () => {
  await start();
  const { job } = await jobs.createJob(spec({ delayMs: 800, payload: { durationMs: 1, record: true } }));
  assert.equal(job.status, 'SCHEDULED');
  await sleep(400);
  assert.equal((await jobs.getJob(job.id)).status, 'SCHEDULED');
  const done = await waitForStatus(job.id, 'SUCCEEDED');
  assert.ok(new Date(done.startedAt) >= new Date(job.runAt));
});

test('same idempotency key returns the original job', async () => {
  const a = await jobs.createJob(spec({ idempotencyKey: 'order-42' }));
  const b = await jobs.createJob(spec({ idempotencyKey: 'order-42' }));
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(a.job.id, b.job.id);
  const { rows } = await core.db.pool.query('SELECT count(*)::int AS n FROM outbox');
  assert.equal(rows[0].n, 1);
});

test('cancelling a scheduled job prevents it from running', async () => {
  await start();
  const { job } = await jobs.createJob(spec({ delayMs: 300, payload: { record: true } }));
  const { cancelled } = await jobs.cancelJob(job.id);
  assert.equal(cancelled, true);
  await sleep(700);
  assert.equal((await jobs.getJob(job.id)).status, 'CANCELLED');
  assert.deepEqual(await executions(job.id), []);
  assert.equal((await jobs.cancelJob(job.id)).cancelled, false);
});

test('cancelling a running job aborts it at the next heartbeat and acks the message', async () => {
  await start();
  const { job } = await jobs.createJob(spec({ payload: { durationMs: 10000 } }));
  await waitForStatus(job.id, 'RUNNING');
  await jobs.cancelJob(job.id);
  await waitFor(() => worker.inFlight.size === 0, { message: 'handler aborted' });
  assert.equal((await jobs.getJob(job.id)).status, 'CANCELLED');
  const stats = await new QueueManager().streamStats();
  assert.equal(stats.reduce((n, s) => n + s.pending, 0), 0);
});

test('high priority lane is drained before normal and low', async () => {
  const order = [];
  scheduler = new Scheduler({ options: fastSchedulerOptions });
  await scheduler.start();
  const created = [];
  for (const priority of ['low', 'normal', 'high', 'low', 'normal', 'high']) {
    created.push((await jobs.createJob(spec({ type: 'rec', priority, payload: { priority } }))).job);
  }
  // Wait until everything is in Redis before any worker starts.
  await waitFor(async () => (await jobs.outboxBacklog()).ready === 0, { message: 'relay' });

  worker = new Worker({
    handlers: { rec: async (job) => { order.push(job.payload.priority); } },
    concurrency: 1,
    options: fastWorkerOptions,
  });
  await worker.start();
  await Promise.all(created.map((j) => waitForStatus(j.id, 'SUCCEEDED')));
  assert.deepEqual(order, ['high', 'high', 'normal', 'normal', 'low', 'low']);
});

test('cron schedule enqueues one job per tick', async () => {
  await start();
  await jobs.upsertSchedule(core.validateSchedule({
    name: 'tick', cron: '* * * * * *', type: 'demo', payload: { durationMs: 1 },
  }));
  await sleep(2600);
  await jobs.deleteSchedule('tick');
  const { rows } = await core.db.pool.query(
    "SELECT idempotency_key FROM jobs WHERE schedule_name = 'tick'",
  );
  assert.ok(rows.length >= 2 && rows.length <= 3, `expected 2-3 runs, got ${rows.length}`);
  assert.equal(new Set(rows.map((r) => r.idempotency_key)).size, rows.length);
});
